import { monotonicFactory } from 'ulid';

export const ID_PREFIXES = [
  'org',
  'agt',
  'own',
  'evt',
  'mdt',
  'alr',
  'cas',
  'pck',
  'key',
  'src',
  'req',
  'pye',
  'aud',
  'evi',
  'usr',
  'ses',
  'acc',
  'vfy',
  'mev',
  'bas',
  'ala',
  'slv',
  'sne',
  'opa',
  'scr',
  'srv',
  'ssp',
  'csi',
  'csn',
  'shl',
  'mem',
  'inv',
  'tfa',
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];
export type Id<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

const ID_PATTERN = /^([a-z]{3})_([0-9A-HJKMNP-TV-Z]{26})$/;
const prefixes: ReadonlySet<string> = new Set(ID_PREFIXES);

// Monotonic so ids generated in the same millisecond still sort in creation order.
const ulid = monotonicFactory();

export function newId<P extends IdPrefix>(prefix: P): Id<P> {
  return `${prefix}_${ulid()}`;
}

export function parseId(value: string): { prefix: IdPrefix; ulid: string } | null {
  const match = ID_PATTERN.exec(value);
  const prefix = match?.[1];
  const body = match?.[2];
  if (prefix === undefined || body === undefined || !prefixes.has(prefix)) return null;
  return { prefix: prefix as IdPrefix, ulid: body };
}

export function isId<P extends IdPrefix>(value: string, prefix?: P): value is Id<P> {
  const parsed = parseId(value);
  return parsed !== null && (prefix === undefined || parsed.prefix === prefix);
}

export function assertId<P extends IdPrefix>(value: string, prefix: P): asserts value is Id<P> {
  if (!isId(value, prefix)) throw new TypeError(`expected an id starting with ${prefix}_`);
}
