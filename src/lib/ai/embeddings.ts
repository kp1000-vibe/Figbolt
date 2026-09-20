import { createHash } from 'node:crypto';
import { ModelError, type EmbeddingModel } from './types';
import { stem, tokenize } from './local/nlp';

/**
 * Deterministic local embeddings.
 *
 * A hashed bag-of-features projection: unigrams, bigrams and character
 * trigrams are hashed into a fixed-width vector with sub-linear term weighting,
 * then L2-normalised. This is not a neural embedding and will not capture
 * paraphrase the way a trained model does — but it is a real vector space with
 * meaningful cosine geometry, so semantic search, HNSW indexing and the whole
 * retrieval pipeline behave correctly with no API key and no network.
 *
 * Set `EMBEDDING_PROVIDER=openai` for true semantic embeddings; the vector
 * width must match `EMBEDDING_DIMENSIONS` and the schema's `vector(768)`.
 */
export class LocalEmbeddingModel implements EmbeddingModel {
  readonly id = 'nexus-local-hash-v1';

  constructor(readonly dimensions: number) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vec = new Float64Array(this.dimensions);
    const terms = tokenize(text, { keepStopwords: false });
    if (terms.length === 0) return Array.from(vec);

    const counts = new Map<string, number>();
    const bump = (feature: string, weight: number) => {
      counts.set(feature, (counts.get(feature) ?? 0) + weight);
    };

    for (let i = 0; i < terms.length; i++) {
      const term = terms[i]!;
      bump(`u:${term}`, 1);
      // Bigrams give the space a little word-order sensitivity, which matters
      // for phrases like "security review" vs "review security".
      if (i + 1 < terms.length) bump(`b:${term}_${terms[i + 1]}`, 0.6);
      // Character trigrams absorb typos and morphological variants.
      const padded = `#${term}#`;
      for (let j = 0; j + 3 <= padded.length; j++) {
        bump(`c:${padded.slice(j, j + 3)}`, 0.22);
      }
    }

    for (const [feature, count] of counts) {
      // Sub-linear scaling stops a repeated word from dominating the vector.
      const weight = 1 + Math.log(count);
      // Two independent hashes per feature reduce collision artefacts.
      for (let k = 0; k < 2; k++) {
        const h = hash32(`${feature}|${k}`);
        const index = h % this.dimensions;
        const sign = (h >>> 31) & 1 ? -1 : 1;
        vec[index] = vec[index]! + sign * weight;
      }
    }

    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return Array.from(vec);

    const out = new Array<number>(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) out[i] = Number((vec[i]! / norm).toFixed(6));
    return out;
  }
}

function hash32(value: string): number {
  // FNV-1a: fast, stable across processes, good enough dispersion for hashing
  // features into buckets.
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class OpenAiEmbeddingModel implements EmbeddingModel {
  readonly id = 'text-embedding-3-small';

  constructor(
    private readonly apiKey: string,
    readonly dimensions: number,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];

    // The endpoint caps inputs per request; batch rather than fail on large jobs.
    for (let i = 0; i < texts.length; i += 96) {
      const batch = texts.slice(i, i + 96);
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.id,
          input: batch.map((t) => t.slice(0, 30_000)),
          dimensions: this.dimensions,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        throw new ModelError(
          `Embedding request failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300),
          'openai',
          res.status === 429 || res.status >= 500,
        );
      }
      const json = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
      const sorted = (json.data ?? []).sort((a, b) => a.index - b.index);
      out.push(...sorted.map((d) => d.embedding));
    }
    return out;
  }
}

/** Format a JS vector for a pgvector literal. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Chunk long text on paragraph boundaries with a small overlap so a sentence
 * split across a boundary is still retrievable from one chunk.
 */
export function chunkText(
  text: string,
  options: { maxChars?: number; overlapChars?: number } = {},
): { content: string; index: number }[] {
  const maxChars = options.maxChars ?? 1400;
  const overlap = options.overlapChars ?? 180;
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= maxChars) return clean ? [{ content: clean, index: 0 }] : [];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks: { content: string; index: number }[] = [];
  let buffer = '';

  const flush = () => {
    const content = buffer.trim();
    if (content) chunks.push({ content, index: chunks.length });
    buffer = content.length > overlap ? `${content.slice(-overlap)}\n\n` : '';
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      // A single oversized paragraph: split on sentences instead.
      for (const sentence of para.split(/(?<=[.!?])\s+/)) {
        if (buffer.length + sentence.length > maxChars) flush();
        buffer += `${sentence} `;
      }
      continue;
    }
    if (buffer.length + para.length > maxChars) flush();
    buffer += `${para}\n\n`;
  }
  flush();

  return chunks.filter((c) => c.content.length > 20).map((c, index) => ({ ...c, index }));
}

export { stem };
