import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '@/lib/env';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * scrypt from Node's standard library: memory-hard, no native build step, and
 * the parameters travel with the hash so they can be raised later without
 * invalidating existing credentials.
 */
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p } = SCRYPT_PARAMS;
  const derived = await scrypt(password.normalize('NFKC'), salt, 64, SCRYPT_PARAMS);
  return ['scrypt', N, r, p, salt.toString('base64url'), derived.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(hashB64, 'base64url');
  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Compare two strings without leaking length-independent timing information. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** One-way, salted hash for IPs written to the audit log. Not reversible. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`nexus-ip:${ip}`).digest('hex').slice(0, 32);
}

/* ── Envelope encryption for integration credentials ──────────────────────── */

const AAD = Buffer.from('nexus:integration-token:v1');

function encryptionKey(): Buffer {
  const raw = env.INTEGRATION_TOKEN_KEY;
  if (!raw) {
    if (env.NODE_ENV === 'production') {
      throw new Error('INTEGRATION_TOKEN_KEY is required to store integration credentials.');
    }
    // Deterministic dev key so a restart doesn't orphan locally stored tokens.
    return createHash('sha256').update('nexus-dev-integration-key').digest();
  }
  const key = Buffer.from(raw, 'base64url');
  if (key.length !== 32) {
    throw new Error('INTEGRATION_TOKEN_KEY must decode to exactly 32 bytes (base64url).');
  }
  return key;
}

/**
 * AES-256-GCM with a random IV per record and an authentication tag, so a
 * tampered ciphertext fails to decrypt rather than yielding garbage.
 * Format: `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv, { authTagLength: 16 });
  cipher.setAAD(AAD);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join(
    '.',
  );
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted payload.');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivB64, 'base64url'),
    { authTagLength: 16 },
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** HMAC-SHA256 hex digest, used for webhook signature verification. */
export async function hmacSha256(secret: string, body: string): Promise<string> {
  const { createHmac } = await import('node:crypto');
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string,
  timestamp?: string,
): Promise<boolean> {
  // Reject replays outside a five-minute window before doing any crypto.
  if (timestamp) {
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > 300) return Promise.resolve(false);
  }
  const payload = timestamp ? `${timestamp}.${body}` : body;
  return hmacSha256(secret, payload).then((expected) => safeEqual(expected, signature));
}
