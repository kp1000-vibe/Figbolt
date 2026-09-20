import { sql } from 'drizzle-orm';
import { accounts, type SourceRef } from '@/db/schema';
import { getLanguageModel } from '@/lib/ai';
import { s } from '@/lib/ai/providers/structured';
import { scope, type Ctx } from '../context';
import { rawQuery } from '../db-query';
import { search } from '../retrieval/search';
import {
  getEnrichmentProvider,
  type ProspectCandidate,
} from './enrichment';

/**
 * Outbound prospecting.
 *
 * The ICP is *derived from outcomes*, not typed into a form: it comes from the
 * accounts that actually closed, and closed fastest. That makes it a claim the
 * product can defend — "these are your ten fastest-closing enterprise
 * customers, here is what they have in common" — rather than an assertion
 * someone made in a planning meeting a year ago.
 *
 * Candidate generation is behind a provider interface (`./enrichment`) with a
 * fixture adapter, so this works with no external data vendor and swaps to
 * Apollo / Clay / People Data Labs by implementing one interface.
 */

export type IcpProfile = {
  basedOn: { accountId: string; name: string; value: number; cycleDays: number }[];
  industries: { value: string; count: number }[];
  employeeRange: { min: number; median: number; max: number } | null;
  averageDealValue: number;
  averageCycleDays: number;
  tiers: { value: string; count: number }[];
  countries: { value: string; count: number }[];
  /** Themes those customers raised — what they were actually buying for. */
  commonThemes: string[];
  /** Prose description the model wrote from the above, for the outreach angle. */
  narrative: string;
  evidence: SourceRef[];
  sampleSize: number;
};

/**
 * Derive the ICP from won deals.
 *
 * Ordered by cycle length rather than value: the fastest closes are the ones
 * where the fit was obvious, which is precisely what a lookalike search should
 * target.
 */
