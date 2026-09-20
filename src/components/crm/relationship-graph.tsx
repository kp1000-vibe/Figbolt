'use client';

import * as React from 'react';
import Link from 'next/link';
import type { getRelationshipGraph } from '@/server/crm/accounts';
import { Badge, Card, CardBody, CardHeader, CardTitle, EmptyState } from '@/components/ui/primitives';
import { NavIcon } from '@/components/layout/icons';
import { cn, initials, moneyShort, titleCase } from '@/lib/utils';

/**
 * The relationship graph.
 *
 * Rendered as inline SVG with a deterministic radial layout rather than a
 * force simulation: a buying committee has 3–8 nodes, and a layout that
 * settles differently on every render makes the picture harder to read, not
 * easier. Seniority drives the radius so the org shape is legible at a glance,
 * and edge type drives the stroke so influence and blockers stand out.
 */

type Graph = Awaited<ReturnType<typeof getRelationshipGraph>>;

const ROLE_COLOUR: Record<string, string> = {
  champion: 'var(--success)',
  economic_buyer: 'var(--accent)',
  decision_maker: 'var(--accent)',
  technical_evaluator: 'var(--info)',
  blocker: 'var(--danger)',
  influencer: 'var(--text-subtle)',
  end_user: 'var(--text-subtle)',
  unknown: 'var(--text-subtle)',
};

const EDGE_STYLE: Record<string, { stroke: string; dash?: string; label: string }> = {
  champion_for: { stroke: 'var(--success)', label: 'champions' },
  economic_buyer_for: { stroke: 'var(--accent)', label: 'holds budget for' },
  decision_maker_for: { stroke: 'var(--accent)', label: 'decides on' },
  technical_evaluator_for: { stroke: 'var(--info)', label: 'evaluates' },
  blocker_for: { stroke: 'var(--danger)', dash: '4 3', label: 'blocks' },
  reports_to: { stroke: 'var(--border-strong)', dash: '2 3', label: 'reports to' },
  works_at: { stroke: 'var(--border)', label: 'works at' },
  relates_to: { stroke: 'var(--border-strong)', dash: '3 3', label: 'involved in' },
  belongs_to: { stroke: 'var(--border)', label: 'belongs to' },
};

const SENIORITY_RADIUS: Record<string, number> = {
  c_level: 96,
  vp: 118,
  director: 140,
  manager: 162,
  ic: 182,
};

