import canonicalizeModule from 'canonicalize';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize, CanonicalError } from '../../vendor/schema/canonical.js';

// The oracle ships CommonJS; unwrap its default export for NodeNext typing.
const oracle = ((canonicalizeModule as unknown as { default?: unknown }).default ??
  canonicalizeModule) as (input: unknown) => string | undefined;

describe('canonicalize (RFC 8785)', () => {
  it('matches the RFC 8785 section 3.2.4 sorting and string examples', () => {
    const input = {
      numbers: [333333333.3333333, 1e30, 4.5, 0.002, 1e-27],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units, not locale', () => {
    expect(canonicalize({ b: 1, a: 2, 'é': 3, Z: 4, '€': 5 })).toBe(
      '{"Z":4,"a":2,"b":1,"é":3,"€":5}',
    );
    // U+10000 (surrogates D800 DC00) sorts before U+E000.
    expect(canonicalize({ '': 1, '\u{10000}': 2 })).toBe('{"\u{10000}":2,"":1}');
  });

  it('is independent of key order and agrees with the reference implementation', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(canonicalize(value)).toBe(oracle(value));
      }),
    );
  });

  it('serialises -0 as 0 and drops undefined properties like JSON', () => {
    expect(canonicalize({ a: -0, b: undefined, c: 1 })).toBe('{"a":0,"c":1}');
  });

  it('rejects values that are not JSON', () => {
    for (const bad of [undefined, () => 1, 10n, NaN, Infinity, new Date(), new Map()]) {
      expect(() => canonicalize(bad)).toThrow(CanonicalError);
    }
    expect(() => canonicalize({ a: [undefined] })).toThrow(CanonicalError);
  });
});
