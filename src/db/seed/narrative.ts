import type { Scenario, SeedAccount, SeedContact, SeedUser } from './fixtures';

/**
 * Conversation generation.
 *
 * The extraction pipeline is only as interesting as what it has to read, so
 * these are written as real sales conversations rather than lorem ipsum:
 * people hedge, raise objections mid-sentence, promise things with vague
 * deadlines, and mention competitors in passing. That is deliberate — it is
 * what the commitment, objection and signal extractors have to cope with in
 * production, and seeding clean text would hide every weakness.
 *
 * A seeded PRNG keeps the demo workspace identical between runs, so
 * screenshots, tests and docs stay valid.
 */

export function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    // xorshift32 — small, fast, and stable across Node versions.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

export type Rand = ReturnType<typeof makeRandom>;

export function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] ?? items[0]!;
}

export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

export type SeedEmail = {
  direction: 'inbound' | 'outbound';
  subject: string;
  body: string;
  daysAgo: number;
  fromContactIndex?: number;
  threadKey: string;
};

export type SeedTranscriptLine = {
  speaker: string;
  isCustomer: boolean;
  text: string;
};

export type SeedMeeting = {
  title: string;
  daysAgo: number;
  durationMinutes: number;
  contactIndexes: number[];
  lines: SeedTranscriptLine[];
};

/* ── Meetings ─────────────────────────────────────────────────────────────── */

export function buildMeetings(
  account: SeedAccount,
  owner: SeedUser,
  se: SeedUser,
  rand: Rand,
): SeedMeeting[] {
  const c = account.contacts;
  const champion = c[0]!;
  const first = (x: SeedContact) => x.firstName;
  const meetings: SeedMeeting[] = [];
  const createdDaysAgo = account.deal?.createdDaysAgo ?? 30;

  /* Discovery — every account that got past a first conversation. */
  if (createdDaysAgo >= 8) {
    meetings.push({
      title: `${account.name} — Discovery`,
      daysAgo: createdDaysAgo - 2,
      durationMinutes: 45,
      contactIndexes: [0],
      lines: discoveryLines(account, owner, champion, rand),
    });
  }

  switch (account.scenario) {
    case 'enterprise_security': {
      const security = c.find((x) => x.department === 'Security') ?? c[c.length - 1]!;
      const technical = c.find((x) => x.buyingRole === 'technical_evaluator') ?? c[1]!;

      meetings.push({
        title: `${account.name} — Technical Deep Dive`,
        daysAgo: Math.max(6, Math.round(createdDaysAgo * 0.55)),
        durationMinutes: 60,
        contactIndexes: [0, Math.max(1, c.indexOf(technical))],
        lines: technicalLines(account, owner, se, champion, technical, rand),
      });

      meetings.push({
        title: `${account.name} — Security Review Kickoff`,
        daysAgo: Math.max(4, Math.round(createdDaysAgo * 0.25)),
        durationMinutes: 45,
        contactIndexes: [0, Math.max(1, c.indexOf(security))],
        lines: securityLines(account, owner, se, champion, security, rand),
      });
      break;
    }

    case 'exec_engaged_fast': {
      const exec = c.find((x) => x.seniority === 'c_level' || x.seniority === 'vp') ?? c[0]!;
      meetings.push({
        title: `${account.name} — Executive Alignment`,
        daysAgo: Math.max(5, Math.round(createdDaysAgo * 0.5)),
        durationMinutes: 30,
        contactIndexes: [c.indexOf(exec)],
        lines: execLines(account, owner, exec, rand),
      });
      break;
    }

    case 'integration_ask':
      meetings.push({
        title: `${account.name} — Workflow Walkthrough`,
        daysAgo: Math.max(4, Math.round(createdDaysAgo * 0.45)),
        durationMinutes: 45,
        contactIndexes: c.map((_, i) => i).slice(0, 2),
        lines: integrationLines(account, owner, se, champion, rand),
      });
      break;

    case 'pricing_pushback':
    case 'stalled_after_pricing':
      meetings.push({
        title: `${account.name} — Pricing Discussion`,
        daysAgo: account.scenario === 'stalled_after_pricing'
          ? Math.max(18, Math.round(createdDaysAgo * 0.35))
          : Math.max(5, Math.round(createdDaysAgo * 0.3)),
        durationMinutes: 40,
        contactIndexes: c.map((_, i) => i).slice(0, 2),
        lines: pricingLines(account, owner, champion, c[1] ?? champion, rand),
      });
      break;

    case 'competitive_bakeoff':
      meetings.push({
        title: `${account.name} — Vendor Evaluation`,
        daysAgo: Math.max(5, Math.round(createdDaysAgo * 0.4)),
        durationMinutes: 50,
        contactIndexes: c.map((_, i) => i).slice(0, 2),
        lines: competitiveLines(account, owner, se, champion, rand),
      });
      break;

    case 'expansion':
      meetings.push({
        title: `${account.name} — Expansion Scoping`,
        daysAgo: Math.max(4, Math.round(createdDaysAgo * 0.4)),
        durationMinutes: 40,
        contactIndexes: c.map((_, i) => i).slice(0, 2),
        lines: expansionLines(account, owner, champion, c[1] ?? champion, rand),
      });
      break;

    case 'lost_to_competitor':
    case 'lost_to_budget':
      meetings.push({
        title: `${account.name} — Decision Debrief`,
        daysAgo: Math.abs(account.deal?.closeInDays ?? 60) + 2,
        durationMinutes: 20,
        contactIndexes: [0],
        lines: lossLines(account, owner, champion, rand),
      });
      break;

    case 'happy_customer':
      meetings.push({
        title: `${account.name} — Quarterly Business Review`,
        daysAgo: 24,
        durationMinutes: 45,
        contactIndexes: [0],
        lines: qbrLines(account, owner, champion, rand),
      });
      break;

    default:
      break;
  }

  return meetings;
}

