/**
 * The installable-app definition, shared by the manifest and the icon route.
 *
 * Keeping the icon table here means the manifest can only list icons the
 * route will actually render — a manifest pointing at a 404 is silently
 * ignored by browsers, and the install prompt just never appears.
 */

/**
 * The icons the manifest declares. `maskable` is for Android's adaptive icons,
 * which crop to a circle, squircle or teardrop depending on the launcher, so
 * everything that matters has to sit in the central 80% circle: a smaller
 * glyph, and a background that runs to the edge with no corner of its own.
 */
export const PWA_ICONS = {
  '192.png': { size: 192, radius: 38, glyph: 0.62, purpose: 'any' },
  '512.png': { size: 512, radius: 100, glyph: 0.62, purpose: 'any' },
  'maskable-512.png': { size: 512, radius: 0, glyph: 0.42, purpose: 'maskable' },
} as const;

export type PwaIconFile = keyof typeof PWA_ICONS;

export function isPwaIconFile(value: string): value is PwaIconFile {
  return Object.hasOwn(PWA_ICONS, value);
}

export const PWA_ICON_PREFIX = '/icons/';

/** Where the app opens when launched from the home screen. Signed-out users are redirected to /login by the page itself. */
export const PWA_START_URL = '/home';

/** The static page the service worker serves when a navigation fails offline. */
export const PWA_OFFLINE_URL = '/offline.html';
