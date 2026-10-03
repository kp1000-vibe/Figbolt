import type { MetadataRoute } from 'next';
import { SITE } from '@/lib/seo';
import { PWA_ICONS, PWA_ICON_PREFIX, PWA_START_URL } from '@/lib/pwa';

/**
 * The web app manifest — what makes Figbolt installable from the browser, and
 * the base the Capacitor shell builds on.
 *
 * `id` is pinned to the start URL so a later change to start_url does not make
 * browsers treat it as a different app and orphan existing installs.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: PWA_START_URL,
    name: SITE.name,
    short_name: SITE.name,
    description: SITE.description,
    start_url: PWA_START_URL,
    scope: '/',
    display: 'standalone',
    // Matches the light-theme --bg and the viewport themeColor in the root
    // layout, so the splash screen does not flash a different colour.
    background_color: '#fcfcfd',
    theme_color: '#fcfcfd',
    categories: ['business', 'productivity'],
    icons: Object.entries(PWA_ICONS).map(([file, icon]) => ({
      src: `${PWA_ICON_PREFIX}${file}`,
      sizes: `${icon.size}x${icon.size}`,
      type: 'image/png',
      purpose: icon.purpose,
    })),
    // Long-press on the home-screen icon (Android, and desktop installs).
    shortcuts: [
      { name: 'Ask Bolt', url: '/ask', description: 'Ask about your customers' },
      { name: 'Inbox', url: '/inbox' },
      { name: 'Pipeline', url: '/opportunities' },
      { name: 'Tasks', url: '/tasks' },
    ],
  };
}