/* ── Transcript writers ───────────────────────────────────────────────────── */

const PAIN_BY_INDUSTRY: Record<string, string> = {
  Manufacturing: 'a quality hold gets raised on the floor and it takes half a day to work out who has to sign off',
  Healthcare: 'a supply exception comes in and three different people end up chasing the same thing',
  'Financial Services': 'an exception hits the servicing queue and nobody can tell you where it is without opening four systems',
  Logistics: 'a load falls out of plan and the exception sits in somebody\'s inbox for six hours',
  SaaS: 'an onboarding handoff goes sideways and nobody notices until the customer complains',
  Retail: 'a store raises a replenishment exception and it bounces between district and corporate',
  Energy: 'a field escalation comes in overnight and the routing depends on who happens to be awake',
  Media: 'a delivery gets held in post and the approval chain is entirely in email',
  Services: 'a franchise raises a dispatch exception and every location does it slightly differently',
  'Real Estate': 'a maintenance escalation comes in and the approval path depends on the property',
  'Public Sector': 'a permit exception needs three sign-offs and the file moves as a PDF attachment',
  Construction: 'a change order needs approval and the paperwork lives in somebody\'s truck',
  Education: 'an enrolment exception needs a registrar decision and it sits for days',
  Telecommunications: 'a provisioning order fails and the fallout process is entirely manual',
  Mining: 'a safety incident gets logged on paper and the follow-up depends on someone remembering',
};

function pain(account: SeedAccount): string {
  return PAIN_BY_INDUSTRY[account.industry] ?? 'an exception comes in and the process falls back to email';
}

function discoveryLines(
  account: SeedAccount,
  owner: SeedUser,
  champion: SeedContact,
  rand: Rand,
): SeedTranscriptLine[] {
  const them = champion.firstName;
  const hours = 12 + Math.floor(rand() * 25);
  const people = 4 + Math.floor(rand() * 9);

  return [
    { speaker: owner.name, isCustomer: false, text: `Thanks for the time ${them}. Rather than me walking through slides, could you take me through what actually happens today when ${pain(account)}?` },
    { speaker: champion.firstName + ' ' + champion.lastName, isCustomer: true, text: `Sure. So today it starts as an email, usually to a shared mailbox. Somebody picks it up, works out who owns it, and then it becomes a thread. If that person is out, it just sits there.` },
    { speaker: champion.firstName + ' ' + champion.lastName, isCustomer: true, text: `The honest answer is we have no idea how many are open at any given moment. That's the part that keeps me up — not the volume, the invisibility.` },
    { speaker: owner.name, isCustomer: false, text: `How many of these are you handling in a week, roughly?` },
    { speaker: champion.firstName + ' ' + champion.lastName, isCustomer: true, text: `Between ${people * 8} and ${people * 14}. Across about ${people} people. Each one takes maybe forty minutes end to end, and honestly most of that is chasing rather than deciding.` },
    { speaker: champion.firstName + ' ' + champion.lastName, isCustomer: true, text: `We reckon it's costing us around ${hours} hours a week of pure coordination. That's a person and a half doing nothing but forwarding emails.` },
    { speaker: owner.name, isCustomer: false, text: `What have you already tried?` },
    { speaker: champion.firstName + ' ' + champion.lastName, isCustomer: true, text: `We built something internally on a shared spreadsheet with some scripts. It worked for about four months and then it broke and the person who built it had moved teams. Classic.` },
    { speaker: owner.name, isCustomer: false, text: `And why now? What changes if you do nothing for another six months?` },
    { speaker: champion.firstName + ' ' + champion.lastName, isCustomer: true, text: `We have an audit coming and we cannot show an audit trail for any of this. That's the forcing function. We want to reduce the manual chasing but the real driver is being able to prove what happened.` },
    { speaker: owner.name, isCustomer: false, text: `That's helpful. I'll put together a short walkthrough tailored to that exception flow and send it over this week.` },
    { speaker: champion.firstName + ' ' + champion.lastName, isCustomer: true, text: `That would be great. I'll pull together our current process map and share it with you before then.` },
    { speaker: owner.name, isCustomer: false, text: `Perfect. One more thing — if this goes forward, who owns the budget for it?` },
    { speaker: champion.firstName + ' ' + champion.lastName, isCustomer: true, text: `That would go through my VP, and above a certain number it needs finance. I'd rather get comfortable myself first before I bring them in.` },
  ];
}

