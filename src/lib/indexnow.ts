/**
 * IndexNow: tells Bing, Yandex and the engines that share their index (and
 * DuckDuckGo, which draws on Bing) that a public page changed, instead of
 * waiting for a crawl.
 *
 * The key is not a secret. The protocol proves ownership by serving it at
 * /<key>.txt, which is public/6b099778c77cd8a34e606147b850fd15.txt in this repo.
 *
 * Submit after a deploy that changes public pages:
 *   npx tsx scripts/indexnow.ts
 */
export const INDEXNOW_KEY = '6b099778c77cd8a34e606147b850fd15';
