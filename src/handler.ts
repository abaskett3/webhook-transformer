import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { getConfig } from './config.ts';
import { postToDiscord } from './discord.ts';
import { buildDiscordPayload } from './embed.ts';
import { parseNotification } from './payload.ts';
import { verifySignature } from './signature.ts';

/**
 * API Gateway HTTP API (payload format 2.0) entry point.
 *
 * Returns 204 as soon as the signature verifies, whatever Discord does. Vast
 * treats 4xx (other than 408/429) as a permanent failure and will not retry, so
 * a 4xx here means the delivery is gone for good — reserved for requests that a
 * retry could never fix. Everything transient surfaces as 5xx, which Vast does
 * retry.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const rawBody = readRawBody(event);

  let config;
  try {
    config = await getConfig();
  } catch (error: unknown) {
    // Misconfiguration or a transient SSM failure. 5xx so Vast retries.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'config unavailable',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { statusCode: 500 };
  }

  // HTTP API lowercases all header names. Optional chaining is for hand-written
  // `sam local invoke` fixtures: API Gateway always sends `headers`, but a
  // fixture without it should still get a clean 401 rather than a TypeError.
  const headers = event.headers ?? {};

  const signatureValid = verifySignature({
    timestampHeader: headers['x-vast-timestamp'],
    signatureHeader: headers['x-vast-signature-256'],
    rawBody,
    secret: config.vastWebhookSecret,
  });

  if (!signatureValid) {
    // Deliberately terse: this endpoint is public, and a scanner shouldn't be
    // able to turn rejected requests into a CloudWatch Logs bill.
    console.warn(JSON.stringify({ level: 'warn', msg: 'signature rejected' }));
    return { statusCode: 401 };
  }

  const parsed = parseNotification(rawBody);
  if (!parsed.ok) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'invalid payload', error: parsed.error }));
    return { statusCode: 400 };
  }

  const notification = parsed.value;
  const delivery = await postToDiscord(config.discordWebhookUrl, buildDiscordPayload(notification));

  // One structured line per accepted delivery. Notification subject and message
  // are omitted on purpose — they're the actual content of the alert.
  console.log(
    JSON.stringify({
      level: delivery.ok ? 'info' : 'error',
      msg: delivery.ok ? 'delivered to discord' : 'discord delivery failed',
      event_id: notification.event_id,
      notif_type: notification.notif_type,
      delivery_attempt: deliveryAttempt(headers['x-vast-delivery-attempt']),
      discord_status: delivery.status,
      ...(delivery.error === undefined ? {} : { error: delivery.error }),
    }),
  );

  // 204 regardless of the Discord outcome: the event was authentic and has been
  // handled. Asking Vast to retry wouldn't help — a Discord 4xx would fail
  // again, and there's no dedup store, so a retry risks a duplicate message.
  return { statusCode: 204 };
}

/**
 * Narrows the delivery-attempt header to a number before it reaches a log.
 *
 * The HMAC covers only `X-Vast-Timestamp` and the raw body, so every other
 * `X-Vast-*` header is unauthenticated — anyone replaying a request whose
 * body/timestamp pair verifies can set this to whatever they like. Parsing to
 * an integer bounds what an attacker can write into CloudWatch Logs.
 */
function deliveryAttempt(header: string | undefined): number | undefined {
  if (header === undefined || !/^\d{1,9}$/.test(header)) return undefined;
  return Number(header);
}

/**
 * Recovers the exact bytes Vast signed.
 *
 * API Gateway base64-encodes bodies it considers binary, so the flag has to be
 * honoured — decoding the wrong way produces different bytes and every
 * signature check fails.
 */
function readRawBody(event: APIGatewayProxyEventV2): Buffer {
  if (!event.body) return Buffer.alloc(0);
  return Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
}
