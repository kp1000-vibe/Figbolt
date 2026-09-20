import type { HealthRationale } from '@/db/schema';
import {
  BAND_LABEL,
  BAND_TONE,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  bandFor,
} from '@/components/ui/primitives';
import { CitationChip } from './citation';
import { cn } from '@/lib/utils';

/**
 * Health score with its full reasoning.
 *
 * The product rule this implements: never show a score without showing how it
 * was reached. Every factor lists its own contribution and the records that
 * triggered it, and the arithmetic is displayed so the number is checkable —
 * base, plus positives, minus risks, equals the score on the dial.
 */
export function HealthPanel({
  score,
  rationale,
  className,
  title = 'Deal health',
}: {
  score: number | null | undefined;
  rationale: HealthRationale | null | undefined;
  className?: string;
  title?: string;
}) {
  const band = bandFor(score);

  if (score == null || !rationale) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-xs text-text-muted">
            Not yet scored. Health is computed once there is recorded interaction to score against.
          </p>
        </CardBody>
      </Card>
    );
  }

  const positiveTotal = rationale.positives.reduce((s, p) => s + p.weight, 0);
  const riskTotal = rationale.risks.reduce((s, r) => s + r.weight, 0);
  const base = score - positiveTotal - riskTotal;

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="mt-0.5 text-2xs text-text-subtle">
            Recomputed {new Date(rationale.computedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
          </p>
        </div>
        {band && <Badge tone={BAND_TONE[band]} size="md">{BAND_LABEL[band]}</Badge>}
      </CardHeader>

      <CardBody className="pt-0">
        <Dial score={score} band={band} />

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <FactorList
            heading="Working in your favour"
            factors={rationale.positives}
            tone="positive"
          />
          <FactorList heading="Risks" factors={rationale.risks} tone="negative" />
        </div>

        {/* The arithmetic, spelled out. */}
        <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--radius-md)] bg-bg-subtle px-3 py-2 text-2xs text-text-muted">
          <span>Base {base}</span>
          <span className="text-text-subtle">+</span>
          <span className="text-success-text">{positiveTotal} positive</span>
          <span className="text-text-subtle">−</span>
          <span className="text-danger-text">{Math.abs(riskTotal)} risk</span>
          <span className="text-text-subtle">=</span>
          <span className="font-semibold text-text">{score}</span>
          <span className="ml-auto text-text-subtle">{rationale.method}</span>
        </div>
      </CardBody>
    </Card>
  );
}

function Dial({ score, band }: { score: number; band: ReturnType<typeof bandFor> }) {
  const colour = !band
    ? 'var(--text-subtle)'
    : {
        critical: 'var(--danger)',
        at_risk: 'var(--danger)',
        fair: 'var(--warning)',
        healthy: 'var(--success)',
        strong: 'var(--success)',
      }[band];

  return (
    <div className="flex items-center gap-4">
      <div className="flex items-baseline gap-1">
        <span className="text-4xl font-semibold tabular tracking-tight text-text">{score}</span>
        <span className="text-sm text-text-subtle">/100</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative h-2 overflow-hidden rounded-full bg-bg-muted">
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
            style={{ width: `${score}%`, backgroundColor: colour }}
          />
          {/* Band boundaries, so the score's position is legible at a glance. */}
          {[25, 45, 65, 82].map((mark) => (
            <span
              key={mark}
              className="absolute inset-y-0 w-px bg-surface/70"
              style={{ left: `${mark}%` }}
              aria-hidden
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-text-subtle">
          <span>Critical</span>
          <span>At risk</span>
          <span>Fair</span>
          <span>Healthy</span>
          <span>Strong</span>
        </div>
      </div>
    </div>
  );
}

function FactorList({
  heading,
  factors,
  tone,
}: {
  heading: string;
  factors: HealthRationale['positives'];
  tone: 'positive' | 'negative';
}) {
  return (
    <div className="min-w-0">
      <p className="text-2xs font-semibold tracking-wide text-text-subtle uppercase">{heading}</p>

      {factors.length === 0 ? (
        <p className="mt-2 text-xs text-text-subtle">
          {tone === 'positive' ? 'Nothing recorded yet.' : 'None detected.'}
        </p>
      ) : (
        <ul className="mt-2 space-y-2.5">
          {factors.map((factor, i) => (
            <li key={i} className="min-w-0">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 text-xs font-medium text-text text-pretty">{factor.label}</p>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular',
                    tone === 'positive'
                      ? 'bg-success-subtle text-success-text'
                      : 'bg-danger-subtle text-danger-text',
                  )}
                >
                  {factor.weight > 0 ? `+${factor.weight}` : factor.weight}
                </span>
              </div>
              {factor.detail && (
                <p className="mt-0.5 text-2xs text-text-muted text-pretty">{factor.detail}</p>
              )}
              {factor.sources && factor.sources.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {factor.sources.slice(0, 3).map((source, j) => (
                    <CitationChip key={j} source={source} />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
