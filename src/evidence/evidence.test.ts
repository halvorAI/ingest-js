import { evidenceSha256 } from '@halvorai/schema';
import { describe, expect, it } from 'vitest';
import { ap2, sdJwtFormat, tap, vi } from './helpers.js';

const SD_JWT =
  'eyJhbGciOiJFUzI1NiIsInR5cCI6InZjK3NkLWp3dCJ9.eyJ2Y3QiOiJtYW5kYXRlLnBheW1lbnQuMSJ9.sig~disclosure1~';
const KB_SD_JWT =
  'eyJhbGciOiJFUzI1NiIsInR5cCI6InZjK3NkLWp3dCJ9.eyJ2Y3QiOiJtYW5kYXRlLnBheW1lbnQub3Blbi4xIn0.sig~d1~eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL2V4YW1wbGUuY29tIn0.kbsig';

describe('sdJwtFormat', () => {
  it('classifies trailing-tilde as sd-jwt', () => {
    expect(sdJwtFormat(SD_JWT)).toBe('sd-jwt');
  });

  it('classifies key-binding presentation as kb-sd-jwt', () => {
    expect(sdJwtFormat(KB_SD_JWT)).toBe('kb-sd-jwt');
  });
});

describe('ap2 helpers', () => {
  it('paymentMandate packages with correct sha256', () => {
    const item = ap2.paymentMandate(KB_SD_JWT);
    expect(item.kind).toBe('ap2.payment_mandate');
    expect(item.format).toBe('kb-sd-jwt');
    expect(item.value).toBe(KB_SD_JWT);
    expect(item.sha256).toBe(evidenceSha256(KB_SD_JWT));
  });

  it('checkoutMandate packages with correct sha256', () => {
    const item = ap2.checkoutMandate(SD_JWT);
    expect(item.kind).toBe('ap2.checkout_mandate');
    expect(item.format).toBe('sd-jwt');
    expect(item.sha256).toBe(evidenceSha256(SD_JWT));
  });
});

describe('vi.chain', () => {
  it('packages tilde-joined chain with correct sha256', () => {
    const chain = `${KB_SD_JWT}~L2~L3a~L3b`;
    const item = vi.chain(chain);
    expect(item.kind).toBe('vi.chain');
    expect(item.format).toBe('kb-sd-jwt');
    expect(item.sha256).toBe(evidenceSha256(chain));
  });
});

describe('tap.fromRequest', () => {
  it('packages Signature-Input / Signature with correct object sha256', () => {
    const signatureInput =
      'sig2=("@authority" "@path");created=1792231364;keyId="tap-key";alg="ed25519";tag="agent-payer-auth"';
    const signature = 'sig2=:abc=:';
    const item = tap.fromRequest({
      headers: {
        'Signature-Input': signatureInput,
        Signature: signature,
      },
      url: 'https://example-airways.com/checkout',
    });
    expect(item.kind).toBe('tap.signature');
    expect(item.format).toBe('http-signature');
    expect(item.value).toEqual({
      signature_input: signatureInput,
      signature,
      components: {
        '@authority': 'example-airways.com',
        '@path': '/checkout',
      },
    });
    expect(item.sha256).toBe(evidenceSha256(item.value as Record<string, unknown>));
  });

  it('reads Headers objects', () => {
    const headers = new Headers({
      'Signature-Input': 'sig1=("@path")',
      Signature: 'sig1=:x=:',
    });
    const item = tap.fromRequest({
      headers,
      components: { '@authority': 'pay.example', '@path': '/v1/pay' },
    });
    const value = item.value as Record<string, unknown>;
    expect(value['signature_input']).toBe('sig1=("@path")');
    expect(value['components']).toEqual({
      '@authority': 'pay.example',
      '@path': '/v1/pay',
    });
    expect(item.sha256).toBe(evidenceSha256(value));
  });
});
