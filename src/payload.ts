import type { Result, VastNotification } from './types.ts';

/**
 * JS `Date` spans ±8.64e15 ms. Anything beyond that yields an Invalid Date,
 * whose `toISOString()` throws a RangeError — so it is rejected here rather
 * than blowing up while building the embed.
 *
 * This is only the "would throw" bound. In-range but absurd values still
 * produce a timestamp Discord won't parse; embed.ts omits the field in that
 * case rather than losing the whole delivery.
 */
const MAX_EPOCH_SECONDS = 8.64e15 / 1000;

/**
 * Parses and validates the Vast notification body.
 *
 * Validation is deliberately minimal. A 400 is a *permanent* failure in Vast's
 * retry model, so every rejection here discards a notification for good. Only
 * fields the embed genuinely cannot be built without are hard-required:
 * `event_id` and `notif_type` (they form the footer, which is what keeps the
 * embed non-empty) and a usable `timestamp`. Everything else is coerced.
 *
 * In particular `user_id` is not validated at all — it is sent by Vast but
 * never rendered, and Vast documents the body with an example rather than a
 * field schema, so rejecting on its shape would mean discarding real
 * notifications to enforce a contract that was only ever inferred.
 *
 * Unknown extra fields are tolerated for the same reason: new fields added by
 * Vast must not start rejecting deliveries.
 *
 * Error strings name the offending field but never echo its value — they reach
 * CloudWatch Logs (the 400 itself has no body) and the body is
 * attacker-controlled.
 */
export function parseNotification(rawBody: Buffer): Result<VastNotification> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, error: 'body is not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'body must be a JSON object' };
  }

  const body = parsed as Record<string, unknown>;

  // Required non-empty strings: these carry the message identity.
  for (const field of ['event_id', 'notif_type'] as const) {
    const value = body[field];
    if (typeof value !== 'string' || value.length === 0) {
      return { ok: false, error: `${field} must be a non-empty string` };
    }
  }

  if (typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp)) {
    return { ok: false, error: 'timestamp must be a finite number' };
  }

  if (Math.abs(body.timestamp) > MAX_EPOCH_SECONDS) {
    return { ok: false, error: 'timestamp is out of representable range' };
  }

  return {
    ok: true,
    value: {
      event_id: body.event_id as string,
      notif_type: body.notif_type as string,
      // Display text is coerced rather than validated: a missing or oddly-typed
      // subject is worth a blank line in Discord, not a discarded notification.
      // embed.ts omits empty fields, and the footer keeps the embed non-empty.
      subject: asDisplayText(body.subject),
      message: asDisplayText(body.message),
      timestamp: body.timestamp,
    },
  };
}

/** Anything that isn't already a string becomes empty — never stringified. */
function asDisplayText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
