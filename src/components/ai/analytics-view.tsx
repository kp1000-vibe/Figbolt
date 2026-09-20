import type { AnalyticsResult } from '@/server/analytics/ask';
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui/primitives';
import { Info } from '@/components/layout/icons';
import { money, moneyShort, number } from '@/lib/utils';

/**
 * Analytics answer.
 *
 * Renders the report template's output: a headline answer, a chart, the
 * underlying table, and the methodology. Methodology is not an optional
 * footnote — a number without a stated method invites the wrong decision, so
 * it always ships alongside.
 */
export function AnalyticsResultView({ result }: { result: AnalyticsResult }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="pt-4">
          <p className="text-sm leading-relaxed text-text text-pretty">
            {renderEmphasis(result.answer)}
          </p>
        </CardBody>
      </Card>

      {result.chart && result.chart.series.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{result.chart.title}</CardTitle>
          </CardHeader>
          <CardBody className="pt-0">
            <Chart chart={result.chart} />
          </CardBody>
        </Card>
      )}

      {result.table && result.table.rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Underlying data</CardTitle>
          </CardHeader>
          <CardBody className="px-0 pt-0 pb-0">
            <Table>
              <Thead>
                <Tr className="hover:bg-transparent">
                  {result.table.columns.map((column, i) => (
                    <Th key={column} align={i === 0 ? 'left' : 'right'}>
                      {column}
                    </Th>
                  ))}
                </Tr>
              </Thead>
              <Tbody>
                {result.table.rows.map((row, i) => (
                  <Tr key={i}>
                    {row.map((cell, j) => (
                      <Td key={j} align={j === 0 ? 'left' : 'right'}>
                        {typeof cell === 'number' ? formatCell(result.table!.columns[j] ?? '', cell) : cell}
                      </Td>
                    ))}
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </CardBody>
        </Card>
      )}

      <Card className="border-info/25 bg-info-subtle">
        <CardBody className="flex gap-2.5 pt-3.5">
          <Info className="mt-0.5 size-4 shrink-0 text-info-text" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-info-text">How this was calculated</p>
            <p className="mt-1 text-2xs leading-relaxed text-info-text/85 text-pretty">
              {result.methodology}
            </p>
            <p className="mt-1.5 text-2xs text-info-text/70">
              Run from a pre-approved read-only report template. No model-generated SQL touches the
              database.
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function Chart({ chart }: { chart: NonNullable<AnalyticsResult['chart']> }) {
  const max = Math.max(...chart.series.map((s) => Math.abs(s.value)), 1);

  if (chart.kind === 'stat') {
    return (
      <div className="grid grid-cols-2 gap-5">
        {chart.series.map((point) => (
          <div key={point.label}>
            <p className="text-2xs tracking-wide text-text-subtle uppercase">{point.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular tracking-tight text-text">
              {formatValue(point.value, point.label.toLowerCase().includes('value') ? 'currency' : 'number')}
            </p>
          </div>
        ))}
      </div>
    );
  }

  return (
    <ul className="space-y-2.5">
      {chart.series.map((point) => (
        <li key={point.label} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-xs text-text-muted capitalize">{point.label}</span>
            <span className="shrink-0 text-xs font-semibold tabular text-text">
              {formatValue(point.value, chart.valueFormat)}
              {point.secondary != null && (
                <span className="ml-1.5 font-normal text-text-subtle">
                  ({number(point.secondary)})
                </span>
              )}
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg-muted">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${(Math.abs(point.value) / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function formatValue(value: number, format: 'currency' | 'number' | 'percent' | 'days'): string {
  switch (format) {
    case 'currency':
      return moneyShort(value);
    case 'percent':
      return `${Math.round(value)}%`;
    case 'days':
      return `${Math.round(value)}d`;
    default:
      return number(value);
  }
}

/** Infer a cell's format from its column heading. */
function formatCell(column: string, value: number): string {
  const c = column.toLowerCase();
  if (c.includes('value') || c.includes('pipeline') || c.includes('arr')) return money(value);
  if (c.includes('%') || c.includes('rate')) return `${value}%`;
  if (c.includes('days')) return `${value}d`;
  return number(value);
}

/** `**bold**` only — analytics answers are template-authored, not free text. */
function renderEmphasis(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}
