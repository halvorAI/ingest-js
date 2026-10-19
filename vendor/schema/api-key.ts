import { createHash, randomInt } from 'node:crypto';

export type KeyEnv = 'test' | 'live';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY_PATTERN = /^hk_(test|live)_[0-9A-Za-z]{32}$/;

/** `hk_test_` or `hk_live_` plus 32 random base62 characters (about 190 bits). */
export function generateApiKey(env: KeyEnv): string {
  // randomInt is uniform, so there is no modulo bias.
  let body = '';
  for (let i = 0; i < 32; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return `hk_${env}_${body}`;
}

/** Returns the environment encoded in a well-formed key, or null. */
export function parseApiKey(key: string): { env: KeyEnv } | null {
  const match = KEY_PATTERN.exec(key);
  return match ? { env: match[1] as KeyEnv } : null;
}

/** What the database stores: sha256 of the full key, lowercase hex. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** The first 12 characters, shown in the dashboard to identify a key. */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, 12);
}