function technicalLines(
  account: SeedAccount,
  owner: SeedUser,
  se: SeedUser,
  champion: SeedContact,
  technical: SeedContact,
  rand: Rand,
): SeedTranscriptLine[] {
  const tech = `${technical.firstName} ${technical.lastName}`;
  const champ = `${champion.firstName} ${champion.lastName}`;
  const seats = [180, 250, 320, 450, 600][Math.floor(rand() * 5)]!;

  return [
    { speaker: owner.name, isCustomer: false, text: `${technical.firstName}, thanks for joining. ${se.name} is here to go through the technical side properly.` },
    { speaker: tech, isCustomer: true, text: `Good. I've had a look at the docs. The workflow engine looks fine — my questions are all about identity and data.` },
    { speaker: tech, isCustomer: true, text: `First one: we need SSO with our identity provider. Single sign-on is a hard requirement — we don't onboard any tool without it, and provisioning has to be automated too.` },
    { speaker: se.name, isCustomer: false, text: `That's supported. SAML 2.0 with any compliant provider, and SCIM for provisioning and deprovisioning. Both are included on Enterprise.` },
    { speaker: tech, isCustomer: true, text: `Good. Because without single sign-on this is a blocker for us — I couldn't take it to the architecture review.` },
    { speaker: tech, isCustomer: true, text: `Second thing. We'd want an audit log we can export. Our compliance team will ask, and "you can see it in the UI" won't survive that conversation.` },
    { speaker: se.name, isCustomer: false, text: `Audit log is on by default and exportable through the API. Every run, every decision, every data change.` },
    { speaker: champ, isCustomer: true, text: `That's the bit I care about most, honestly. That's the audit story.` },
    { speaker: tech, isCustomer: true, text: `What about scale? We'd be looking at around ${seats} users in the first phase, more later.` },
    { speaker: se.name, isCustomer: false, text: `That's comfortably within normal range. Our largest deployments are an order of magnitude above that.` },
    { speaker: tech, isCustomer: true, text: `One more — does it integrate with Salesforce? A lot of our downstream reporting hangs off it and I don't want another island of data.` },
    { speaker: se.name, isCustomer: false, text: `Native Salesforce is on the roadmap. Today you'd connect it through the REST API or a middleware layer, and I'd want to be straight with you: I can't give you a committed date for the native connector.` },
    { speaker: tech, isCustomer: true, text: `Appreciated. Not a dealbreaker, but note it down — we'd want it eventually.` },
    { speaker: owner.name, isCustomer: false, text: `Noted. ${se.name}, can you write up the architecture summary and the SSO configuration guide for ${technical.firstName}?` },
    { speaker: se.name, isCustomer: false, text: `Yes — I'll send the architecture overview and SSO setup docs by end of week.` },
    { speaker: tech, isCustomer: true, text: `Great. I'll take it to our architecture review next week and come back to you.` },
  ];
}

function securityLines(
  account: SeedAccount,
  owner: SeedUser,
  se: SeedUser,
  champion: SeedContact,
  security: SeedContact,
  rand: Rand,
): SeedTranscriptLine[] {
  const sec = `${security.firstName} ${security.lastName}`;
  const champ = `${champion.firstName} ${champion.lastName}`;
  const weeks = 2 + Math.floor(rand() * 3);

  return [
    { speaker: owner.name, isCustomer: false, text: `${security.firstName}, thanks for making time. The goal today is just to understand your review process so we don't slow you down.` },
    { speaker: sec, isCustomer: true, text: `Straightforward from my side. I need your SOC 2 Type II report, a completed security questionnaire, your pen test summary, and your subprocessor list.` },
    { speaker: sec, isCustomer: true, text: `And I'll be blunt — our security team needs SOC 2 Type II documentation before procurement can even open a file. That's a hard requirement, not a preference.` },
    { speaker: se.name, isCustomer: false, text: `We have SOC 2 Type II, renewed annually. I can share the report under NDA along with the pen test executive summary.` },
    { speaker: sec, isCustomer: true, text: `Good. How is data encrypted at rest, and where does it physically live?` },
    { speaker: se.name, isCustomer: false, text: `AES-256 at rest, TLS 1.3 in transit, and we offer EU data residency on Enterprise if that matters for you.` },
    { speaker: sec, isCustomer: true, text: `US is fine for us. What about SSO — I won't approve a tool that has its own password store.` },
    { speaker: se.name, isCustomer: false, text: `SAML SSO with your provider, plus SCIM provisioning. No local passwords for enterprise workspaces.` },
    { speaker: sec, isCustomer: true, text: `That helps. Realistically my review takes about ${weeks} weeks once I have everything, assuming nothing surprising comes back.` },
    { speaker: champ, isCustomer: true, text: `${security.firstName}, is there anything that would make that faster? We're trying to land this in the quarter.` },
    { speaker: sec, isCustomer: true, text: `Getting the questionnaire and the SOC 2 in the same week. What kills my timeline is chasing documents one at a time.` },
    { speaker: owner.name, isCustomer: false, text: `Understood. I'll send the security questionnaire and our SOC 2 report by Friday.` },
    { speaker: sec, isCustomer: true, text: `If it lands Friday I can start Monday.` },
    { speaker: champ, isCustomer: true, text: `And I'll get the NDA moving on our side this week so nothing waits on paperwork.` },
    { speaker: owner.name, isCustomer: false, text: `Perfect. ${se.name} will also share the SSO configuration guide so your team can plan the identity work in parallel.` },
  ];
}

