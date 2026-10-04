import { MARK_BODY_PATH, MARK_LEAF_PATH, MARK_VIEWBOX } from '@/lib/brand-mark';
import { cn } from '@/lib/utils';

/**
 * The Figbolt logo for the product UI. Paths come from src/lib/brand-mark.tsx,
 * the single definition every logo surface shares.
 */

/** The bare mark in the current text colour — for one-colour placements. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox={MARK_VIEWBOX} className={className} aria-hidden fill="currentColor">
      <path d={MARK_BODY_PATH} fillRule="evenodd" />
      <path d={MARK_LEAF_PATH} />
    </svg>
  );
}

/**
 * The mark on its gradient tile — the primary logo. Size it with a `size-*`
 * class; the mark scales with the tile.
 */
export function LogoTile({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[28%] text-white',
        'bg-[linear-gradient(145deg,#4a63e0_0%,#3b4fc8_55%,#5b3fc4_100%)]',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(16,18,40,0.25)]',
        className,
      )}
    >
      <LogoMark className="size-[64%]" />
    </span>
  );
}
