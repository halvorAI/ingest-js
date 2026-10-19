import { evidenceSha256 } from '@halvorai/schema';

/** Evidence item ready for `halvor.emit({ …, evidence: […] })`. */
export interface PackagedEvidence {
  kind: 'ap2.payment_mandate' | 'ap2.checkout_mandate' | 'vi.chain' | 'tap.signature';
  format: 'sd-jwt' | 'kb-sd-jwt' | 'http-signature';
  value: string | Record<string, unknown>;
  sha256: `sha256:${string}`;
}

/** Detect SD-JWT vs key-binding SD-JWT from the wire encoding. */
export function sdJwtFormat(value: string): 'sd-jwt' | 'kb-sd-jwt' {
  if (!value.includes('~') || value.endsWith('~')) return 'sd-jwt';
  const last = value.split('~').pop() ?? '';
  return last.split('.').length === 3 ? 'kb-sd-jwt' : 'sd-jwt';
}

function headerGet(
  headers:
    Headers | Record<string, string | string[] | undefined> | { get(name: string): string | null },
  name: string,
): string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    const v = (headers as { get(name: string): string | null }).get(name);
    if (v !== null && v !== undefined && v.length > 0) return v;
    const lower = (headers as { get(name: string): string | null }).get(name.toLowerCase());
    return lower !== null && lower !== undefined && lower.length > 0 ? lower : undefined;
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  const direct = rec[name] ?? rec[name.toLowerCase()];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];
  return undefined;
}

export interface TapRequestLike {
  headers:
    Headers | Record<string, string | string[] | undefined> | { get(name: string): string | null };
  url?: string | URL;
  /** Override or supplement signed components when the request URL is incomplete. */
  components?: Record<string, string>;
}

function componentsFromUrl(url: string | URL | undefined): Record<string, string> {
  if (url === undefined) return {};
  try {
    const u = typeof url === 'string' ? new URL(url, 'https://placeholder.local') : url;
    const out: Record<string, string> = {
      '@authority': u.host,
      '@path': u.pathname,
    };
    if (u.search.length > 1) out['@query'] = u.search.slice(1);
    return out;
  } catch {
    return {};
  }
}

/** AP2 mandate packaging (hash only; verification is server-side). */
export const ap2 = {
  paymentMandate(sdJwt: string): PackagedEvidence {
    return {
      kind: 'ap2.payment_mandate',
      format: sdJwtFormat(sdJwt),
      value: sdJwt,
      sha256: evidenceSha256(sdJwt),
    };
  },
  checkoutMandate(sdJwt: string): PackagedEvidence {
    return {
      kind: 'ap2.checkout_mandate',
      format: sdJwtFormat(sdJwt),
      value: sdJwt,
      sha256: evidenceSha256(sdJwt),
    };
  },
};

/** Mastercard Verifiable Intent presentation packaging. */
export const vi = {
  chain(presentation: string): PackagedEvidence {
    return {
      kind: 'vi.chain',
      format: 'kb-sd-jwt',
      value: presentation,
      sha256: evidenceSha256(presentation),
    };
  },
};

/** Visa TAP HTTP Message Signature packaging from a request. */
export const tap = {
  fromRequest(req: TapRequestLike): PackagedEvidence {
    const signatureInput = headerGet(req.headers, 'Signature-Input') ?? '';
    const signature = headerGet(req.headers, 'Signature') ?? '';
    const components: Record<string, string> = {
      ...componentsFromUrl(req.url),
      ...(req.components ?? {}),
    };
    const value: Record<string, unknown> = {
      signature_input: signatureInput,
      signature,
      components,
    };
    return {
      kind: 'tap.signature',
      format: 'http-signature',
      value,
      sha256: evidenceSha256(value),
    };
  },
};
