import { CompactSign, compactVerify, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';

export type { JWK };
import { canonicalize } from './canonical.js';

/** Header values fixed by `specs/02-ape-schema.md` §2. */
const HEADER_TYP = 'ape+jws';
const APE_VERSION = '0.1';

export interface SourceKeyPair {
  privateJwk: JWK;
  publicJwk: JWK;
}

export async function generateSourceKeyPair(): Promise<SourceKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  return { privateJwk: await exportJWK(privateKey), publicJwk: await exportJWK(publicKey) };
}

function sourceId(event: object): string {
  const id = (event as { source?: { id?: unknown } }).source?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('event.source.id is required to sign an event');
  }
  return id;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Signs the JCS form of an APE event with the source's Ed25519 key and returns a compact JWS
 * with a detached payload (`<header>..<signature>`). The header `kid` is `event.source.id`.
 */
export async function signEvent(event: object, privateJwk: JWK): Promise<string> {
  const key = await importJWK(privateJwk, 'EdDSA');
  const compact = await new CompactSign(encode(canonicalize(event)))
    .setProtectedHeader({ alg: 'EdDSA', kid: sourceId(event), typ: HEADER_TYP, ape: APE_VERSION })
    .sign(key);
  const [header, , signature] = compact.split('.');
  return `${header}..${signature}`;
}

/** Returns true only for a valid detached APE JWS over this exact event. Never throws. */
export async function verifyEvent(event: object, sig: string, publicJwk: JWK): Promise<boolean> {
  try {
    const parts = sig.split('.');
    const [header, payload, signature] = parts;
    if (parts.length !== 3 || !header || payload !== '' || !signature) return false;

    const key = await importJWK(publicJwk, 'EdDSA');
    const attached = `${header}.${Buffer.from(encode(canonicalize(event))).toString('base64url')}.${signature}`;
    const { protectedHeader } = await compactVerify(attached, key, { algorithms: ['EdDSA'] });

    return (
      protectedHeader.typ === HEADER_TYP &&
      protectedHeader['ape'] === APE_VERSION &&
      protectedHeader.kid === sourceId(event)
    );
  } catch {
    return false;
  }
}