export async function deriveIcp(ctx: Ctx, limit = 10): Promise<IcpProfile | null> {
  const won = await rawQuery<{
    account_id: string;
    name: string;
    industry: string | null;
    employee_count: number | null;
    tier: string | null;
    country: string | null;
    value: number;
    cycle_days: number;
  }>(
    ctx,
    sql`
      SELECT a.id AS account_id, a.name, a.industry, a.employee_count, a.tier, a.country,
             o.value::float8 AS value,
             GREATEST(EXTRACT(EPOCH FROM (o.closed_at - o.created_at)) / 86400, 1)::int AS cycle_days
      FROM opportunities o
      JOIN accounts a ON a.id = o.account_id
      WHERE o.workspace_id = ${ctx.workspaceId}
        AND o.deleted_at IS NULL
        AND o.status = 'won'
        AND o.closed_at IS NOT NULL
      ORDER BY cycle_days ASC, o.value DESC
      LIMIT ${limit}
    `,
  );

  // Below three won deals there is no pattern, only noise. Say so rather than
  // producing a confident-looking profile from two data points.
  if (won.length < 3) return null;

  const industries = tally(won.map((w) => w.industry).filter((x): x is string => Boolean(x)));
  const tiers = tally(won.map((w) => w.tier).filter((x): x is string => Boolean(x)));
  const countries = tally(won.map((w) => w.country).filter((x): x is string => Boolean(x)));

  const employeeCounts = won
    .map((w) => w.employee_count)
    .filter((x): x is number => typeof x === 'number' && x > 0)
    .sort((a, b) => a - b);

  const averageDealValue = Math.round(won.reduce((s, w) => s + Number(w.value), 0) / won.length);
  const averageCycleDays = Math.round(won.reduce((s, w) => s + w.cycle_days, 0) / won.length);

  // What those specific customers talked about — the buying reason, not the
  // firmographics.
  const themes = await rawQuery<{ name: string; n: number }>(
    ctx,
    sql`
      SELECT COALESCE(t.name, ps.title) AS name, count(*)::int AS n
      FROM product_signals ps
      LEFT JOIN product_signal_themes t ON t.id = ps.theme_id
      WHERE ps.workspace_id = ${ctx.workspaceId}
        AND ps.deleted_at IS NULL
        AND ps.account_id = ANY(${sql.raw(`ARRAY[${won.map((w) => `'${w.account_id}'`).join(',')}]::text[]`)})
      GROUP BY 1 ORDER BY 2 DESC LIMIT 6
    `,
  ).catch(() => [] as { name: string; n: number }[]);

  const evidence = await search(ctx, {
    query: `${won.map((w) => w.name).join(' ')} why they bought goals`,
    scopes: ['transcripts', 'meetings', 'notes'],
    limit: 8,
  });

  const model = getLanguageModel();
  const result = await model
    .completeStructured<{ narrative: string }>({
      system:
        'You describe an ideal customer profile from closed-won evidence. Be concrete and short. Never invent a characteristic the data does not show.',
      instruction: [
        `sampleSize: ${won.length}`,
        `industries: ${industries.map((i) => `${i.value} (${i.count})`).join(', ')}`,
        `employeeRange: ${employeeCounts[0] ?? '?'}–${employeeCounts.at(-1) ?? '?'}`,
        `averageDealValue: $${averageDealValue.toLocaleString()}`,
        `averageCycleDays: ${averageCycleDays}`,
        `commonThemes: ${themes.map((t) => t.name).join(', ')}`,
        '',
        'In two or three sentences, describe what these customers have in common and why they bought.',
      ].join('\n'),
      schema: s.object(
        { narrative: s.string('Two or three sentences.'), confidence: s.number('0-1.') },
        ['narrative', 'confidence'],
      ),
      task: 'build_icp',
      evidence,
    })
    .catch(() => ({ value: { narrative: '' }, usage: { promptTokens: 0, completionTokens: 0 }, model: 'none', confidence: 0 }));

  const narrative =
    result.value.narrative ||
    [
      `Your ${won.length} fastest closes average $${averageDealValue.toLocaleString()} and ${averageCycleDays} days.`,
      industries[0] ? `${industries[0].value} is the most common industry (${industries[0].count} of ${won.length}).` : '',
      employeeCounts.length > 0
        ? `Headcount ranges ${employeeCounts[0]!.toLocaleString()}–${employeeCounts.at(-1)!.toLocaleString()}.`
        : '',
      themes.length > 0 ? `They most often asked about ${themes.slice(0, 3).map((t) => t.name).join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ');

  return {
    basedOn: won.map((w) => ({
      accountId: w.account_id,
      name: w.name,
      value: Number(w.value),
      cycleDays: w.cycle_days,
    })),
    industries,
    employeeRange:
      employeeCounts.length > 0
        ? {
            min: employeeCounts[0]!,
            median: employeeCounts[Math.floor(employeeCounts.length / 2)]!,
            max: employeeCounts.at(-1)!,
          }
        : null,
    averageDealValue,
    averageCycleDays,
    tiers,
    countries,
    commonThemes: themes.map((t) => t.name),
    narrative,
    evidence: [
      ...won.slice(0, 5).map((w) => ({
        type: 'account' as const,
        id: w.account_id,
        label: `${w.name} — closed in ${w.cycle_days}d`,
      })),
      ...evidence.slice(0, 4).map((e) => e.ref),
    ],
    sampleSize: won.length,
  };
}

/* ── Candidate scoring ────────────────────────────────────────────────────── */

export type ScoredProspect = ProspectCandidate & {
  score: number;
  factors: { label: string; detail: string; weight: number }[];
  whyThisAccount: string;
  /** The prose hook used in the drafts. */
  angle: string;
  /** A few words naming that hook, for a badge. */
  angleLabel: string;
  emailDraft: { subject: string; body: string };
  linkedinDraft: string;
  alreadyInCrm: boolean;
};

/**
 * Score candidates against the derived ICP.
 *
 * Deterministic and fully exposed, for the same reason deal health is: a rep
 * deciding who to call needs to know *why* a name is at the top, and a score
 * they cannot interrogate gets ignored.
 */
export async function findLookalikes(
  ctx: Ctx,
  icp: IcpProfile,
  options: { limit?: number; query?: string } = {},
): Promise<ScoredProspect[]> {
  const provider = getEnrichmentProvider();

  const candidates = await provider.findSimilar({
    industries: icp.industries.map((i) => i.value),
    employeeMin: icp.employeeRange ? Math.round(icp.employeeRange.min * 0.6) : undefined,
    employeeMax: icp.employeeRange ? Math.round(icp.employeeRange.max * 1.6) : undefined,
    countries: icp.countries.map((c) => c.value),
    themes: icp.commonThemes,
    query: options.query,
    limit: (options.limit ?? 12) * 2,
  });

  // Never present an account we already work with as a new prospect.
  const existing = await ctx.db
    .select({ domain: accounts.domain, name: accounts.name })
    .from(accounts)
    .where(scope(ctx, accounts));

  const knownDomains = new Set(
    existing.map((a) => a.domain?.toLowerCase()).filter((x): x is string => Boolean(x)),
  );
  const knownNames = new Set(existing.map((a) => a.name.toLowerCase()));

  const scored = candidates.map((candidate) => {
    const factors: ScoredProspect['factors'] = [];

    const industryMatch = icp.industries.find(
      (i) => i.value.toLowerCase() === candidate.industry?.toLowerCase(),
    );
    if (industryMatch) {
      factors.push({
        label: 'Industry match',
        detail: `${candidate.industry} — ${industryMatch.count} of your ${icp.sampleSize} fastest closes`,
        weight: 22,
      });
    }

    if (icp.employeeRange && candidate.employeeCount) {
      const { min, max } = icp.employeeRange;
      if (candidate.employeeCount >= min && candidate.employeeCount <= max) {
        factors.push({
          label: 'Headcount in range',
          detail: `${candidate.employeeCount.toLocaleString()} employees, inside your ${min.toLocaleString()}–${max.toLocaleString()} band`,
          weight: 18,
        });
      } else {
        const distance = candidate.employeeCount < min ? min / candidate.employeeCount : candidate.employeeCount / max;
        factors.push({
          label: 'Headcount outside range',
          detail: `${candidate.employeeCount.toLocaleString()} employees`,
          weight: distance > 3 ? -14 : -6,
        });
      }
    }

    if (candidate.country && icp.countries.some((c) => c.value === candidate.country)) {
      factors.push({ label: 'Same geography', detail: candidate.country, weight: 8 });
    }

    const themeHits = candidate.technologies.filter((tech) =>
      icp.commonThemes.some((theme) => overlapWords(theme, tech)),
    );
    if (themeHits.length > 0) {
      factors.push({
        label: 'Technology overlap',
        detail: `Runs ${themeHits.slice(0, 3).join(', ')} — the same stack your customers integrate with`,
        weight: 10 * Math.min(themeHits.length, 2),
      });
    }

    if (candidate.growthSignal) {
      factors.push({ label: 'Growth signal', detail: candidate.growthSignal, weight: 12 });
    }
    if (candidate.intentSignal) {
      factors.push({ label: 'Intent signal', detail: candidate.intentSignal, weight: 16 });
    }
    if (candidate.warmPath) {
      factors.push({
        label: 'Warm path in',
        detail: candidate.warmPath,
        weight: 20,
      });
    }

    // Rank-decayed, for the same reason deal health is: these factors are
    // correlated — a company in the right industry is usually also in the right
    // size band and the right country — so summing them linearly pins every
    // decent candidate at 100 and the ranking stops meaning anything.
    const decayed = applyDecay(factors);
    const raw = 40 + decayed.reduce((sum, f) => sum + f.weight, 0);
    const score = Math.max(0, Math.min(100, Math.round(raw)));

    const alreadyInCrm =
      (candidate.domain ? knownDomains.has(candidate.domain.toLowerCase()) : false) ||
      knownNames.has(candidate.name.toLowerCase());

    const positives = factors.filter((f) => f.weight > 0);
    const whyThisAccount =
      positives.length > 0
        ? `${positives.map((f) => f.detail).slice(0, 3).join('. ')}.`
        : 'Matches your target profile only loosely — worth a look but not a priority.';

    const angle = pickAngle(candidate, icp);

    return {
      ...candidate,
      score,
      // The displayed weights are the decayed ones, so the arithmetic a user
      // checks actually adds up to the score they were shown.
      factors: decayed,
      whyThisAccount,
      angle,
      angleLabel: labelForAngle(candidate, icp),
      emailDraft: draftEmail(candidate, icp, angle),
      linkedinDraft: draftLinkedin(candidate, angle),
      alreadyInCrm,
    };
  });

  return scored
    .filter((c) => !c.alreadyInCrm)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 12);
}

const DECAY = [1, 0.8, 0.65, 0.5, 0.4, 0.3, 0.25, 0.2];

function applyDecay(factors: ScoredProspect['factors']): ScoredProspect['factors'] {
  return [...factors]
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .map((factor, index) => ({
      ...factor,
      weight: Math.round(factor.weight * (DECAY[index] ?? 0.15)),
    }))
    .filter((factor) => factor.weight !== 0);
}

/** Two or three words naming the hook, for the card badge. */
function labelForAngle(candidate: ProspectCandidate, icp: IcpProfile): string {
  if (candidate.warmPath) return 'Warm intro available';
  if (candidate.intentSignal) return 'Actively looking';
  if (candidate.growthSignal) return 'Growing fast';
  if (icp.industries.some((i) => i.value === candidate.industry)) return 'Industry lookalike';
  return 'Profile match';
}

/** Pick the outreach angle from the strongest available signal. */
function pickAngle(candidate: ProspectCandidate, icp: IcpProfile): string {
  if (candidate.intentSignal) return candidate.intentSignal;
  if (candidate.growthSignal) return candidate.growthSignal;

  const theme = icp.commonThemes[0];
  if (theme && candidate.technologies.length > 0) {
    return `Runs ${candidate.technologies[0]}, and customers on that stack come to us for ${theme.toLowerCase()}`;
  }
  if (candidate.industry) {
    const match = icp.industries.find((i) => i.value === candidate.industry);
    if (match) return `${candidate.industry} peers are among our fastest implementations`;
  }
  return 'Profile matches the customers who see value fastest';
}

/**
 * Draft outreach.
 *
 * Written from the scoring factors so the opening line references something
 * real about the company. Generic outbound is worse than none, and a draft a
 * rep has to rewrite entirely has not saved them anything.
 */
function draftEmail(
  candidate: ProspectCandidate,
  icp: IcpProfile,
  angle: string,
): { subject: string; body: string } {
  const first = candidate.contacts[0];
  const name = first?.firstName ?? 'there';
  const peer = icp.basedOn[0]?.name;

  return {
    subject: candidate.industry
      ? `${candidate.name} + ops workflows`
      : `A question about how ${candidate.name} handles exceptions`,
    body: [
      `Hi ${name},`,
      '',
      `${angle}.`,
      '',
      peer
        ? `We work with ${peer} and similar teams, where the problem was usually the same: exceptions start as an email, nobody owns them, and there is no audit trail when someone asks what happened.`
        : 'The pattern we usually find is that exceptions start as an email, nobody owns them, and there is no audit trail when someone asks what happened.',
      '',
      first?.title
        ? `Given you look after ${first.title.toLowerCase()}, is that a problem you recognise — or have you already solved it?`
        : 'Is that a problem you recognise, or have you already solved it?',
      '',
      'Happy to be told it is not relevant.',
    ].join('\n'),
  };
}

function draftLinkedin(candidate: ProspectCandidate, angle: string): string {
  const first = candidate.contacts[0];
  return [
    `Hi ${first?.firstName ?? 'there'} — ${angle.charAt(0).toLowerCase()}${angle.slice(1)}.`,
    '',
    `Curious how ${candidate.name} handles operational exceptions today: is it a proper workflow, or still email and a spreadsheet?`,
    '',
    'No pitch — genuinely interested in whether it is a problem for you.',
  ].join('\n');
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function tally(values: string[]): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

function overlapWords(a: string, b: string): boolean {
  const wordsA = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const wordsB = b.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return wordsB.some((w) => wordsA.has(w));
}
