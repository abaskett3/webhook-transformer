import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Maximum accepted age of X-Vast-Timestamp, in seconds. Mirrors the 300s
 * replay window in Vast's reference implementation.
 */
export const MAX_SIGNATURE_AGE_SECONDS = 300;

const SIGNATURE_PREFIX = 'sha256=';

/** X-Vast-Timestamp is documented as an integer Unix timestamp. */
const INTEGER_TIMESTAMP = /^\d+$/;

export interface VerifySignatureInput {
  /** Raw `X-Vast-Timestamp` header value. */
  timestampHeader: string | undefined;
  /** Raw `X-Vast-Signature-256` header value, i.e. `sha256=<hex>`. */
  signatureHeader: string | undefined;
  /**
   * The request body exactly as received. Do NOT parse and re-serialize the
   * JSON before verifying — the signature covers these precise bytes.
   */
  rawBody: Buffer;
  /** The webhook_secret issued by Vast when the webhook was created. */
  secret: string;
  /** Injectable clock, epoch seconds. Defaults to the real clock. */
  nowSeconds?: number;
}

/**
 * Verifies an inbound Vast.ai webhook signature.
 *
 * The signature input is `<X-Vast-Timestamp>.<raw request body bytes>`, keyed
 * by the webhook secret, HMAC-SHA256, hex-encoded, prefixed with `sha256=`.
 *
 * Source: https://docs.vast.ai/guides/reference/notification-webhooks
 */
export function verifySignature(input: VerifySignatureInput): boolean {
  const { timestampHeader, signatureHeader, rawBody, secret } = input;
  const now = input.nowSeconds ?? Date.now() / 1000;

  if (!secret) return false;
  if (!timestampHeader || !INTEGER_TIMESTAMP.test(timestampHeader)) return false;
  if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;

  // Reject stale requests to limit replay. Symmetric window, so a receiver
  // whose clock runs slightly fast doesn't drop live deliveries.
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now - timestamp) > MAX_SIGNATURE_AGE_SECONDS) return false;

  const signed = Buffer.concat([Buffer.from(`${timestampHeader}.`, 'utf8'), rawBody]);
  const digest = createHmac('sha256', secret).update(signed).digest('hex');

  return constantTimeEquals(signatureHeader, `${SIGNATURE_PREFIX}${digest}`);
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  // timingSafeEqual throws when lengths differ. A length mismatch is already a
  // definitive mismatch, and the length of a hex digest isn't secret.
  if (bufferA.length !== bufferB.length) return false;

  return timingSafeEqual(bufferA, bufferB);
}