function execLines(
  account: SeedAccount,
  owner: SeedUser,
  exec: SeedContact,
  rand: Rand,
): SeedTranscriptLine[] {
  const name = `${exec.firstName} ${exec.lastName}`;
  const hours = 900 + Math.floor(rand() * 800);

  return [
    { speaker: owner.name, isCustomer: false, text: `${exec.firstName}, I know you have twenty minutes so I'll be direct. Your team has validated the fit. What I need from you is whether this is worth doing now.` },
    { speaker: name, isCustomer: true, text: `Give me the number. What does this actually save us?` },
    { speaker: owner.name, isCustomer: false, text: `Based on what your team walked us through, roughly ${hours} hours a year of coordination across the group, and an audit trail you currently can't produce.` },
    { speaker: name, isCustomer: true, text: `The audit trail is the part I care about. We had a finding last year that came down to not being able to show who approved what. That cost us more in remediation than this contract is worth.` },
    { speaker: name, isCustomer: true, text: `I'm comfortable with the direction. Our goal is to be live before the next audit cycle, which means we need to start in the next six weeks.` },
    { speaker: owner.name, isCustomer: false, text: `That's achievable. Typical implementation is four to six weeks and most of it is process mapping with your team, not technical work.` },
    { speaker: name, isCustomer: true, text: `Then let's move. I'll approve the budget on my side — I have discretion up to this level, so we don't need to involve the board.` },
    { speaker: name, isCustomer: true, text: `I will need our legal team to look at the agreement. I'll ask them to prioritise it this week.` },
    { speaker: owner.name, isCustomer: false, text: `I'll send the agreement and the implementation plan today so legal and your ops lead can work in parallel.` },
    { speaker: name, isCustomer: true, text: `Good. One condition — I want a named person on your side through implementation. I don't want to be handed to a queue after signature.` },
    { speaker: owner.name, isCustomer: false, text: `That's included at this tier. You'll have a named customer success manager from day one.` },
  ];
}

function integrationLines(
  account: SeedAccount,
  owner: SeedUser,
  se: SeedUser,
  champion: SeedContact,
  rand: Rand,
): SeedTranscriptLine[] {
  const champ = `${champion.firstName} ${champion.lastName}`;
  const second = account.contacts[1];
  const secondName = second ? `${second.firstName} ${second.lastName}` : champ;

  return [
    { speaker: owner.name, isCustomer: false, text: `Let's walk the actual flow end to end and see where it breaks.` },
    { speaker: champ, isCustomer: true, text: `The workflow itself looks right. My concern is that it becomes another system nobody looks at.` },
    { speaker: champ, isCustomer: true, text: `We need this to integrate with Salesforce. That's where our team lives all day — if they have to context switch into another tool to action something, adoption dies.` },
    { speaker: se.name, isCustomer: false, text: `Understood. Today that's the REST API plus notifications into Slack, which is where most teams action things. Native Salesforce sync is on the roadmap but I can't commit a date.` },
    { speaker: secondName, isCustomer: true, text: `Would we be able to trigger a workflow from a Salesforce record without writing code? That's really the question.` },
    { speaker: se.name, isCustomer: false, text: `Not natively today. With a middleware step, yes. I'd rather tell you that plainly than have you find out in implementation.` },
    { speaker: champ, isCustomer: true, text: `I appreciate the honesty. Put us down as wanting the Salesforce integration — when it ships we'd use it on day one.` },
    { speaker: champ, isCustomer: true, text: `The Slack piece matters too. If approvals can happen in Slack, that solves eighty percent of my adoption worry.` },
    { speaker: se.name, isCustomer: false, text: `Slack is live today, including approve and reject inline.` },
    { speaker: secondName, isCustomer: true, text: `That's better than I expected. What about reporting — can we get this into our warehouse?` },
    { speaker: se.name, isCustomer: false, text: `Snowflake export is supported, plus the API for anything custom.` },
    { speaker: owner.name, isCustomer: false, text: `I'll send over the integration documentation and a scoped proposal by early next week.` },
    { speaker: champ, isCustomer: true, text: `Great. I'll share it with my team and get you feedback within the week.` },
  ];
}

