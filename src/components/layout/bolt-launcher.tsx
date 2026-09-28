'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';

/**
 * The floating Ask Bolt button.
 *
 * Present on every page in the app, bottom-right, because the whole premise is
 * that you should be able to ask rather than navigate. Opening the command bar
 * rather than routing to /ask is deliberate: the command bar already answers
 * questions *and* runs one-step commands, so the button is a way in to both
 * without losing the page you are on.
 *
 * It hides itself on /ask, where it would point at the thing you are already
 * looking at, and it sits above content but below the command bar overlay.
 */
export function BoltLauncher({ onOpen }: { onOpen: () => void }) {
  const pathname = usePathname();
  const [hovered, setHovered] = React.useState(false);

  if (pathname === '/ask') return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="Ask Bolt"
      title="Ask Bolt  (⌘K)"
      className={[
        'group fixed bottom-5 right-5 z-30 flex items-center gap-2.5',
        'rounded-full bg-accent py-3 text-white shadow-[var(--shadow-lg)]',
        'transition-[width,padding,background-color] duration-200 ease-out',
        'hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2',
        'focus-visible:outline-accent',
        // Collapsed to a circle; widens to show the label on hover or focus.
        hovered ? 'px-4' : 'px-3.5',
      ].join(' ')}
    >
      <Sparkle className="size-5 shrink-0" />
      <span
        className={[
          'overflow-hidden whitespace-nowrap text-sm font-medium',
          'transition-[max-width,opacity] duration-200 ease-out',
          hovered ? 'max-w-32 opacity-100' : 'max-w-0 opacity-0',
        ].join(' ')}
      >
        Ask Bolt
      </span>
    </button>
  );
}

function Sparkle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path
        d="M12 3.5 13.6 9 19 10.6 13.6 12.2 12 17.7 10.4 12.2 5 10.6 10.4 9z"
        fill="currentColor"
      />
      <path d="M18.5 16.2 19.2 18.4 21.4 19.1 19.2 19.8 18.5 22 17.8 19.8 15.6 19.1 17.8 18.4z" fill="currentColor" />
    </svg>
  );
}
