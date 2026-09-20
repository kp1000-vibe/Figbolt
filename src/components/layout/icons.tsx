import type { IconName } from './nav';

/**
 * Inline icon set.
 *
 * Hand-drawn on a 24px grid rather than pulled from a package: the sidebar
 * needs exactly fifteen glyphs at one weight, and inlining them keeps the
 * client bundle free of an icon library and its tree-shaking caveats.
 */

const PATHS: Record<IconName, React.ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />,
  sparkles: (
    <>
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13h4l1.5 2.5h7L17 13h4" />
      <path d="M4.5 4h15l1.5 9v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" />
      <path d="M15 9h4a1 1 0 0 1 1 1v11" />
      <path d="M8 8h3M8 12h3M8 16h3M2.5 21h19" />
    </>
  ),
  users: (
    <>
      <path d="M15.5 20v-1.5a3.5 3.5 0 0 0-3.5-3.5H7a3.5 3.5 0 0 0-3.5 3.5V20" />
      <circle cx="9.5" cy="8" r="3.2" />
      <path d="M20.5 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M16 5.2a3.2 3.2 0 0 1 0 5.6" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  check: (
    <>
      <path d="M9 11l2.5 2.5L16 9" />
      <rect x="3.5" y="4" width="17" height="16.5" rx="2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="8" width="16" height="11" rx="2.5" />
      <path d="M12 4.5V8M9 13h.01M15 13h.01M9.5 16.5h5" />
      <circle cx="12" cy="3.5" r="1.2" />
    </>
  ),
  workflow: (
    <>
      <rect x="3" y="3.5" width="6.5" height="6" rx="1.5" />
      <rect x="14.5" y="14.5" width="6.5" height="6" rx="1.5" />
      <path d="M6.25 9.5v5a3 3 0 0 0 3 3h5.25" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V4M4 20h16" />
      <path d="M8 20v-6M12.5 20V9M17 20v-9.5" />
    </>
  ),
  signal: (
    <>
      <path d="M4 20a8 8 0 0 1 8-8M4 20a12 12 0 0 1 12-12" />
      <circle cx="4.5" cy="19.5" r="1.3" />
      <path d="M12 4a16 16 0 0 1 8 8" opacity="0.55" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A2 2 0 0 1 6 3.5h13v17H6a2 2 0 0 0-2 2z" />
      <path d="M4 5.5v15" />
      <path d="M8.5 8h6M8.5 11.5h6" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3v5M15 3v5" />
      <path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 17v4" />
    </>
  ),
  radar: (
    <>
      <path d="M12 12 16.9 7.1" />
      <path d="M12 3a9 9 0 1 0 9 9" />
      <path d="M12 7.5a4.5 4.5 0 1 0 4.5 4.5" />
      <circle cx="18.5" cy="5.5" r="1.6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.2 7l1.9 1.1M17.9 15.9l1.9 1.1M4.2 17l1.9-1.1M17.9 8.1l1.9-1.1" />
    </>
  ),
};

export function NavIcon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}

/* ── Standalone glyphs used across pages ──────────────────────────────────── */

type GlyphProps = { className?: string };

const glyph = (children: React.ReactNode, strokeWidth = 1.8) =>
  function Glyph({ className }: GlyphProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    );
  };