function pricingLines(
  account: SeedAccount,
  owner: SeedUser,
  champion: SeedContact,
  finance: SeedContact,
  rand: Rand,
): SeedTranscriptLine[] {
  const champ = `${champion.firstName} ${champion.lastName}`;
  const fin = `${finance.firstName} ${finance.lastName}`;
  const value = account.deal?.value ?? 100_000;
  const seats = Math.round(account.employeeCount * 0.12);
  const budget = Math.round((value * (0.6 + rand() * 0.25)) / 1000) * 1000;

  return [
    { speaker: owner.name, isCustomer: false, text: `I've shared the proposal ahead of this. Let's talk through it honestly rather than me presenting at you.` },
    { speaker: fin, isCustomer: true, text: `The functionality isn't in question. The number is. At ${seats} seats, per-seat pricing gets expensive very quickly.` },
    { speaker: fin, isCustomer: true, text: `Frankly at that number it's out of our budget for this fiscal year. We have about $${budget.toLocaleString()} approved for this category.` },
    { speaker: champ, isCustomer: true, text: `And to be fair, not everyone who touches this needs a full seat. A lot of our people just approve one thing a month.` },
    { speaker: owner.name, isCustomer: false, text: `That's a fair challenge, and it's a common one at your headcount. There are two shapes that usually work: banded seat pricing above a thousand seats, or a platform licence priced on the workflows rather than the headcount.` },
    { speaker: fin, isCustomer: true, text: `The platform licence sounds more like what we need. Can you come back with that?` },
    { speaker: owner.name, isCustomer: false, text: `I can. It needs sign-off on my side, so let me take it to our CRO and come back with something concrete.` },
    { speaker: champ, isCustomer: true, text: `That would help a lot. I don't want to lose this over a pricing model when the fit is right.` },
    { speaker: fin, isCustomer: true, text: `I should also say we're comparing this against doing nothing for another year. That's the real alternative, not another vendor.` },
    { speaker: owner.name, isCustomer: false, text: `Understood. I'll put together a revised commercial proposal and send it over within a few days.` },
    { speaker: champ, isCustomer: true, text: `I'll socialise it internally once it lands. Our timeline is to have something agreed before end of quarter.` },
  ];
}

function competitiveLines(
  account: SeedAccount,
  owner: SeedUser,
  se: SeedUser,
  champion: SeedContact,
  rand: Rand,
): SeedTranscriptLine[] {
  const champ = `${champion.firstName} ${champion.lastName}`;
  const second = account.contacts[1];
  const secondName = second ? `${second.firstName} ${second.lastName}` : champ;

  return [
    { speaker: champ, isCustomer: true, text: `I'll be upfront — we're also evaluating Vantage Systems and one other. This is a formal process and we'll be comparing you side by side.` },
    { speaker: owner.name, isCustomer: false, text: `That's fair, and Vantage is a serious product. Can I ask what's drawing you to them?` },
    { speaker: champ, isCustomer: true, text: `Honestly? We already have a relationship. They're the incumbent elsewhere in the business so procurement is easier.` },
    { speaker: secondName, isCustomer: true, text: `Their integration list is longer too. That came up in our first review.` },
    { speaker: owner.name, isCustomer: false, text: `Both true. The question I'd put back is: when you need to change a workflow, who makes the change, and how long does it take?` },
    { speaker: champ, isCustomer: true, text: `With our current Vantage deployment? A ticket to their services team, and about three weeks.` },
    { speaker: owner.name, isCustomer: false, text: `That's the difference we'd be selling on. Your ops team makes that change themselves, same day.` },
    { speaker: champ, isCustomer: true, text: `That's a real point. Our last implementation with them took nine months and the services bill was more than the licence.` },
    { speaker: secondName, isCustomer: true, text: `I'd want to see that demonstrated, not asserted. Can you show us someone from our team building a workflow live?` },
    { speaker: se.name, isCustomer: false, text: `Yes — I'd suggest a working session where your team builds one of your real workflows with me. Not a demo, your process.` },
    { speaker: champ, isCustomer: true, text: `That would be genuinely useful. Let's do that.` },
    { speaker: owner.name, isCustomer: false, text: `I'll schedule the working session and send the competitive comparison you asked for by early next week.` },
    { speaker: champ, isCustomer: true, text: `Thanks. I'll confirm our decision timeline once procurement gives me the dates.` },
  ];
}

function expansionLines(
  account: SeedAccount,
  owner: SeedUser,
  champion: SeedContact,
  other: SeedContact,
  rand: Rand,
): SeedTranscriptLine[] {
  const champ = `${champion.firstName} ${champion.lastName}`;
  const otherName = `${other.firstName} ${other.lastName}`;

  return [
    { speaker: owner.name, isCustomer: false, text: `How has the first workflow been running since go-live?` },
    { speaker: champ, isCustomer: true, text: `Genuinely well. Cycle time on exceptions is down about forty percent and my team has stopped asking me where things are.` },
    { speaker: champ, isCustomer: true, text: `Which is why I wanted to bring ${other.firstName} in — another team wants to use this and I'd rather do it properly than have them build their own.` },
    { speaker: otherName, isCustomer: true, text: `We have a similar problem but higher volume and more approval stages. Before I commit I need to know it handles conditional routing.` },
    { speaker: owner.name, isCustomer: false, text: `It does — branching, parallel approvals, escalation on timeout. Happy to walk your team through it against your actual process.` },
    { speaker: otherName, isCustomer: true, text: `Then the question is commercial. Are we buying a second instance or expanding the existing agreement?` },
    { speaker: owner.name, isCustomer: false, text: `Expansion on the existing agreement, co-termed to your renewal. Simpler for you and it keeps one contract.` },
    { speaker: champ, isCustomer: true, text: `That's what I hoped. I want to expand this company-wide eventually but let's prove the second team first.` },
    { speaker: owner.name, isCustomer: false, text: `I'll send the expansion proposal with the co-termed pricing this week.` },
    { speaker: otherName, isCustomer: true, text: `I'll review it with my director and get back to you within a fortnight.` },
  ];
}

