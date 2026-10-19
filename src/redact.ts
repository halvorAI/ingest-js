export interface ExtraPattern {
  pattern: RegExp;
  label?: string;
}

export interface RedactOptions {
  extraPatterns?: Array<ExtraPattern | RegExp>;
}

const MAX_DEPTH = 64;

const SECRET_KEY = /\b(?:sk_live_|sk_test_|rk_live_|whsec_|hk_live_|hk_test_)[0-9A-Za-z]+\b/g;

const PEM_PRIVATE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const JWK_D = /"d"\s*:\s*"[^"]*"/g;

const CVC = /\b(cvc|cvv2?|security code)("\s*:\s*"|\s*[:=]\s*|\s+)(\d{3,4})(")?/gi;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactPan(text: string): string {
  return text.replace(/\d(?:[ -]?\d)*/g, (run) => {
    const digits = run.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      return '[redacted:pan]';
    }
    return run;
  });
}

function applyExtra(text: string, extras: RedactOptions['extraPatterns']): string {
  if (!extras) return text;
  let out = text;
  for (const item of extras) {
    if (item instanceof RegExp) {
      const flags = item.flags.includes('g') ? item.flags : `${item.flags}g`;
      out = out.replace(new RegExp(item.source, flags), '[redacted]');
    } else {
      const flags = item.pattern.flags.includes('g')
        ? item.pattern.flags
        : `${item.pattern.flags}g`;
      const label = item.label ?? '';
      const replacement = label.length > 0 ? `[redacted:${label}]` : '[redacted]';
      out = out.replace(new RegExp(item.pattern.source, flags), replacement);
    }
  }
  return out;
}

/** Strip PANs, CVCs, secret keys and private keys from a string. */
export function redactText(text: string, options: RedactOptions = {}): string {
  let out = text;
  out = out.replace(PEM_PRIVATE, '[redacted:private-key]');
  out = out.replace(SECRET_KEY, '[redacted:secret-key]');
  out = out.replace(JWK_D, '"d":"[redacted:private-key]"');
  out = redactPan(out);
  out = out.replace(
    CVC,
    (_m, label: string, sep: string, _digits: string, quote: string | undefined) => {
      return `${label}${sep}[redacted:cvc]${quote ?? ''}`;
    },
  );
  out = applyExtra(out, options.extraPatterns);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isPrivateJwk(value: Record<string, unknown>): boolean {
  return typeof value['kty'] === 'string' && typeof value['d'] === 'string';
}

function walk(
  value: unknown,
  options: RedactOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') return redactText(value, options);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, options, seen, depth + 1));
  }

  if (!isPlainObject(value)) return value;
  if (isPrivateJwk(value)) return '[redacted:private-key]';

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'function') continue;
    out[key] = walk(child, options, seen, depth + 1);
  }
  return out;
}

/** Deep-clone while redacting every string. Never mutates the input. */
export function redactDeep<T>(value: T, options: RedactOptions = {}): T {
  return walk(value, options, new WeakSet(), 0) as T;
}
