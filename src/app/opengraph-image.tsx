import { ImageResponse } from 'next/og';
import { SITE } from '@/lib/seo';

/**
 * The link preview card, generated rather than checked in as a PNG.
 *
 * Generating it means the card cannot go stale against the tagline in
 * src/lib/seo.ts, which is the usual failure: someone changes the positioning
 * and the image keeps promising last quarter's.
 *
 * Satori (what next/og renders with) supports a subset of CSS and no `oklch()`,
 * so the design tokens are hard-coded as their hex equivalents here. They are
 * converted from the dark-theme tokens in globals.css — a dark card reads
 * better against both Slack themes than a near-white one.
 */

export const alt = `${SITE.name} — ${SITE.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const BG = '#0f1014';
const PANEL = '#16181d';
const BORDER = '#292b31';
const TEXT = '#f1f2f4';
const MUTED = '#a2a5aa';
const ACCENT = '#3b5bd4';
const ACCENT_LIGHT = '#6e91fa';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: BG,
          // A single accent wash, so the card reads as one object rather than a
          // gradient for its own sake.
          backgroundImage: `radial-gradient(1000px 500px at 12% -10%, ${PANEL}, ${BG})`,
          padding: 72,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 68,
              height: 68,
              borderRadius: 18,
              background: ACCENT,
            }}
          >
            <svg width="38" height="38" viewBox="0 0 24 24">
              <path d="M13.5 2.5 6 13.2h4.6L9.8 21.5 18 10.4h-4.9z" fill="#ffffff" />
            </svg>
          </div>
          <div style={{ fontSize: 44, fontWeight: 700, color: TEXT, letterSpacing: -1 }}>
            {SITE.name}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          <div
            style={{
              fontSize: 76,
              fontWeight: 700,
              color: TEXT,
              letterSpacing: -2.5,
              lineHeight: 1.05,
              maxWidth: 880,
            }}
          >
            The CRM nobody has to fill in.
          </div>
          <div style={{ fontSize: 31, color: MUTED, lineHeight: 1.45, maxWidth: 900 }}>
            Figbolt builds the record from your email, meetings and tickets. Bolt answers
            with the evidence. Humans approve anything consequential.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: `1px solid ${BORDER}`,
            paddingTop: 28,
          }}
        >
          <div style={{ fontSize: 27, color: ACCENT_LIGHT, fontWeight: 600 }}>
            {SITE.tagline}
          </div>
          <div style={{ fontSize: 25, color: MUTED }}>figbolt.com</div>
        </div>
      </div>
    ),
    size,
  );
}
