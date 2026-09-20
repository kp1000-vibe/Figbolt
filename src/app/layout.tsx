import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeScript } from '@/components/layout/theme';

export const metadata: Metadata = {
  title: { default: 'Nexus CRM', template: '%s · Nexus' },
  description:
    'An agent-native CRM. Nexus captures customer interactions, turns them into structured knowledge, and lets AI agents act on that history with humans in control.',
  applicationName: 'Nexus CRM',
  robots: { index: false, follow: false },
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
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