export function RelationshipGraph({ graph }: { graph: Graph }) {
  const [hovered, setHovered] = React.useState<string | null>(null);

  const width = 620;
  const height = 420;
  const cx = width / 2;
  const cy = height / 2;

  const nodes = React.useMemo(() => {
    // Order by seniority so the ring reads top-down rather than at random.
    const order = ['c_level', 'vp', 'director', 'manager', 'ic'];
    const sorted = [...graph.contacts].sort(
      (a, b) => order.indexOf(a.seniority ?? 'ic') - order.indexOf(b.seniority ?? 'ic'),
    );

    return sorted.map((contact, i) => {
      const radius = SENIORITY_RADIUS[contact.seniority ?? 'ic'] ?? 170;
      // Golden-angle spacing keeps neighbours apart even at small counts.
      const angle = (i * 2.39996) - Math.PI / 2;
      return {
        ...contact,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius * 0.62,
      };
    });
  }, [graph.contacts, cx, cy]);

  const nodeById = React.useMemo(
    () => new Map(nodes.map((n) => [n.id, n])),
    [nodes],
  );

  const dealNodes = React.useMemo(
    () =>
      graph.opportunities.slice(0, 3).map((deal, i, arr) => ({
        ...deal,
        x: 78,
        y: cy + (i - (arr.length - 1) / 2) * 74,
      })),
    [graph.opportunities, cy],
  );
  const dealById = React.useMemo(() => new Map(dealNodes.map((d) => [d.id, d])), [dealNodes]);

  if (graph.contacts.length === 0) {
    return (
      <EmptyState
        icon={<NavIcon name="users" />}
        title="No relationship map yet"
        description="The graph is built from contacts and the buying roles the memory engine detects in conversations."
      />
    );
  }

  const relevantEdges = graph.edges.filter((edge) => {
    const from =
      edge.fromType === 'contact' ? nodeById.get(edge.fromId) : dealById.get(edge.fromId);
    const to = edge.toType === 'contact' ? nodeById.get(edge.toId) : dealById.get(edge.toId);
    // Skip works_at/belongs_to — every node has one, so drawing them just
    // creates a starburst that hides the interesting edges.
    if (edge.type === 'works_at' || edge.type === 'belongs_to') return false;
    return Boolean(from && to);
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle>Buying committee</CardTitle>
            <p className="mt-0.5 text-2xs text-text-subtle">
              Ring position reflects seniority. Edge colour reflects the role in the deal.
            </p>
          </div>
        </CardHeader>
        <CardBody className="pt-0">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-auto w-full"
            role="img"
            aria-label={`Relationship graph for ${graph.account?.name ?? 'this account'} with ${nodes.length} contacts`}
          >
            {/* Edges first so nodes paint on top. */}
            <g>
              {relevantEdges.map((edge) => {
                const from =
                  edge.fromType === 'contact' ? nodeById.get(edge.fromId) : dealById.get(edge.fromId);
                const to = edge.toType === 'contact' ? nodeById.get(edge.toId) : dealById.get(edge.toId);
                if (!from || !to) return null;

                const style = EDGE_STYLE[edge.type] ?? EDGE_STYLE['relates_to']!;
                const dimmed = hovered !== null && hovered !== edge.fromId && hovered !== edge.toId;

                return (
                  <line
                    key={edge.id}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={style.stroke}
                    strokeWidth={hovered === edge.fromId || hovered === edge.toId ? 2 : 1.3}
                    strokeDasharray={style.dash}
                    opacity={dimmed ? 0.15 : 0.75}
                    className="transition-opacity"
                  />
                );
              })}
            </g>

            {/* Deals on the left rail. */}
            {dealNodes.map((deal) => (
              <g key={deal.id} className="cursor-pointer">
                <rect
                  x={deal.x - 62}
                  y={deal.y - 20}
                  width={124}
                  height={40}
                  rx={8}
                  fill="var(--bg-muted)"
                  stroke="var(--border-strong)"
                  strokeWidth={1}
                />
                <text
                  x={deal.x}
                  y={deal.y - 4}
                  textAnchor="middle"
                  className="fill-[var(--text)] text-[9px] font-semibold"
                >
                  {truncateSvg(deal.name, 20)}
                </text>
                <text
                  x={deal.x}
                  y={deal.y + 9}
                  textAnchor="middle"
                  className="fill-[var(--text-subtle)] text-[9px]"
                >
                  {moneyShort(deal.value)} · {deal.status}
                </text>
              </g>
            ))}

            {/* Contacts. */}
            {nodes.map((node) => {
              const colour = ROLE_COLOUR[node.buyingRole ?? 'unknown'] ?? 'var(--text-subtle)';
              const isHovered = hovered === node.id;
              const dimmed = hovered !== null && !isHovered;

              return (
                <g
                  key={node.id}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  opacity={dimmed ? 0.4 : 1}
                  className="cursor-pointer transition-opacity"
                >
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={isHovered ? 21 : 18}
                    fill="var(--surface)"
                    stroke={colour}
                    strokeWidth={2.2}
                    className="transition-all"
                  />
                  <text
                    x={node.x}
                    y={node.y + 3.5}
                    textAnchor="middle"
                    className="fill-[var(--text)] text-[10px] font-bold"
                  >
                    {initials(node.name)}
                  </text>
                  <text
                    x={node.x}
                    y={node.y + 34}
                    textAnchor="middle"
                    className="fill-[var(--text)] text-[9.5px] font-medium"
                  >
                    {truncateSvg(node.name, 18)}
                  </text>
                  <text
                    x={node.x}
                    y={node.y + 45}
                    textAnchor="middle"
                    className="fill-[var(--text-subtle)] text-[8.5px]"
                  >
                    {node.buyingRole && node.buyingRole !== 'unknown'
                      ? titleCase(node.buyingRole)
                      : (node.title ?? '')}
                  </text>
                </g>
              );
            })}
          </svg>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {[
              { role: 'champion', label: 'Champion' },
              { role: 'economic_buyer', label: 'Economic buyer' },
              { role: 'technical_evaluator', label: 'Technical evaluator' },
              { role: 'blocker', label: 'Blocker' },
            ].map((item) => (
              <span key={item.role} className="flex items-center gap-1.5 text-2xs text-text-muted">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: ROLE_COLOUR[item.role] }}
                />
                {item.label}
              </span>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Relationship intelligence</CardTitle>
        </CardHeader>
        <CardBody className="pt-0">
          <RelationshipFacts graph={graph} />
        </CardBody>
      </Card>
    </div>
  );
}

function RelationshipFacts({ graph }: { graph: Graph }) {
  const byRole = (role: string) => graph.contacts.find((c) => c.buyingRole === role);

  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: 'Champion',
      value: byRole('champion') ? (
        <Link
          href={`/contacts/${byRole('champion')!.id}`}
          className="text-accent-text hover:underline"
        >
          {byRole('champion')!.name}
        </Link>
      ) : (
        <span className="text-danger-text">Not identified</span>
      ),
    },
    {
      label: 'Economic buyer',
      value: byRole('economic_buyer') ? (
        <Link
          href={`/contacts/${byRole('economic_buyer')!.id}`}
          className="text-accent-text hover:underline"
        >
          {byRole('economic_buyer')!.name}
        </Link>
      ) : (
        <span className="text-danger-text">Not identified</span>
      ),
    },
    {
      label: 'Decision maker',
      value: byRole('decision_maker')?.name ?? byRole('economic_buyer')?.name ?? '—',
    },
    {
      label: 'Technical evaluator',
      value: byRole('technical_evaluator')?.name ?? '—',
    },
    {
      label: 'Potential blocker',
      value: byRole('blocker') ? (
        <span className="text-danger-text">{byRole('blocker')!.name}</span>
      ) : (
        'None identified'
      ),
    },
    { label: 'Known contacts', value: String(graph.contacts.length) },
    {
      label: 'Roles mapped',
      value: `${graph.contacts.filter((c) => c.buyingRole && c.buyingRole !== 'unknown').length} of ${graph.contacts.length}`,
    },
  ];

  return (
    <>
      <dl>
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4 py-1.5">
            <dt className="shrink-0 text-xs text-text-subtle">{row.label}</dt>
            <dd className="min-w-0 truncate text-right text-xs font-medium text-text">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {!byRole('champion') && (
        <p className="mt-3 rounded-[var(--radius-md)] border border-warning/30 bg-warning-subtle px-3 py-2 text-2xs leading-relaxed text-warning-text text-pretty">
          No champion is identified. In this workspace&rsquo;s own data, that is the strongest single
          predictor of a deal stalling.
        </p>
      )}
    </>
  );
}

/** SVG has no text-overflow, so long labels must be trimmed before render. */
function truncateSvg(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
