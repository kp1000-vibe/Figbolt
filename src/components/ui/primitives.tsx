import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { avatarHue, cn, initials } from '@/lib/utils';

/**
 * Base primitives.
 *
 * Hand-written rather than pulled from a component library: this product's
 * surfaces are dense and specific (health bands, evidence citations, risk
 * severity), and a generic kit would need overriding everywhere it mattered.
 * Everything here is a plain server-compatible component with no client
 * runtime unless the file that uses it needs one.
 */

/* ── Button ───────────────────────────────────────────────────────────────── */

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[background-color,border-color,color,box-shadow] duration-100 disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-white shadow-[var(--shadow-sm)] hover:bg-accent-hover active:translate-y-px',
        secondary:
          'border border-border bg-surface text-text shadow-[var(--shadow-sm)] hover:bg-surface-hover hover:border-border-strong',
        ghost: 'text-text-muted hover:bg-bg-muted hover:text-text',
        subtle: 'bg-bg-muted text-text hover:bg-border',
        danger: 'bg-danger text-white shadow-[var(--shadow-sm)] hover:brightness-110',
        outlineDanger:
          'border border-danger/35 text-danger-text hover:bg-danger-subtle hover:border-danger/60',
        link: 'text-accent-text underline-offset-4 hover:underline',
      },
      size: {
        xs: 'h-6 rounded-[var(--radius-xs)] px-2 text-2xs [&_svg]:size-3',
        sm: 'h-7.5 rounded-[var(--radius-sm)] px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-9 rounded-[var(--radius-md)] px-3.5 text-sm [&_svg]:size-4',
        lg: 'h-11 rounded-[var(--radius-md)] px-5 text-sm [&_svg]:size-4',
        icon: 'size-8 rounded-[var(--radius-sm)] [&_svg]:size-4',
        iconSm: 'size-6.5 rounded-[var(--radius-xs)] [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = React.ComponentPropsWithoutRef<'button'> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}

export { buttonVariants };

/* ── Card ─────────────────────────────────────────────────────────────────── */

/**
 * `as` is typed loosely on purpose: the element-specific event handler types
 * (`ClipboardEventHandler<HTMLLIElement>` vs `…<HTMLDivElement>`) are not
 * mutually assignable, and threading a full polymorphic generic through every
 * card in the app costs far more than it protects.
 */
export function Card({
  className,
  as: Component = 'div',
  ...props
}: React.ComponentPropsWithoutRef<'div'> & { as?: 'div' | 'section' | 'article' | 'li' }) {
  const Element = Component as React.ElementType;
  return (
    <Element
      className={cn(
        'rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-sm)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div className={cn('flex items-start justify-between gap-3 px-4 pt-3.5 pb-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentPropsWithoutRef<'h3'>) {
  return <h3 className={cn('text-sm font-semibold tracking-tight text-text', className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentPropsWithoutRef<'p'>) {
  return <p className={cn('mt-0.5 text-xs text-text-muted text-pretty', className)} {...props} />;
}

export function CardBody({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div className={cn('px-4 pb-4', className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={cn('flex items-center gap-2 border-t border-border px-4 py-2.5', className)}
      {...props}
    />
  );
}

/* ── Badge ────────────────────────────────────────────────────────────────── */

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border font-medium [&_svg]:size-3',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-bg-muted text-text-muted',
        accent: 'border-accent-border bg-accent-subtle text-accent-text',
        success: 'border-success/25 bg-success-subtle text-success-text',
        warning: 'border-warning/30 bg-warning-subtle text-warning-text',
        danger: 'border-danger/25 bg-danger-subtle text-danger-text',
        info: 'border-info/25 bg-info-subtle text-info-text',
        outline: 'border-border-strong bg-transparent text-text-muted',
      },
      size: {
        sm: 'px-1.5 py-0.5 text-2xs',
        md: 'px-2 py-0.5 text-xs',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'sm' },
  },
);

export type BadgeProps = React.ComponentPropsWithoutRef<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}

/* ── Form controls ────────────────────────────────────────────────────────── */

export function Input({ className, ...props }: React.ComponentPropsWithoutRef<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-[var(--radius-md)] border border-border bg-surface px-3 text-sm text-text',
        'placeholder:text-text-subtle',
        'transition-[border-color,box-shadow] focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15',
        'disabled:cursor-not-allowed disabled:bg-bg-muted disabled:text-text-subtle',
        'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/15',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.ComponentPropsWithoutRef<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2 text-sm text-text',
        'placeholder:text-text-subtle',
        'transition-[border-color,box-shadow] focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15',
        'disabled:cursor-not-allowed disabled:bg-bg-muted',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: React.ComponentPropsWithoutRef<'select'>) {
  return (
    <div className="relative">
      <select
        className={cn(
          'h-9 w-full appearance-none rounded-[var(--radius-md)] border border-border bg-surface pr-8 pl-3 text-sm text-text',
          'transition-[border-color,box-shadow] focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15',
          'disabled:cursor-not-allowed disabled:bg-bg-muted',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-text-subtle"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function Label({ className, ...props }: React.ComponentPropsWithoutRef<'label'>) {
  return (
    <label
      className={cn('mb-1.5 block text-xs font-medium text-text-muted', className)}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <Label>{label}</Label>
      {children}
      {hint && !error && <p className="mt-1 text-2xs text-text-subtle text-pretty">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1 text-2xs text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

/* ── Layout helpers ───────────────────────────────────────────────────────── */

export function Separator({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div role="separator" className={cn('h-px w-full bg-border', className)} {...props} />;
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 flex items-center gap-2">{eyebrow}</div>}
        <h1 className="text-xl font-semibold tracking-tight text-text text-balance">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-text-muted text-pretty">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/* ── States ───────────────────────────────────────────────────────────────── */

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-border px-6 py-14 text-center',
        className,
      )}
    >
      {icon && (
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-bg-muted text-text-subtle [&_svg]:size-5">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-text">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-xs text-text-muted text-pretty">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-[var(--radius-sm)]', className)} />;
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  action,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-danger/30 bg-danger-subtle px-4 py-3.5">
      <p className="text-sm font-medium text-danger-text">{title}</p>
      {description && <p className="mt-1 text-xs text-danger-text/85 text-pretty">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/* ── Data display ─────────────────────────────────────────────────────────── */

export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const hue = avatarHue(name);
  const sizes = {
    xs: 'size-5 text-[9px]',
    sm: 'size-6 text-2xs',
    md: 'size-8 text-xs',
    lg: 'size-11 text-sm',
  };

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold',
        sizes[size],
        className,
      )}
      style={{
        backgroundColor: `oklch(92% 0.05 ${hue})`,
        color: `oklch(38% 0.12 ${hue})`,
      }}
    >
      {initials(name)}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  className?: string;
}) {
  const toneClass = {
    neutral: 'text-text',
    success: 'text-success-text',
    warning: 'text-warning-text',
    danger: 'text-danger-text',
  }[tone];

  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-2xs font-medium tracking-wide text-text-subtle uppercase">{label}</p>
      <p className={cn('mt-1 truncate text-xl font-semibold tabular tracking-tight', toneClass)}>
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-2xs text-text-muted">{hint}</p>}
    </div>
  );
}

/** Label/value row used across every detail page. */
export function DetailRow({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 py-1.5', className)}>
      <dt className="shrink-0 text-xs text-text-subtle">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs font-medium text-text">{children}</dd>
    </div>
  );
}

/* ── Table ────────────────────────────────────────────────────────────────── */

export function Table({ className, ...props }: React.ComponentPropsWithoutRef<'table'>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  );
}

export function Thead({ className, ...props }: React.ComponentPropsWithoutRef<'thead'>) {
  return <thead className={cn('border-b border-border', className)} {...props} />;
}

export function Th({
  className,
  align = 'left',
  ...props
}: React.ComponentPropsWithoutRef<'th'> & { align?: 'left' | 'right' | 'center' }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 text-2xs font-semibold tracking-wide text-text-subtle uppercase',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
      {...props}
    />
  );
}

export function Tbody({ className, ...props }: React.ComponentPropsWithoutRef<'tbody'>) {
  return <tbody className={cn('divide-y divide-border', className)} {...props} />;
}

export function Tr({ className, ...props }: React.ComponentPropsWithoutRef<'tr'>) {
  return <tr className={cn('transition-colors hover:bg-surface-hover', className)} {...props} />;
}

export function Td({
  className,
  align = 'left',
  ...props
}: React.ComponentPropsWithoutRef<'td'> & { align?: 'left' | 'right' | 'center' }) {
  return (
    <td
      className={cn(
        'px-3 py-2.5 text-text',
        align === 'right' && 'text-right tabular',
        align === 'center' && 'text-center',
        className,
      )}
      {...props}
    />
  );
}

/* ── Health & progress ────────────────────────────────────────────────────── */

export type HealthBand = 'critical' | 'at_risk' | 'fair' | 'healthy' | 'strong';

export function bandFor(score: number | null | undefined): HealthBand | null {
  if (score == null) return null;
  return score < 25 ? 'critical' : score < 45 ? 'at_risk' : score < 65 ? 'fair' : score < 82 ? 'healthy' : 'strong';
}

export const BAND_LABEL: Record<HealthBand, string> = {
  critical: 'Critical',
  at_risk: 'At risk',
  fair: 'Fair',
  healthy: 'Healthy',
  strong: 'Strong',
};

export const BAND_TONE: Record<HealthBand, BadgeProps['tone']> = {
  critical: 'danger',
  at_risk: 'danger',
  fair: 'warning',
  healthy: 'success',
  strong: 'success',
};

/**
 * Health is shown as a score, a band and a bar together — never as a bare
 * number. The product rule is that a score always travels with its meaning.
 */
export function HealthScore({
  score,
  showBar = true,
  className,
}: {
  score: number | null | undefined;
  showBar?: boolean;
  className?: string;
}) {
  const band = bandFor(score);
  if (band === null) {
    return <span className={cn('text-xs text-text-subtle', className)}>Unscored</span>;
  }

  const colour = {
    critical: 'var(--danger)',
    at_risk: 'var(--danger)',
    fair: 'var(--warning)',
    healthy: 'var(--success)',
    strong: 'var(--success)',
  }[band];

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span className="text-sm font-semibold tabular text-text">{score}</span>
      {showBar && (
        <span
          className="relative h-1.5 w-14 overflow-hidden rounded-full bg-bg-muted"
          role="img"
          aria-label={`Health ${score} of 100, ${BAND_LABEL[band]}`}
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${score}%`, backgroundColor: colour }}
          />
        </span>
      )}
      <Badge tone={BAND_TONE[band]}>{BAND_LABEL[band]}</Badge>
    </span>
  );
}

export function ProgressBar({
  value,
  max = 100,
  tone = 'accent',
  className,
  label,
}: {
  value: number;
  max?: number;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
  label?: string;
}) {
  const pct = max === 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const colour = {
    accent: 'var(--accent)',
    success: 'var(--success)',
    warning: 'var(--warning)',
    danger: 'var(--danger)',
  }[tone];

  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-bg-muted', className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className="h-full rounded-full transition-[width] duration-300"
        style={{ width: `${pct}%`, backgroundColor: colour }}
      />
    </div>
  );
}

/* ── Misc ─────────────────────────────────────────────────────────────────── */

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-[3px] border border-border bg-bg-muted px-1 font-mono text-[10px] font-medium text-text-subtle',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function SectionLabel({ className, ...props }: React.ComponentPropsWithoutRef<'h2'>) {
  return (
    <h2
      className={cn('text-2xs font-semibold tracking-wide text-text-subtle uppercase', className)}
      {...props}
    />
  );
}

/** A dot indicating live/idle/error state, with an accessible label. */
export function StatusDot({
  tone,
  label,
  pulse = false,
}: {
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'accent';
  label: string;
  pulse?: boolean;
}) {
  const colour = {
    success: 'var(--success)',
    warning: 'var(--warning)',
    danger: 'var(--danger)',
    neutral: 'var(--text-subtle)',
    accent: 'var(--accent)',
  }[tone];

  return (
    <span className="relative inline-flex size-2 shrink-0" title={label}>
      <span className="sr-only">{label}</span>
      {pulse && (
        <span
          className="absolute inset-0 animate-ping rounded-full opacity-60"
          style={{ backgroundColor: colour }}
        />
      )}
      <span className="relative size-2 rounded-full" style={{ backgroundColor: colour }} />
    </span>
  );
}
