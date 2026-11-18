import { describe, expect, it } from 'vitest';
import { runDemo } from './demo.js';

describe('runDemo', () => {
  it('signs an event, passes the sample pack and fails the tampered copy', async () => {
    const lines: string[] = [];
    const result = await runDemo({ log: (line) => lines.push(line) });
    expect(result).toEqual({ eventVerified: true, samplePassed: true, tamperedFailed: true });
    const text = lines.join('\n');
    expect(text).toContain('Ed25519 signature: verified');
    expect(text).toContain('PASS: Evidence pack pck_01DEMO00000000000000000000 passed verification.');
    expect(text).toContain('- events.jsonl sha256 does not match manifest');
    expect(text).not.toContain('Book a return flight');
  });
});
