'use client';

import * as React from 'react';

/**
 * Theme handling.
 *
 * The blocking script runs before paint so a dark-mode user never sees a white
 * flash. It reads localStorage first, then the OS preference — an explicit
 * choice always wins over the system.
 */

const STORAGE_KEY = 'figbolt-theme';

export function ThemeScript() {
  const script = `
(function () {
  try {
    var stored = localStorage.getItem('${STORAGE_KEY}');
    var dark = stored === 'dark' ||
      (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();`.trim();

  return <script dangerouslySetInnerHTML={{ __html: script }} suppressHydrationWarning />;
}

export type Theme = 'light' | 'dark' | 'system';

export function useTheme() {
  const [theme, setTheme] = React.useState<Theme>('system');

  React.useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    setTheme(stored ?? 'system');
  }, []);

  const apply = React.useCallback((next: Theme) => {
    setTheme(next);
    const isDark =
      next === 'dark' ||
      (next === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', isDark);
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  }, []);

  // Follow the OS while the user is on "system".
  React.useEffect(() => {
    if (theme !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (e: MediaQueryListEvent) =>
      document.documentElement.classList.toggle('dark', e.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, [theme]);

  return { theme, setTheme: apply };
}
