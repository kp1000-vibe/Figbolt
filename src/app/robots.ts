import type { MetadataRoute } from 'next';
import { absoluteUrl, PRIVATE_PREFIXES } from '@/lib/seo';

/**
 * robots.txt
 *
 * Allow the landing page; disallow every route that holds a session or
 * someone's customer data. Disallow matches by prefix, so `/accounts` covers
 * `/accounts/acc_123` too.
 *
 * This is belt and braces with the root layout's `robots: { index: false }`
 * default: a meta tag only helps if the crawler renders the page, and these
 * routes would serve it a redirect to the login screen anyway. The explicit
 * list is what keeps workspace URLs out of an index.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [...PRIVATE_PREFIXES],
    },
    sitemap: absoluteUrl('/sitemap.xml'),
    host: SITE_HOST,
  };
}

const SITE_HOST = absoluteUrl('/').replace(/\/$/, '');