function lossLines(
  account: SeedAccount,
  owner: SeedUser,
  champion: SeedContact,
  rand: Rand,
): SeedTranscriptLine[] {
  const champ = `${champion.firstName} ${champion.lastName}`;
  const budgetLoss = account.scenario === 'lost_to_budget';

  return budgetLoss
    ? [
        { speaker: owner.name, isCustomer: false, text: `Thanks for taking the call. I'd rather understand what happened than pretend it didn't.` },
        { speaker: champ, isCustomer: true, text: `It wasn't you. Our budget got reallocated to an infrastructure programme halfway through. The money simply isn't there this cycle.` },
        { speaker: champ, isCustomer: true, text: `To be clear — not right now doesn't mean never. Come back to me when our next fiscal year opens.` },
        { speaker: owner.name, isCustomer: false, text: `Understood. Is there anything I could have done differently on timing?` },
        { speaker: champ, isCustomer: true, text: `Honestly, getting to my finance director earlier. By the time she was involved the allocation decision had already been made.` },
        { speaker: owner.name, isCustomer: false, text: `That's useful and I'll take it. I'll check back in ahead of your next planning cycle.` },
      ]
    : [
        { speaker: owner.name, isCustomer: false, text: `I appreciate you taking this. What tipped it?` },
        { speaker: champ, isCustomer: true, text: `Two things. They're already a vendor elsewhere in the business, so procurement was a formality rather than a process.` },
        { speaker: champ, isCustomer: true, text: `And their integration story was deeper for the systems we already run. Your product was easier to use — my team preferred it — but that wasn't the deciding factor.` },
        { speaker: owner.name, isCustomer: false, text: `Was there a point where it was still winnable?` },
        { speaker: champ, isCustomer: true, text: `Probably. If we'd had the security review done earlier it would have been a straight product comparison. Instead it dragged and that gave the incumbent an opening.` },
        { speaker: owner.name, isCustomer: false, text: `That's fair feedback. Thank you for being straight with me.` },
        { speaker: champ, isCustomer: true, text: `Keep in touch. This won't be the last thing we look at.` },
      ];
}

function qbrLines(
  account: SeedAccount,
  owner: SeedUser,
  champion: SeedContact,
  rand: Rand,
): SeedTranscriptLine[] {
  const champ = `${champion.firstName} ${champion.lastName}`;
  const pct = 30 + Math.floor(rand() * 25);

  return [
    { speaker: owner.name, isCustomer: false, text: `Let's look at the quarter. Usage is up and cycle time is down ${pct}% against your baseline.` },
    { speaker: champ, isCustomer: true, text: `That matches what we see. The team has genuinely stopped using email for this, which I didn't fully expect.` },
    { speaker: champ, isCustomer: true, text: `One thing though — we'd really like better custom reporting. Right now I export to a spreadsheet to build the view my director wants, which is a bit ironic.` },
    { speaker: owner.name, isCustomer: false, text: `Fair. I'll raise that with product — what specifically does your director want to see?` },
    { speaker: champ, isCustomer: true, text: `Breach rate by team over time, and a per-workflow cost view. Nothing exotic.` },
    { speaker: champ, isCustomer: true, text: `Also — and no urgency — a mobile app would help our field people. They're approving things on their phone through the web view and it's workable but not lovely.` },
    { speaker: owner.name, isCustomer: false, text: `I'll log both. On renewal, your term is up in a few months — anything you want to change in the shape of the agreement?` },
    { speaker: champ, isCustomer: true, text: `We'll likely add seats rather than reduce. Let's talk properly next month.` },
    { speaker: owner.name, isCustomer: false, text: `I'll send the usage summary and a renewal outline for you to review before then.` },
  ];
}

/* ── Emails ───────────────────────────────────────────────────────────────── */

