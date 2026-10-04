/**
 * The Figbolt mark, as one definition for every rendered logo.
 *
 * A fig — a round fruit with a leaf on its shoulder — split clean through by
 * a lightning bolt. The bolt is negative space and breaks the outline at top
 * and bottom, which is what separates it from the many "bolt in a circle"
 * marks; the leaf is what makes it a fig rather than a power button. The leaf
 * is attached to the fruit, not floating, so it does not read as Apple's.
 *
 * Drawn on a 32-unit grid. The body uses the even-odd rule so the bolt is a
 * hole, which keeps it correct on any background, in any colour.
 *
 * Every surface draws from these paths: the in-app logo, the favicon, the
 * Apple touch icon, the installable-app icons, the link-preview card and the
 * offline page. Change it here and nowhere else.
 */

export const MARK_VIEWBOX = '0 0 32 32';

/** The fruit, with the bolt cut out of it. Render with fill-rule="evenodd". */
export const MARK_BODY_PATH =
  'M15.5 5a12.5 12.5 0 1 0 0 25a12.5 12.5 0 1 0 0-25z' +
  'M18.3 3.4L8.9 19h6.2l-2 12.6L22.5 16h-6.2z';

/** The leaf, rooted inside the fruit's shoulder so the two read as one shape. */
export const MARK_LEAF_PATH = 'M20.6 7.9c.1-3.2 2.6-5.5 6.9-5.4c-.2 3.7-3 5.9-6.9 5.4z';

/** The tile behind the mark: brand indigo into the violet of the landing sky. */
export const BRAND_ACCENT = '#3b5bd4';
export const BRAND_GRADIENT = 'linear-gradient(145deg, #4a63e0 0%, #3b4fc8 55%, #5b3fc4 100%)';

/**
 * The mark on its tile, for Satori (next/og) — favicons, app icons, OG card.
 *
 * @param size     edge length in px of the rendered square
 * @param radius   corner radius in px; 0 for platforms that apply their own mask
 * @param glyph    the mark's share of the edge, 0-1. A maskable icon must keep
 *                 its content inside the central 80% circle, so it uses less.
 */
export function BrandTile({ size, radius, glyph }: { size: number; radius: number; glyph: number }) {
  const glyphPx = Math.round(size * glyph);
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundImage: BRAND_GRADIENT,
        borderRadius: radius,
      }}
    >
      <svg width={glyphPx} height={glyphPx} viewBox={MARK_VIEWBOX}>
        <path d={MARK_BODY_PATH} fill="#ffffff" fillRule="evenodd" />
        <path d={MARK_LEAF_PATH} fill="#ffffff" />
      </svg>
    </div>
  );
}
