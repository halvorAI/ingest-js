export class TimeError extends Error {
  override readonly name = 'TimeError';
}

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** RFC 3339 in UTC with milliseconds, the only timestamp format in JSON. */
export function formatUtc(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new TimeError('invalid date');
  return date.toISOString();
}

export function nowUtc(): string {
  return formatUtc(new Date());
}

export function parseUtc(value: string): Date {
  if (!CANONICAL.test(value)) throw new TimeError('timestamp must be RFC 3339 UTC with milliseconds');
  const date = new Date(value);
  // Round-tripping rejects overflow such as 2026-02-30.
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new TimeError('timestamp is not a real date');
  }
  return date;
}
