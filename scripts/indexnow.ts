/**
 * Submit every public page to IndexNow. Run after deploying public-page changes:
 *   npx tsx scripts/indexnow.ts
 * Only the URLs in PUBLIC_ROUTES are ever sent — never an app route.
 */
import { INDEXNOW_KEY } from '../src/lib/indexnow';
import { absoluteUrl, PUBLIC_ROUTES, SITE } from '../src/lib/seo';

async function main() {
  const host = new URL(SITE.url).host;
  const urlList = PUBLIC_ROUTES.map((r) => absoluteUrl(r));
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host,
      key: INDEXNOW_KEY,
      keyLocation: `${SITE.url}/${INDEXNOW_KEY}.txt`,
      urlList,
    }),
  });
  // 200 and 202 both mean accepted.
  console.log(`IndexNow ${res.status} ${res.statusText} for ${urlList.length} URLs:`);
  for (const u of urlList) console.log(`  ${u}`);
  if (res.status >= 300) {
    console.log(await res.text());
    process.exit(1);
  }
}

main();