export const ChevronRight = glyph(<path d="m9 6 6 6-6 6" />);
export const ChevronDown = glyph(<path d="m6 9 6 6 6-6" />);
export const ChevronLeft = glyph(<path d="m15 6-6 6 6 6" />);
export const Plus = glyph(<path d="M12 5v14M5 12h14" />);
export const Search = glyph(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.6-3.6" />
  </>,
);
export const Close = glyph(<path d="M6 6l12 12M18 6 6 18" />);
export const Mail = glyph(
  <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3.5 6.5 8.5 6 8.5-6" />
  </>,
);
export const Phone = glyph(
  <path d="M5 3.5h3l1.5 4L7.8 9.2a11 11 0 0 0 5.5 5.5l1.7-1.7 4 1.5v3a2 2 0 0 1-2 2A15.5 15.5 0 0 1 3 5.5a2 2 0 0 1 2-2z" />,
);
export const Clock = glyph(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </>,
);
export const AlertTriangle = glyph(
  <>
    <path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 16.5h.01" />
  </>,
);
export const CheckCircle = glyph(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12 2.3 2.3 4.7-4.7" />
  </>,
);
export const Info = glyph(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" />
  </>,
);
export const ArrowUpRight = glyph(<path d="M7 17 17 7M9 7h8v8" />);
export const ArrowRight = glyph(<path d="M5 12h14M13 6l6 6-6 6" />);
export const TrendUp = glyph(
  <>
    <path d="M3 17l6-6 4 4 8-8" />
    <path d="M15 7h6v6" />
  </>,
);
export const TrendDown = glyph(
  <>
    <path d="M3 7l6 6 4-4 8 8" />
    <path d="M15 17h6v-6" />
  </>,
);
export const Link2 = glyph(
  <>
    <path d="M9 12h6" />
    <path d="M10.5 8H8a4 4 0 0 0 0 8h2.5M13.5 8H16a4 4 0 0 1 0 8h-2.5" />
  </>,
);
export const FileText = glyph(
  <>
    <path d="M14 3v5h5" />
    <path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z" />
    <path d="M8.5 13h7M8.5 16.5h4.5" />
  </>,
);
export const Play = glyph(<path d="M7 4.5v15l13-7.5z" />);
export const Pause = glyph(<path d="M8.5 5v14M15.5 5v14" />);
export const Sun = glyph(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2.5M12 19.5V22M4.2 4.2 6 6M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8" />
  </>,
);
export const Moon = glyph(<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />);
export const Monitor = glyph(
  <>
    <rect x="3" y="4" width="18" height="12.5" rx="2" />
    <path d="M8.5 20.5h7M12 16.5v4" />
  </>,
);
export const Sliders = glyph(
  <>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </>,
);
export const Shield = glyph(
  <>
    <path d="M12 3l7.5 3v5.5c0 4.6-3.1 8-7.5 9.5-4.4-1.5-7.5-4.9-7.5-9.5V6z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </>,
);
export const Users2 = glyph(
  <>
    <circle cx="8" cy="8" r="3" />
    <circle cx="17" cy="9.5" r="2.4" />
    <path d="M2.5 19.5a5.5 5.5 0 0 1 11 0M15 19.5a4 4 0 0 1 6.5-3.1" />
  </>,
);
export const Sparkle = glyph(
  <path d="M12 3l1.7 4.6L18.5 9.5 13.7 11.4 12 16l-1.7-4.6L5.5 9.5l4.8-1.9z" />,
);
export const Refresh = glyph(
  <>
    <path d="M20 11a8 8 0 0 0-13.7-4.9L3.5 8.5" />
    <path d="M4 13a8 8 0 0 0 13.7 4.9l2.8-2.4" />
    <path d="M3.5 4.5v4h4M20.5 19.5v-4h-4" />
  </>,
);
export const Trash = glyph(
  <>
    <path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13" />
    <path d="M10.5 11v5.5M13.5 11v5.5" />
  </>,
);
export const Copy = glyph(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
  </>,
);
export const Filter = glyph(<path d="M4 5h16l-6 7.5V20l-4-2v-5.5z" />);
export const Grid = glyph(
  <>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </>,
);
export const List = glyph(<path d="M4 6.5h16M4 12h16M4 17.5h16" />);
export const Menu = glyph(<path d="M4 7h16M4 12h16M4 17h16" />);
export const LogOut = glyph(
  <>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <path d="M10 8l-4 4 4 4M6 12h9" />
  </>,
);
export const Send = glyph(<path d="M4 12 20.5 4l-6 16.5-3.5-7z" />);
export const Quote = glyph(
  <path d="M8.5 6C6 7.5 4.5 10 4.5 13v5h6v-6H7.5c0-2 .5-3.5 2-4.5zM19 6c-2.5 1.5-4 4-4 7v5h6v-6h-3c0-2 .5-3.5 2-4.5z" />,
);
