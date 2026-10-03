/**
 * The bolt mark, as one definition for every rendered icon.
 *
 * The favicon, the Apple touch icon and the installable-app icons are all
 * generated from this, so they cannot drift apart — the usual failure being a
 * favicon updated and a home-screen icon still showing last year's mark.
 *
 * Rendered by Satori (next/og), which supports a subset of CSS and no oklch(),
 * so the accent is the hex equivalent of the light-theme token.
 */

export const BRAND_ACCENT = '#3b5bd4';

/** The bolt glyph's path, in a 24x24 box. */
export const BOLT_PATH = 'M13.5 2.5 6 13.2h4.6L9.8 21.5 18 10.4h-4.9z';

/**
 * @param size     edge length in px of the rendered square
 * @param radius   corner radius in px; 0 for platforms that apply their own mask
 * @param glyph    the bolt's share of the edge, 0-1. A maskable icon must keep
 *                 its content inside the central 80% circle, so it uses less.
 */
export function BoltMark({ size, radius, glyph }: { size: number; radius: number; glyph: number }) {
  const glyphPx = Math.round(size * glyph);
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: BRAND_ACCENT,
        borderRadius: radius,
      }}
    >
      <svg width={glyphPx} height={glyphPx} viewBox="0 0 24 24">
        <path d={BOLT_PATH} fill="#ffffff" />
      </svg>
    </div>
  );
}
