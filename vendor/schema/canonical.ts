export class CanonicalError extends Error {
  override readonly name = 'CanonicalError';
}

/**
 * JSON Canonicalization Scheme (RFC 8785). JSON.stringify already emits the JCS number and
 * string forms (ECMAScript serialisation); this adds sorted keys and rejects non-JSON values.
 * Properties whose value is undefined are dropped, as JSON.stringify would drop them.
 */
export function canonicalize(value: unknown): string {
  const out = serialise(value);
  if (out === undefined) throw new CanonicalError('value is not JSON');
  return out;
}

function serialise(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalError('numbers must be finite');
      return JSON.stringify(value);
    case 'undefined':
      return undefined;
    case 'object':
      break;
    default:
      throw new CanonicalError(`cannot canonicalise a ${typeof value}`);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const s = serialise(item);
      if (s === undefined) throw new CanonicalError('arrays cannot contain undefined');
      return s;
    });
    return `[${items.join(',')}]`;
  }

  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalError('only plain objects are allowed');
  }

  // Default sort compares UTF-16 code units, which is the order RFC 8785 requires.
  const keys = Object.keys(value).sort();
  const members: string[] = [];
  for (const key of keys) {
    const s = serialise((value as Record<string, unknown>)[key]);
    if (s !== undefined) members.push(`${JSON.stringify(key)}:${s}`);
  }
  return `{${members.join(',')}}`;
}
