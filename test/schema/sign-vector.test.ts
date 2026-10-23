import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalize, signEvent, verifyEvent, type JWK } from '../../vendor/schema/index.js';

const vectorPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sign-vector.json');

interface SignVector {
  event: object;
  private_jwk: JWK;
  public_jwk: JWK;
  canonical_jcs: string;
  sig: string;
}

function loadVector(): SignVector {
  return JSON.parse(readFileSync(vectorPath, 'utf8')) as SignVector;
}

describe('P1.3 / P3.7 cross-language sign vector', () => {
  it('canonical JCS matches the committed vector', () => {
    const v = loadVector();
    expect(canonicalize(v.event)).toBe(v.canonical_jcs);
  });

  it('verifies the committed signature', async () => {
    const v = loadVector();
    expect(await verifyEvent(v.event, v.sig, v.public_jwk)).toBe(true);
  });

  it('re-signing in TypeScript reproduces the same detached JWS', async () => {
    const v = loadVector();
    const sig = await signEvent(v.event, v.private_jwk);
    expect(sig).toBe(v.sig);
  });
});
