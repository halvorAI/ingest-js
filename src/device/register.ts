import type { JWK } from '@halvorai/schema';
import { postSource, SourceRegistrationError } from '../sources.js';
import { DeviceRequestError, resolveDeviceConfig, type DeviceConfig } from './config.js';

export interface RegisterDeviceSourceOptions extends DeviceConfig {
  /** The public half of the app install's key, as the app sent it. */
  publicJwk: unknown;
  /** A label for the source in the dashboard, such as the app and platform (cut to 100). */
  name?: string;
}

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

/**
 * Checks that [jwk] is the public half of an Ed25519 key and returns only `kty`, `crv` and `x`.
 * A key that has `d` is refused: the app sent its private key, which must never leave the device.
 */
export function publicDeviceJwk(jwk: unknown): JWK {
  if (jwk === null || typeof jwk !== 'object' || Array.isArray(jwk)) {
    throw new DeviceRequestError(400, 'invalid_request', 'public_jwk must be a JSON object');
  }
  const key = jwk as Record<string, unknown>;
  if ('d' in key) {
    throw new DeviceRequestError(
      400,
      'invalid_request',
      'public_jwk contains a private key (d); only the public half may be sent',
    );
  }
  if (key['kty'] !== 'OKP' || key['crv'] !== 'Ed25519') {
    throw new DeviceRequestError(400, 'invalid_request', 'public_jwk must be an Ed25519 key');
  }
  const x = key['x'];
  if (typeof x !== 'string' || !BASE64URL_32_BYTES.test(x)) {
    throw new DeviceRequestError(400, 'invalid_request', 'public_jwk.x must be 32 bytes, base64url');
  }
  return { kty: 'OKP', crv: 'Ed25519', x };
}

/**
 * Registers an app install's public key as a HalvorAI source and returns the `src_` id the app
 * signs with. Call it from the route your app's provisioning request reaches, after checking the
 * user is signed in.
 *
 * Throws [DeviceRequestError] for a key the app should not have sent (400), and when HalvorAI
 * does not register it (502, so the app retries later).
 */
export async function registerDeviceSource(
  options: RegisterDeviceSourceOptions,
): Promise<{ sourceId: string }> {
  const config = resolveDeviceConfig(options);
  const publicJwk = publicDeviceJwk(options.publicJwk);
  const name = (typeof options.name === 'string' ? options.name.trim() : '') || 'app install';
  try {
    const sourceId = await postSource(
      config.fetch,
      config.endpoint,
      config.apiKey,
      name.slice(0, 100),
      publicJwk,
    );
    return { sourceId };
  } catch (err) {
    if (!(err instanceof SourceRegistrationError)) throw err;
    throw new DeviceRequestError(502, 'upstream_error', err.message);
  }
}

