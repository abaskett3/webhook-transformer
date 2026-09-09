import { describe, expect, it } from 'vitest';

import { MAX_SIGNATURE_AGE_SECONDS, verifySignature } from '../../src/signature.ts';
import { sign, TEST_SECRET } from '../helpers.ts';

const NOW = 1772490000;
const BODY = Buffer.from(JSON.stringify({ event_id: 'abc', hello: 'world' }), 'utf8');

function verify(overrides: Partial<Parameters<typeof verifySignature>[0]> = {}): boolean {
  return verifySignature({
    timestampHeader: String(NOW),
    signatureHeader: sign(BODY, NOW),
    rawBody: BODY,
    secret: TEST_SECRET,
    nowSeconds: NOW,
    ...overrides,
  });
}

describe('verifySignature', () => {
  it('accepts a correctly signed request', () => {
    expect(verify()).toBe(true);
  });

  it('accepts a signature at the edge of the freshness window', () => {
    expect(verify({ nowSeconds: NOW + MAX_SIGNATURE_AGE_SECONDS })).toBe(true);
  });

  it('accepts a body containing multi-byte characters', () => {
    const body = Buffer.from(JSON.stringify({ message: 'balance low 🚨 — act now' }), 'utf8');
    expect(
      verify({ rawBody: body, signatureHeader: sign(body, NOW) }),
    ).toBe(true);
  });

  it('rejects a signature produced with a different secret', () => {
    expect(verify({ signatureHeader: sign(BODY, NOW, 'some-other-secret') })).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verify({ rawBody: Buffer.from('{"event_id":"tampered"}', 'utf8') })).toBe(false);
  });

  it('rejects a body that differs only in whitespace', () => {
    // Re-serializing the JSON changes the bytes, which is exactly why the
    // handler must hash the raw request body.
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(BODY.toString()), null, 2), 'utf8');
    expect(verify({ rawBody: reserialized })).toBe(false);
  });

  it('rejects a stale timestamp', () => {
    expect(verify({ nowSeconds: NOW + MAX_SIGNATURE_AGE_SECONDS + 1 })).toBe(false);
  });

  it('rejects a timestamp too far in the future', () => {
    expect(verify({ nowSeconds: NOW - MAX_SIGNATURE_AGE_SECONDS - 1 })).toBe(false);
  });

  it('rejects a timestamp that was not the one signed', () => {
    expect(verify({ timestampHeader: String(NOW + 1) })).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['non-numeric', 'not-a-timestamp'],
    ['fractional', '1772490000.123'],
  ])('rejects a %s timestamp header', (_label, timestampHeader) => {
    expect(verify({ timestampHeader })).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['unprefixed', sign(BODY, NOW).replace('sha256=', '')],
    ['wrongly prefixed', sign(BODY, NOW).replace('sha256=', 'sha512=')],
    ['truncated', sign(BODY, NOW).slice(0, 20)],
    ['prefix only', 'sha256='],
  ])('rejects a %s signature header', (_label, signatureHeader) => {
    expect(verify({ signatureHeader })).toBe(false);
  });

  it('rejects when the secret is empty', () => {
    // Guards against a misconfigured deployment silently accepting everything.
    expect(verify({ secret: '' })).toBe(false);
  });

  it('does not throw on a length-mismatched signature', () => {
    // Node's timingSafeEqual throws on differing buffer lengths.
    expect(() => verify({ signatureHeader: 'sha256=aa' })).not.toThrow();
  });
});
