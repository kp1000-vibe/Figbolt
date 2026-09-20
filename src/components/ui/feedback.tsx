'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Client-side feedback primitives: spinners, toasts, confirmation dialogs and
 * the pending-state wrappers used by server actions.
 */

export { Badge, Button, Kbd } from './primitives';

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('animate-spin', className)}
      fill="none"
      aria-hidden
      role="presentation"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ── Toasts ───────────────────────────────────────────────────────────────── */

export type Toast = {
  id: string;
  title: string;
  description?: string;
  tone: 'success' | 'error' | 'info';
};

type ToastContextValue = {
  toast: (input: Omit<Toast, 'id'>) => void;
};

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const dismiss = React.useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const toast = React.useCallback(
    (input: Omit<Toast, 'id'>) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((t) => [...t, { ...input, id }]);
      // Errors stay longer — they usually need reading, not just noticing.
      setTimeout(() => dismiss(id), input.tone === 'error' ? 7000 : 4000);
    },
    [dismiss],
  );

  const value = React.useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-full max-w-sm flex-col gap-2"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'animate-fade-in pointer-events-auto flex items-start gap-3 rounded-[var(--radius-lg)] border px-3.5 py-3 shadow-[var(--shadow-lg)]',
              t.tone === 'success' && 'border-success/30 bg-success-subtle',
              t.tone === 'error' && 'border-danger/30 bg-danger-subtle',
              t.tone === 'info' && 'border-border bg-surface-raised',
            )}
          >
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-xs font-medium',
                  t.tone === 'success' && 'text-success-text',
                  t.tone === 'error' && 'text-danger-text',
                  t.tone === 'info' && 'text-text',
                )}
              >
                {t.title}
              </p>
              {t.description && (
                <p className="mt-0.5 text-2xs text-text-muted text-pretty">{t.description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-text-subtle hover:text-text"
              aria-label="Dismiss"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  // A missing provider should not crash a page; log and no-op instead.
  return (
    ctx ?? {
      toast: (input) => console.warn('[toast] no ToastProvider mounted:', input.title),
    }
  );
}

/* ── Modal ────────────────────────────────────────────────────────────────── */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);

    // Prevent the page behind from scrolling while the modal owns the viewport.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus in so the dialog is reachable from the keyboard immediately.
    const focusable = ref.current?.querySelector<HTMLElement>(
      'input,textarea,select,button:not([aria-label="Close"])',
    );
    focusable?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        className={cn(
          'animate-scale-in relative flex max-h-[86vh] w-full flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface-raised shadow-[var(--shadow-xl)]',
          widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-text">{title}</h2>
            {description && (
              <p className="mt-0.5 text-xs text-text-muted text-pretty">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 text-text-subtle hover:text-text"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>}
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border bg-bg-subtle px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Tabs ─────────────────────────────────────────────────────────────────── */

export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: { id: string; label: string; count?: number }[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn('flex gap-1 overflow-x-auto border-b border-border', className)}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={cn(
              '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors',
              selected
                ? 'border-accent text-text'
                : 'border-transparent text-text-muted hover:border-border-strong hover:text-text',
            )}
          >
            {tab.label}
            {tab.count != null && tab.count > 0 && (
              <span className="rounded-full bg-bg-muted px-1.5 py-0.5 text-[10px] tabular text-text-muted">
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── Copy-to-clipboard ────────────────────────────────────────────────────── */

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard permission denied — nothing useful to do */
        }
      }}
      className="inline-flex items-center gap-1 text-2xs text-text-subtle transition-colors hover:text-text"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
