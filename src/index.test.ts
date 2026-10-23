import { describe, expect, it } from 'vitest';
import { HalvorClient, hashInstruction, name, redactText, withAgentContext } from './index.js';

describe('@halvorai/ingest', () => {
  it('exports its package name and public API', () => {
    expect(name).toBe('@halvorai/ingest');
    expect(typeof HalvorClient).toBe('function');
    expect(typeof withAgentContext).toBe('function');
    expect(typeof hashInstruction).toBe('function');
    expect(typeof redactText).toBe('function');
  });
});
