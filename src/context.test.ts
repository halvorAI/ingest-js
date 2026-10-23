import { describe, expect, it } from 'vitest';
import { currentContext, withAgentContext, type AgentContext } from './context.js';
import { hashInstruction } from './hash.js';

const ctxA: AgentContext = { agent: { id: 'agt_a' }, owner: { id: 'own_a', type: 'business' } };
const ctxB: AgentContext = { agent: { id: 'agt_b' }, owner: { id: 'own_b', type: 'person' } };

describe('withAgentContext', () => {
  it('has no context outside a call', () => {
    expect(currentContext()).toBeUndefined();
  });

  it('exposes the context to the callback, including after awaits', async () => {
    const seen = await withAgentContext(ctxA, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await Promise.resolve();
      return currentContext();
    });
    expect(seen?.agent?.id).toBe('agt_a');
    expect(currentContext()).toBeUndefined();
  });

  it('returns the callback result and passes errors through', async () => {
    expect(withAgentContext(ctxA, () => 42)).toBe(42);
    expect(await withAgentContext(ctxA, async () => 42)).toBe(42);
    // A sync throw reaches the caller as a throw, not as a returned rejected promise.
    expect(() =>
      withAgentContext(ctxA, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    await expect(
      withAgentContext(ctxA, async () => {
        throw new Error('async boom');
      }),
    ).rejects.toThrow('async boom');
  });

  it('keeps concurrent contexts apart', async () => {
    const run = (ctx: AgentContext, delay: number) =>
      withAgentContext(ctx, async () => {
        await new Promise((r) => setTimeout(r, delay));
        return currentContext()?.agent?.id;
      });
    expect(await Promise.all([run(ctxA, 20), run(ctxB, 5), run(ctxA, 1)])).toEqual([
      'agt_a',
      'agt_b',
      'agt_a',
    ]);
  });

  it('inner contexts replace outer ones and restore them afterwards', async () => {
    await withAgentContext(ctxA, async () => {
      await withAgentContext(ctxB, async () => {
        expect(currentContext()?.agent?.id).toBe('agt_b');
      });
      expect(currentContext()?.agent?.id).toBe('agt_a');
    });
  });

  it('accepts a partial inner context by merging over the outer one', async () => {
    await withAgentContext(ctxA, async () => {
      await withAgentContext({ instruction: { id: 'ins_1', text: 'do the thing' } }, async () => {
        const ctx = currentContext();
        expect(ctx?.agent?.id).toBe('agt_a');
        expect(ctx?.instruction?.id).toBe('ins_1');
      });
    });
  });
});

describe('hashInstruction', () => {
  it('is sha256 of the UTF-8 text in the APE format', () => {
    expect(hashInstruction('Book a return flight to Austin under $500 for next Friday.')).toBe(
      'sha256:10dff3ca7c8369a72e80e33eb5cd4dd91c8f55749497f25d38b4c0566845e4fb',
    );
    expect(hashInstruction('héllo €')).toBe(
      'sha256:9cb52b6d1cfc1eae34c63c2b0ff0d49ed8ef2c82482b3c455747594c83754098',
    );
    expect(hashInstruction('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