export function buildEmails(
  account: SeedAccount,
  owner: SeedUser,
  se: SeedUser,
  rand: Rand,
): SeedEmail[] {
  const champion = account.contacts[0]!;
  const emails: SeedEmail[] = [];
  const created = account.deal?.createdDaysAgo ?? 20;
  const thread = `${account.domain}-primary`;

  emails.push({
    direction: 'outbound',
    threadKey: thread,
    daysAgo: created,
    subject: `${account.name} — following up on operations workflows`,
    body: [
      `Hi ${champion.firstName},`,
      '',
      `Thanks for the conversation last week. As promised, here's a short summary of what I took away:`,
      '',
      `  • Exceptions currently start as email into a shared mailbox with no ownership`,
      `  • No visibility into how many are open at any point`,
      `  • An audit requirement is driving the timing`,
      '',
      `I've attached a walkthrough tailored to that flow rather than a generic overview.`,
      '',
      `Does a technical session make sense as the next step?`,
      '',
      'Best,',
      owner.name,
    ].join('\n'),
  });

  emails.push({
    direction: 'inbound',
    threadKey: thread,
    daysAgo: Math.max(1, created - 2),
    fromContactIndex: 0,
    subject: `Re: ${account.name} — following up on operations workflows`,
    body: [
      `Hi ${owner.name.split(' ')[0]},`,
      '',
      `That summary is accurate — the audit point especially.`,
      '',
      `A technical session works. I'll bring the person who'll own the evaluation on our side.`,
      '',
      `One thing to flag early: anything we adopt has to go through our security review, and that process is not fast. Worth knowing now rather than later.`,
      '',
      champion.firstName,
    ].join('\n'),
  });

  if (account.scenario === 'enterprise_security') {
    const sec = account.contacts.find((c) => c.department === 'Security');
    const secIndex = sec ? account.contacts.indexOf(sec) : 0;

    emails.push({
      direction: 'inbound',
      threadKey: `${account.domain}-security`,
      daysAgo: Math.max(2, Math.round(created * 0.3)),
      fromContactIndex: secIndex,
      subject: 'Security review — documentation request',
      body: [
        `Hello,`,
        '',
        `Following our call, I need the following before I can begin the review:`,
        '',
        `  1. SOC 2 Type II report (current period)`,
        `  2. Completed security questionnaire — our standard form is attached`,
        `  3. Penetration test executive summary`,
        `  4. Current subprocessor list and your standard DPA`,
        '',
        `To be direct: our security team needs SOC 2 Type II documentation before procurement can open a file. I can't route this any other way.`,
        '',
        `Once I have all four I'll turn the review around in about two weeks.`,
        '',
        sec ? `${sec.firstName} ${sec.lastName}` : 'Security',
        sec?.title ?? 'Information Security',
      ].join('\n'),
    });

    emails.push({
      direction: 'outbound',
      threadKey: `${account.domain}-security`,
      daysAgo: Math.max(1, Math.round(created * 0.22)),
      subject: 'Re: Security review — documentation request',
      body: [
        `Hi,`,
        '',
        `Understood, and thanks for laying it out clearly.`,
        '',
        `I'll send the security questionnaire and our SOC 2 Type II report by Friday, along with the pen test summary and subprocessor list, so you have everything in one go.`,
        '',
        `${se.name} will separately share our SSO configuration guide so your identity team can plan in parallel rather than waiting on the review.`,
        '',
        'Best,',
        owner.name,
      ].join('\n'),
    });
  }

  if (account.scenario === 'stalled_after_pricing') {
    const quietDays = 14 + Math.floor(rand() * 10);
    emails.push({
      direction: 'outbound',
      threadKey: `${account.domain}-pricing`,
      daysAgo: quietDays + 8,
      subject: `${account.name} — proposal`,
      body: [
        `Hi ${champion.firstName},`,
        '',
        `Attaching the proposal we discussed, scoped to the exception workflow with the audit trail included.`,
        '',
        `Happy to walk through it with whoever needs to see it on your side.`,
        '',
        'Best,',
        owner.name,
      ].join('\n'),
    });

    emails.push({
      direction: 'outbound',
      threadKey: `${account.domain}-pricing`,
      daysAgo: quietDays,
      subject: `Re: ${account.name} — proposal`,
      body: [
        `Hi ${champion.firstName},`,
        '',
        `Following up on the proposal — did it land alright?`,
        '',
        `If the number is the sticking point, say so and I'll see what I can do rather than let it sit.`,
        '',
        owner.name,
      ].join('\n'),
    });
  }

  if (account.scenario === 'integration_ask') {
    emails.push({
      direction: 'inbound',
      threadKey: `${account.domain}-integration`,
      daysAgo: Math.max(2, Math.round(created * 0.4)),
      fromContactIndex: 0,
      subject: 'Question on Salesforce',
      body: [
        `Hi ${owner.name.split(' ')[0]},`,
        '',
        `Following up on the integration question from our session.`,
        '',
        `We really need this to integrate with Salesforce — my team lives in it and I'm worried about adoption if they have to work in two places. Is there any update on when the native connector might land?`,
        '',
        `Not necessarily a blocker but it's the thing my team keeps asking about.`,
        '',
        champion.firstName,
      ].join('\n'),
    });
  }

  if (account.scenario === 'competitive_bakeoff') {
    emails.push({
      direction: 'inbound',
      threadKey: `${account.domain}-evaluation`,
      daysAgo: Math.max(2, Math.round(created * 0.35)),
      fromContactIndex: 0,
      subject: 'Evaluation timeline',
      body: [
        `Hi ${owner.name.split(' ')[0]},`,
        '',
        `Procurement has confirmed the process. We're evaluating three vendors including Vantage Systems, with a decision targeted for the end of next month.`,
        '',
        `Each vendor gets a working session. Yours is the one I'm most curious about given what you said about our own team making changes.`,
        '',
        champion.firstName,
      ].join('\n'),
    });
  }

  if (account.lifecycleStage === 'customer') {
    emails.push({
      direction: 'inbound',
      threadKey: `${account.domain}-success`,
      daysAgo: 12 + Math.floor(rand() * 10),
      fromContactIndex: 0,
      subject: 'Reporting request',
      body: [
        `Hi ${owner.name.split(' ')[0]},`,
        '',
        `Quick one — is there any way to get custom reporting on breach rate by team? I'm exporting to a spreadsheet every month to build it, which rather defeats the point.`,
        '',
        `Would be great to have it natively.`,
        '',
        champion.firstName,
      ].join('\n'),
    });
  }

  /* Scheduling and logistics traffic. Low-signal on purpose — a mailbox that
   * contains only substantive messages is not a realistic test of extraction,
   * which has to stay quiet on noise as well as fire on signal. */
  const second = account.contacts[1];
  if (created >= 12) {
    emails.push({
      direction: 'outbound',
      threadKey: `${account.domain}-scheduling`,
      daysAgo: Math.max(3, Math.round(created * 0.6)),
      subject: 'Times for next week',
      body: [
        `Hi ${champion.firstName},`,
        '',
        `Do any of these work for the next session?`,
        '',
        `  • Tuesday 10:00–11:00`,
        `  • Wednesday 14:00–15:00`,
        `  • Thursday 09:00–10:00`,
        '',
        `Happy to work around your team.`,
        '',
        owner.name,
      ].join('\n'),
    });

    emails.push({
      direction: 'inbound',
      threadKey: `${account.domain}-scheduling`,
      daysAgo: Math.max(2, Math.round(created * 0.55)),
      fromContactIndex: 0,
      subject: 'Re: Times for next week',
      body: [
        `Wednesday afternoon works best. I'll send an invite and include ${second ? second.firstName : 'a colleague from my team'}.`,
        '',
        champion.firstName,
      ].join('\n'),
    });
  }

  if (second && created >= 25) {
    emails.push({
      direction: 'inbound',
      threadKey: `${account.domain}-internal-question`,
      daysAgo: Math.max(2, Math.round(created * 0.18)),
      fromContactIndex: 1,
      subject: 'Couple of follow-up questions',
      body: [
        `Hi ${owner.name.split(' ')[0]},`,
        '',
        `Two things came out of our internal review:`,
        '',
        `First, how does the audit trail handle a workflow that gets edited while runs are in flight? Our compliance team will ask.`,
        '',
        `Second, what does implementation actually look like on our side — how much of my team's time should I be planning for?`,
        '',
        `${second.firstName}`,
      ].join('\n'),
    });

    emails.push({
      direction: 'outbound',
      threadKey: `${account.domain}-internal-question`,
      daysAgo: Math.max(1, Math.round(created * 0.15)),
      subject: 'Re: Couple of follow-up questions',
      body: [
        `Hi ${second.firstName},`,
        '',
        `Good questions.`,
        '',
        `On the audit trail: in-flight runs continue against the version of the workflow they started on, and the change itself is recorded with who made it and when. Nothing is retroactively rewritten.`,
        '',
        `On implementation: four to six weeks, and most of that is process mapping with your team rather than technical work. Realistically a few hours a week from whoever owns the process.`,
        '',
        `I'll send the implementation outline so you can see the shape of it.`,
        '',
        owner.name,
      ].join('\n'),
    });
  }

  return emails;
}

