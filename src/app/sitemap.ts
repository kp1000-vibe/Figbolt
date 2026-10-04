import type { MetadataRoute } from 'next';
import { absoluteUrl, CONTENT_UPDATED, PUBLIC_ROUTES } from '@/lib/seo';

/**
 * sitemap.xml
 *
 * Only the routes in PUBLIC_ROUTES. A CRM's real routes are per-workspace and
 * behind a session; listing them would be both useless to a crawler and a
 * disclosure of customer URLs.
 *
 * lastModified is when each page's content actually changed (CONTENT_UPDATED),
 * not the build or request time: a sitemap that claims every page changed at
 * each deploy teaches crawlers to ignore the field.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_ROUTES.map((route) => ({
    url: absoluteUrl(route),
    lastModified: new Date(`${CONTENT_UPDATED[route]}T00:00:00Z`),
    changeFrequency: route === '/' ? ('weekly' as const) : ('monthly' as const),
    priority: route === '/' ? 1 : 0.8,
  }));
}
