import type { Metadata } from 'next';
import { GuidePage } from '@/components/marketing/guide-page';
import { guideFor } from '@/lib/guides';
import { absoluteUrl, SITE } from '@/lib/seo';

const guide = guideFor('/crm-for-solopreneurs');

export const metadata: Metadata = {
  // The guide's own title is complete; skip the root "· Figbolt" template.
  title: { absolute: guide.title },
  description: guide.description,
  keywords: guide.keywords,
  robots: { index: true, follow: true },
  alternates: { canonical: guide.path },
  openGraph: {
    type: 'article',
    url: absoluteUrl(guide.path),
    siteName: SITE.name,
    title: guide.title,
    description: guide.description,
    locale: SITE.locale,
  },
  twitter: { card: 'summary_large_image', title: guide.title, description: guide.description },
};

export default function Page() {
  return <GuidePage guide={guide} />;
}
