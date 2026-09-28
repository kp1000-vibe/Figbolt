import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeScript } from '@/components/layout/theme';
import { SITE } from '@/lib/seo';

/**
 * Metadata defaults for every route.
 *
 * `robots: { index: false, follow: false }` is deliberate and load-bearing: all
 * but one route in this app is somebody's customer data behind a session. Pages
 * opt *in* to being indexed, and today only the landing page does. See
 * src/lib/seo.ts.
 *
 * metadataBase is what lets the pages below use relative OG image and canonical
 * paths; without it a relative URL in a metadata field is a build error.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: `${SITE.name} — ${SITE.tagline.toLowerCase()}`, template: `%s · ${SITE.name}` },
  description: SITE.description,
  applicationName: SITE.name,
  robots: { index: false, follow: false },
  // Telephone autodetection rewrites deal amounts and IDs into phone links on
  // iOS, which looks broken in a CRM.
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fcfcfd' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1d22' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      {/*
        suppressHydrationWarning: extensions (password managers, dark-mode
        and grammar tools) commonly inject style attributes such as
        `isolation: isolate` onto <body> before React hydrates. That is a
        mismatch we cannot prevent and do not care about; it suppresses
        attribute warnings for this element only, not for its children.
      */}
      <body className="min-h-dvh antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