/* ── Notes ────────────────────────────────────────────────────────────────── */

export function buildNotes(account: SeedAccount, rand: Rand): { body: string; daysAgo: number }[] {
  const champion = account.contacts[0]!;
  const notes: { body: string; daysAgo: number }[] = [];
  const created = account.deal?.createdDaysAgo ?? 20;

  switch (account.scenario) {
    case 'enterprise_security':
      notes.push({
        daysAgo: Math.max(3, Math.round(created * 0.2)),
        body: `Security review is the critical path here, not the product evaluation. ${champion.firstName} is a genuine champion but has no authority over the security timeline. Priority is getting the questionnaire and SOC 2 across in one batch — their security lead was explicit that chasing documents one at a time is what stretches their review.`,
      });
      break;
    case 'stalled_after_pricing':
      notes.push({
        daysAgo: 9,
        body: `Gone quiet since the proposal. Two follow-ups, no reply. My read is the number landed badly and ${champion.firstName} doesn't want to say so. Worth a direct "is it the price?" rather than another gentle nudge.`,
      });
      break;
    case 'competitive_bakeoff':
      notes.push({
        daysAgo: Math.max(2, Math.round(created * 0.3)),
        body: `Incumbent advantage is real — Vantage is already a vendor elsewhere in the business. Not going to win on feature lists. The working session where their own team builds a workflow is the whole strategy.`,
      });
      break;
    case 'pricing_pushback':
      notes.push({
        daysAgo: Math.max(2, Math.round(created * 0.25)),
        body: `Per-seat model is the blocker, not the total. At their headcount the arithmetic looks absurd even though the value is there. Taking the platform licence option to the CRO.`,
      });
      break;
    case 'exec_engaged_fast':
      notes.push({
        daysAgo: Math.max(4, Math.round(created * 0.45)),
        body: `Getting the exec into the room early changed everything here. Their audit finding last year did more selling than we did.`,
      });
      break;
    default:
      break;
  }

  return notes;
}
