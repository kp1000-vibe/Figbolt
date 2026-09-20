/**
 * Small, dependency-free NLP primitives.
 *
 * These back two things: the offline language engine, and the lexical half of
 * hybrid retrieval scoring that happens in application code (Postgres handles
 * the rest). Everything here is deterministic — the same input always produces
 * the same output, which is what makes the offline mode testable.
 */

const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being
   below between both but by can cannot could couldn't did didn't do does doesn't doing don't down
   during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her
   here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's
   its itself let's me more most mustn't my myself no nor not of off on once only or other ought our
   ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than
   that that's the their theirs them themselves then there there's these they they'd they'll they're
   they've this those through to too under until up very was wasn't we we'd we'll we're we've were
   weren't what what's when when's where where's which while who who's whom why why's with won't
   would wouldn't you you'd you'll you're you've your yours yourself yourselves just also get got
   really th`
    .split(/\s+/)
    .filter(Boolean),
);

/** Crude but stable suffix stripper — enough to unify plural/verb variants. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('sses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith('ment')) w = w.slice(0, -4);
  return w;
}

export function tokenize(text: string, options: { keepStopwords?: boolean } = {}): string[] {
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9'$%.\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  return raw
    .map((t) => t.replace(/^[-'.]+|[-'.]+$/g, ''))
    .filter((t) => t.length > 1)
    .filter((t) => options.keepStopwords || !STOPWORDS.has(t))
    .map(stem);
}

/** Sentence splitter that tolerates the abbreviations common in sales prose. */
export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/\b(Mr|Mrs|Ms|Dr|Inc|Ltd|Corp|Co|vs|e\.g|i\.e|etc|Jr|Sr|St|approx|No)\./gi, '$1<DOT>')
    .replace(/\b([A-Z])\./g, '$1<DOT>')
    .replace(/(\d)\.(\d)/g, '$1<DOT>$2');

  return protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z"'(‘“])|\n{2,}/)
    .map((s) => s.replace(/<DOT>/g, '.').trim())
    .filter((s) => s.length > 0);
}

export type TermStats = {
  /** document frequency by term */
  df: Map<string, number>;
  docCount: number;
  avgLength: number;
};

export function buildTermStats(documents: string[][]): TermStats {
  const df = new Map<string, number>();
  let total = 0;
  for (const doc of documents) {
    total += doc.length;
    for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return {
    df,
    docCount: documents.length,
    avgLength: documents.length ? total / documents.length : 1,
  };
}

/**
 * Okapi BM25. Chosen over plain tf-idf because CRM evidence varies enormously
 * in length — a two-line email should not lose to a 4,000-word transcript
 * purely on term count.
 */
export function bm25(
  queryTerms: string[],
  docTerms: string[],
  stats: TermStats,
  k1 = 1.5,
  b = 0.75,
): number {
  if (docTerms.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of docTerms) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of new Set(queryTerms)) {
    const f = tf.get(term);
    if (!f) continue;
    const n = stats.df.get(term) ?? 0;
    const idf = Math.log(1 + (stats.docCount - n + 0.5) / (n + 0.5));
    const norm = f * (k1 + 1);
    const denom = f + k1 * (1 - b + (b * docTerms.length) / (stats.avgLength || 1));
    score += idf * (norm / denom);
  }
  return score;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const mag = Math.sqrt(na) * Math.sqrt(nb);
  return mag === 0 ? 0 : dot / mag;
}

/** Jaccard overlap on stemmed terms — used for near-duplicate suppression. */
export function overlap(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Recency multiplier with a 60-day half-life. A pricing objection from last
 * week matters more than the same objection from last quarter.
 */
export function recencyWeight(occurredAt: Date | null | undefined, now = new Date()): number {
  if (!occurredAt) return 0.6;
  const days = (now.getTime() - occurredAt.getTime()) / 86_400_000;
  if (days < 0) return 1;
  return 0.35 + 0.65 * Math.pow(0.5, days / 60);
}

/** Sentence-level extractive selection against a query. */
export function selectSentences(
  text: string,
  queryTerms: string[],
  limit: number,
): { sentence: string; score: number; index: number }[] {
  const sentences = splitSentences(text);
  const docs = sentences.map((s) => tokenize(s));
  const stats = buildTermStats(docs);

  return sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: bm25(queryTerms, docs[index]!, stats),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index);
}

export function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  return words.length <= maxWords ? text : `${words.slice(0, maxWords).join(' ')}…`;
}

export function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Levenshtein-backed similarity for fuzzy name matching (0..1). */
export function nameSimilarity(a: string, b: string): number {
  const x = a.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const y = b.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;

  const m = x.length;
  const n = y.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return 1 - prev[n]! / Math.max(m, n);
}
