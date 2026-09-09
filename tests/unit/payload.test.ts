import { describe, expect, it } from 'vitest';

import { parseNotification } from '../../src/payload.ts';
import { SAMPLE_BODY, SAMPLE_NOTIFICATION } from '../helpers.ts';

function parse(body: unknown) {
  return parseNotification(Buffer.from(JSON.stringify(body), 'utf8'));
}

describe('parseNotification', () => {
  it('accepts the documented example payload', () => {
    const result = parse(SAMPLE_BODY);

    // user_id is read off the wire and dropped — it is never rendered.
    expect(result).toEqual({ ok: true, value: SAMPLE_NOTIFICATION });
  });

  it('tolerates unknown extra fields', () => {
    const result = parse({ ...SAMPLE_BODY, some_future_field: { nested: true } });

    expect(result.ok).toBe(true);
    // Extra fields are dropped rather than forwarded.
    if (result.ok) expect(result.value).toEqual(SAMPLE_NOTIFICATION);
  });

  it('accepts empty subject and message', () => {
    expect(parse({ ...SAMPLE_NOTIFICATION, subject: '', message: '' }).ok).toBe(true);
  });

  it.each([
    ['not JSON at all', 'this is not json'],
    ['a truncated object', '{"event_id":'],
    ['an empty body', ''],
  ])('rejects %s', (_label, raw) => {
    const result = parseNotification(Buffer.from(raw, 'utf8'));

    expect(result).toEqual({ ok: false, error: 'body is not valid JSON' });
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['a bare string', 'hello'],
    ['a number', 42],
  ])('rejects %s as the top-level value', (_label, body) => {
    const result = parse(body);

    expect(result).toEqual({ ok: false, error: 'body must be a JSON object' });
  });

  it.each(['event_id', 'notif_type'] as const)('rejects a missing %s', (field) => {
    const { [field]: _removed, ...rest } = SAMPLE_NOTIFICATION;

    expect(parse(rest)).toEqual({ ok: false, error: `${field} must be a non-empty string` });
  });

  it.each(['event_id', 'notif_type'] as const)('rejects an empty %s', (field) => {
    expect(parse({ ...SAMPLE_NOTIFICATION, [field]: '' })).toEqual({
      ok: false,
      error: `${field} must be a non-empty string`,
    });
  });

  // A 400 is permanent in Vast's retry model, so the display fields are coerced
  // rather than rejected: a blank line in Discord beats a discarded alert.
  it.each([
    ['a number', 12345],
    ['null', null],
    ['an object', { nested: true }],
    ['missing', undefined],
  ])('coerces a %s subject to an empty string instead of rejecting', (_label, subject) => {
    const result = parse({ ...SAMPLE_BODY, subject });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.subject).toBe('');
  });

  it('coerces a non-string message rather than rejecting', () => {
    const result = parse({ ...SAMPLE_BODY, message: 42 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.message).toBe('');
  });

  // user_id is never rendered, and Vast documents the body by example rather
  // than by schema — so its shape must not be able to discard a notification.
  it.each([
    ['a string', '123'],
    ['null', null],
    ['missing', undefined],
    ['an object', { id: 1 }],
  ])('accepts the delivery when user_id is %s', (_label, user_id) => {
    const result = parse({ ...SAMPLE_BODY, user_id });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(SAMPLE_NOTIFICATION);
  });

  it.each([
    ['a string', '1772490000'],
    ['null', null],
    ['missing', undefined],
  ])('rejects timestamp when it is %s', (_label, timestamp) => {
    expect(parse({ ...SAMPLE_NOTIFICATION, timestamp })).toEqual({
      ok: false,
      error: 'timestamp must be a finite number',
    });
  });

  it('rejects a timestamp outside the representable Date range', () => {
    // new Date(1e18 * 1000).toISOString() throws RangeError; catching it here
    // keeps the embed builder total.
    expect(parse({ ...SAMPLE_NOTIFICATION, timestamp: 1e18 })).toEqual({
      ok: false,
      error: 'timestamp is out of representable range',
    });
  });

  it('never includes field values in error messages', () => {
    const result = parse({ ...SAMPLE_BODY, event_id: { injected: 'secret-value' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('secret-value');
  });

  it('does not stringify a coerced field into the payload', () => {
    // Guards against a future `String(value)` "fix" leaking attacker-controlled
    // content into the Discord message.
    const result = parse({ ...SAMPLE_BODY, subject: { injected: 'secret-value' } });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.subject).toBe('');
  });
});
