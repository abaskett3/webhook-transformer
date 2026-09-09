import { createHmac } from 'node:crypto';

import type { VastNotification } from '../src/types.ts';

export const TEST_SECRET = 'test-webhook-secret';

/**
 * A representative delivery, as `parseNotification` yields it.
 *
 * `user_id` is absent because the transformer doesn't model it — see
 * SAMPLE_BODY for the wire form.
 */
export const SAMPLE_NOTIFICATION: VastNotification = {
  event_id: '7e9a2c4e6f9e4a24a53b77c2d8e3f0aa',
  notif_type: 'low_credit',
  subject: 'Warning - Your Vast.ai Credit Balance Is Getting Low',
  message: 'Your Vast.ai balance is below your configured threshold.',
  timestamp: 1772490000.123,
};

/**
 * The example payload from Vast's docs, byte-for-byte in shape — including the
 * `user_id` the transformer reads but doesn't model.
 */
export const SAMPLE_BODY = {
  ...SAMPLE_NOTIFICATION,
  user_id: 123,
};

/**
 * Signs a body the way Vast does.
 *
 * Written against the documented scheme directly rather than by calling into
 * src/signature.ts, so a bug there can't make these tests agree with it.
 */
export function sign(rawBody: Buffer | string, timestamp: number, secret = TEST_SECRET): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
  return `sha256=${createHmac('sha256', secret).update(signed).digest('hex')}`;
}
