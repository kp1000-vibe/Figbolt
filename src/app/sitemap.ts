import type { MetadataRoute } from 'next';
import { absoluteUrl, PUBLIC_ROUTES } from '@/lib/seo';

/**
 * sitemap.xml
 *
 * Only the routes in PUBLIC_ROUTES, which today is the landing page. A CRM's
 * real routes are per-workspace and behind a session; listing them would be
 * both useless to a crawler and a disclosure of customer URLs.
 *
 * lastModified is the build time rather than `new Date()` at request time: a
 * sitemap that claims every page changed one second ago teaches crawlers to
 * ignore the field.
 */
const BUILT_AT = new Date();

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_ROUTES.map((route) => ({
    url: absoluteUrl(route),
    lastModified: BUILT_AT,
    changeFrequency: 'weekly' as const,
    priority: route === '/' ? 1 : 0.7,
  }));
}
