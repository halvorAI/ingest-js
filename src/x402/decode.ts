/** Decode a base64 (std or URL-safe) JSON header value. Throws on bad input. */
export function decodePaymentHeader<T = Record<string, unknown>>(header: string): T {
  const trimmed = header.trim();
  if (trimmed.length === 0) throw new Error('empty payment header');
  const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4));
  let json: string;
  try {
    json = Buffer.from(pad, 'base64').toString('utf8');
  } catch {
    throw new Error('payment header is not valid base64');
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error('payment header is not valid JSON');
  }
}

/** Encode an object as a base64 JSON header (for fixtures and tests). */
export function encodePaymentHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function headerGet(headers: Headers, name: string): string | null {
  return headers.get(name) ?? headers.get(name.toLowerCase());
}
