import { describe, expect, it } from 'vitest';
import { redactDeep, redactText } from './redact.js';

describe('redactText: card numbers', () => {
  it('removes Luhn-valid 13 to 19 digit runs, with spaces or dashes', () => {
    expect(redactText('paid with 4242 4242 4242 4242 today')).toBe(
      'paid with [redacted:pan] today',
    );
    expect(redactText('card 4000-0566-5566-5556.')).toBe('card [redacted:pan].');
    expect(redactText('4242424242424242')).toBe('[redacted:pan]');
    expect(redactText('visa 4222222222222')).toBe('visa [redacted:pan]'); // 13 digits
    expect(redactText('maestro 6799990100000000019')).toBe('maestro [redacted:pan]'); // 19 digits
  });

  it('leaves order numbers and other digit runs alone', () => {
    for (const text of [
      'order 1234567890123456', // 16 digits, fails Luhn
      'invoice 20261017',
      'id 12345678901234567890', // 20 digits
      'phone +1 415 555 0100',
      'amount 41200 USD',
    ]) {
      expect(redactText(text), text).toBe(text);
    }
  });

  it('leaves digit runs inside hex, base64 and ids alone', () => {
    for (const text of [
      '0x9632e1311996ebcb38d7a4242424242424242b5beb14f513',
      'c2lnbmF0dXJl4242424242424242AAA=',
      'ord_4242424242424242x',
    ]) {
      expect(redactText(text), text).toBe(text);
    }
  });

  it('still finds a card number in a URL path', () => {
    expect(redactText('https://api.example/r/4242424242424242')).toBe(
      'https://api.example/r/[redacted:pan]',
    );
  });

  it('finds several in one string', () => {
    expect(redactText('a 4242424242424242 b 5555555555554444 c')).toBe(
      'a [redacted:pan] b [redacted:pan] c',
    );
  });
});

describe('redactText: CVC and secrets', () => {
  it('removes CVC and CVV values after a label', () => {
    expect(redactText('cvc: 123')).toBe('cvc: [redacted:cvc]');
    expect(redactText('CVV2=1234')).toBe('CVV2=[redacted:cvc]');
    expect(redactText('security code 987')).toBe('security code [redacted:cvc]');
    expect(redactText('{"cvc":"123"}')).toBe('{"cvc":"[redacted:cvc]"}');
    expect(redactText('cvc 12')).toBe('cvc 12'); // too short to be one
    expect(redactText('cvcs are great')).toBe('cvcs are great');
  });

  it('removes Stripe secret, restricted and webhook keys but not publishable ones', () => {
    expect(redactText('key sk_live_51H8abcDEFghi1234567890 end')).toBe(
      'key [redacted:secret-key] end',
    );
    expect(redactText('sk_test_4eC39HqLyjWDarjtT1zdp7dc')).toBe('[redacted:secret-key]');
    expect(redactText('rk_live_abcdefghijklmnop1234')).toBe('[redacted:secret-key]');
    expect(redactText('whsec_abcdefghijklmnopqrstuv')).toBe('[redacted:secret-key]');
    expect(redactText('pk_live_abcdefghijklmnop1234')).toBe('pk_live_abcdefghijklmnop1234');
  });

  it('removes our own API keys', () => {
    expect(redactText(`using hk_live_${'A1b2'.repeat(8)} now`)).toBe(
      'using [redacted:secret-key] now',
    );
    expect(redactText(`hk_test_${'z'.repeat(32)}`)).toBe('[redacted:secret-key]');
  });

  it('removes PEM private keys of every kind, but not public keys', () => {
    for (const kind of [
      'PRIVATE KEY',
      'EC PRIVATE KEY',
      'RSA PRIVATE KEY',
      'OPENSSH PRIVATE KEY',
      'ENCRYPTED PRIVATE KEY',
    ]) {
      const pem = `before\n-----BEGIN ${kind}-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabc=\n-----END ${kind}-----\nafter`;
      expect(redactText(pem), kind).toBe('before\n[redacted:private-key]\nafter');
    }
    const pub = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQ\n-----END PUBLIC KEY-----';
    expect(redactText(pub)).toBe(pub);
  });

  it('removes the private part of a JWK serialised in text', () => {
    const jwk =
      '{"kty":"OKP","crv":"Ed25519","d":"nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}';
    const out = redactText(`source key ${jwk}`);
    expect(out).not.toContain('nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A');
    expect(out).toContain('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo');
    expect(out).toContain('[redacted:private-key]');
  });

  it('applies extra patterns with their label', () => {
    expect(
      redactText('staff EMP-004211 here', {
        extraPatterns: [{ pattern: /EMP-\d{6}/g, label: 'employee-id' }],
      }),
    ).toBe('staff [redacted:employee-id] here');
    expect(redactText('x ABC', { extraPatterns: [/ABC/g] })).toBe('x [redacted]');
  });
});

describe('redactDeep', () => {
  it('walks objects and arrays, redacting every string', () => {
    const input = {
      description: 'card 4242424242424242',
      nested: {
        list: ['ok', 'cvc: 123', 5, null, true],
        deeper: { key: 'sk_live_51H8abcDEFghi1234567890' },
      },
      count: 3,
    };
    expect(redactDeep(input)).toEqual({
      description: 'card [redacted:pan]',
      nested: {
        list: ['ok', 'cvc: [redacted:cvc]', 5, null, true],
        deeper: { key: '[redacted:secret-key]' },
      },
      count: 3,
    });
  });

  it('does not change its input', () => {
    const input = { a: ['4242424242424242'] };
    const copy = structuredClone(input);
    redactDeep(input);
    expect(input).toEqual(copy);
  });

  it('replaces a private JWK object wholesale and keeps a public one', () => {
    const priv = { kty: 'OKP', crv: 'Ed25519', x: 'abc', d: 'secret' };
    const pub = { kty: 'OKP', crv: 'Ed25519', x: 'abc' };
    expect(redactDeep({ key: priv })).toEqual({ key: '[redacted:private-key]' });
    expect(redactDeep({ key: pub })).toEqual({ key: pub });
    expect(redactDeep({ rsa: { kty: 'RSA', n: '1', e: 'AQAB', d: 'x', p: 'y' } })).toEqual({
      rsa: '[redacted:private-key]',
    });
  });

  it('survives cycles and very deep structures', () => {
    const loop: Record<string, unknown> = { s: '4242424242424242' };
    loop['self'] = loop;
    const out = redactDeep(loop) as Record<string, unknown>;
    expect(out['s']).toBe('[redacted:pan]');
    expect(out['self']).toBe('[circular]');

    let deep: Record<string, unknown> = { v: 'cvc: 123' };
    for (let i = 0; i < 200; i++) deep = { next: deep };
    expect(() => redactDeep(deep)).not.toThrow();
  });

  it('keeps non-plain values as they are or turns them into safe text', () => {
    const date = new Date('2026-10-17T00:00:00.000Z');
    const out = redactDeep({ date, big: 10n, fn: () => 1 }) as Record<string, unknown>;
    expect(out['date']).toBe('2026-10-17T00:00:00.000Z');
    expect(out['big']).toBe('10');
    expect(out['fn']).toBeUndefined();
  });
});
