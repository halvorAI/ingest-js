/**
 * ape-schema conformance data: the same verdicts and bytes as every other APE implementation.
 * The files in test/fixtures/conformance are copied from
 * https://github.com/halvorAI/ape-schema/tree/main/conformance. Refresh them when the schema changes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApeEventSchema } from '../../vendor/schema/ape.js';
import { canonicalize } from '../../vendor/schema/canonical.js';

const read = <T>(name: string): T =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/conformance/${name}`, import.meta.url), 'utf8'),
  ) as T;

interface Case {
  name: string;
  expect: 'valid' | 'invalid';
  rule?: 'schema' | 'pan';
  event: unknown;
}
const { cases } = read<{ cases: Case[] }>('events.json');
const jcs = read<{
  numbers: { bits: string; expected: string }[];
  objects: { json: string; expected: string }[];
}>('jcs-vectors.json');

function verdict(event: unknown): 'valid' | 'schema' | 'pan' {
  const result = ApeEventSchema.safeParse(event);
  if (result.success) return 'valid';
  return result.error.issues.some((i) => i.message === 'pan_detected') ? 'pan' : 'schema';
}

describe('events.json', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(verdict(c.event)).toBe(c.expect === 'valid' ? 'valid' : c.rule);
  });
});

describe('jcs-vectors.json', () => {
  it.each(jcs.numbers.map((v) => [v.bits, v] as const))('number %s', (_bits, v) => {
    const number = Buffer.from(v.bits, 'hex').readDoubleBE(0);
    expect(canonicalize(number)).toBe(v.expected);
  });
  it.each(jcs.objects.map((v, i) => [i, v] as const))('object %i', (_i, v) => {
    expect(canonicalize(JSON.parse(v.json))).toBe(v.expected);
  });
});
