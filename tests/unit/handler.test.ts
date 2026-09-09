import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfigCache } from '../../src/config.ts';
import { handler } from '../../src/handler.ts';
import { SAMPLE_NOTIFICATION, sign, TEST_SECRET } from '../helpers.ts';

const DISCORD_URL =
  'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789';

interface EventOptions {
  body?: string;
  timestamp?: number;
  signature?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
}

function buildEvent(options: EventOptions = {}): APIGatewayProxyEventV2 {
  const body = options.body ?? JSON.stringify(SAMPLE_NOTIFICATION);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);

  return {
    version: '2.0',
    routeKey: 'POST /webhook',
    rawPath: '/webhook',
    isBase64Encoded: options.isBase64Encoded ?? false,
    body: options.isBase64Encoded ? Buffer.from(body, 'utf8').toString('base64') : body,
    headers: {
      'content-type': 'application/json',
      'x-vast-event-id': SAMPLE_NOTIFICATION.event_id,
      'x-vast-delivery-attempt': '1',
      'x-vast-timestamp': String(timestamp),
      'x-vast-signature-256': options.signature ?? sign(body, timestamp),
      ...options.headers,
    },
  } as unknown as APIGatewayProxyEventV2;
}

function mockFetch(response: Response | Error) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  if (response instanceof Error) fetchSpy.mockRejectedValue(response);
  else fetchSpy.mockResolvedValue(response);
  return fetchSpy;
}

let logs: string[];

beforeEach(() => {
  resetConfigCache();
  process.env.DISCORD_WEBHOOK_URL = DISCORD_URL;
  process.env.VAST_WEBHOOK_SECRET = TEST_SECRET;

  logs = [];
  const capture = (line: unknown) => void logs.push(String(line));
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});

describe('handler', () => {
  it('accepts a signed delivery and forwards it to Discord', async () => {
    const fetchSpy = mockFetch(new Response(null, { status: 204 }));

    const result = await handler(buildEvent());

    expect(result).toEqual({ statusCode: 204 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(DISCORD_URL);
    expect(init?.method).toBe('POST');

    const sent = JSON.parse(String(init?.body));
    expect(sent.embeds[0].title).toBe(SAMPLE_NOTIFICATION.subject);
    expect(sent.embeds[0].description).toBe(SAMPLE_NOTIFICATION.message);
    expect(sent.embeds[0].footer.text).toContain(SAMPLE_NOTIFICATION.notif_type);
  });

  it('honours isBase64Encoded when recovering the signed bytes', async () => {
    // API Gateway may base64 the body; decoding it the wrong way changes the
    // bytes and breaks every signature check.
    const fetchSpy = mockFetch(new Response(null, { status: 204 }));

    const result = await handler(buildEvent({ isBase64Encoded: true }));

    expect(result).toEqual({ statusCode: 204 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns 204 even when Discord returns an error', async () => {
    // Vast must not retry: a retry would hit the same Discord failure and,
    // with no dedup store, risks duplicating the message.
    mockFetch(new Response('{"message":"Invalid Webhook Token"}', { status: 401 }));

    expect(await handler(buildEvent())).toEqual({ statusCode: 204 });
  });

  it('returns 204 even when the Discord request fails outright', async () => {
    mockFetch(new TypeError('fetch failed'));

    expect(await handler(buildEvent())).toEqual({ statusCode: 204 });
  });

  it('rejects a bad signature with 401 and never calls Discord', async () => {
    const fetchSpy = mockFetch(new Response(null, { status: 204 }));

    const result = await handler(buildEvent({ signature: 'sha256=deadbeef' }));

    expect(result).toEqual({ statusCode: 401 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a stale delivery with 401', async () => {
    const fetchSpy = mockFetch(new Response(null, { status: 204 }));
    const stale = Math.floor(Date.now() / 1000) - 301;

    const result = await handler(buildEvent({ timestamp: stale }));

    expect(result).toEqual({ statusCode: 401 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a body whose signature does not cover it', async () => {
    const fetchSpy = mockFetch(new Response(null, { status: 204 }));
    const timestamp = Math.floor(Date.now() / 1000);

    const result = await handler(
      buildEvent({
        body: JSON.stringify({ ...SAMPLE_NOTIFICATION, message: 'tampered' }),
        signature: sign(JSON.stringify(SAMPLE_NOTIFICATION), timestamp),
        timestamp,
      }),
    );

    expect(result).toEqual({ statusCode: 401 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for a signed but malformed body', async () => {
    const fetchSpy = mockFetch(new Response(null, { status: 204 }));

    const result = await handler(buildEvent({ body: 'not json at all' }));

    expect(result).toEqual({ statusCode: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for a signed body missing a required field', async () => {
    const { event_id: _omitted, ...withoutEventId } = SAMPLE_NOTIFICATION;

    const result = await handler(buildEvent({ body: JSON.stringify(withoutEventId) }));

    expect(result).toEqual({ statusCode: 400 });
  });

  it('returns 500 when configuration cannot be loaded', async () => {
    // No env values and no SSM parameter names configured. 5xx so Vast retries.
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.VAST_WEBHOOK_SECRET;
    delete process.env.DISCORD_WEBHOOK_URL_PARAMETER;
    delete process.env.VAST_WEBHOOK_SECRET_PARAMETER;
    resetConfigCache();

    expect(await handler(buildEvent())).toEqual({ statusCode: 500 });
  });

  it('never writes the Discord webhook token to the logs', async () => {
    mockFetch(new TypeError(`fetch failed for ${DISCORD_URL}`));

    await handler(buildEvent());

    expect(logs.join('\n')).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('does not log the notification subject or message', async () => {
    mockFetch(new Response(null, { status: 204 }));

    await handler(buildEvent());

    const combined = logs.join('\n');
    expect(combined).toContain(SAMPLE_NOTIFICATION.event_id);
    expect(combined).not.toContain(SAMPLE_NOTIFICATION.subject);
    expect(combined).not.toContain(SAMPLE_NOTIFICATION.message);
  });

  it('logs the delivery attempt as a number', async () => {
    mockFetch(new Response(null, { status: 204 }));

    await handler(buildEvent({ headers: { 'x-vast-delivery-attempt': '3' } }));

    expect(JSON.parse(logs[0] ?? '{}').delivery_attempt).toBe(3);
  });

  it('drops a delivery-attempt header that is not a plain integer', async () => {
    // This header is outside the HMAC, so anyone who can replay a verifying
    // request controls it. Unparseable means absent, not passed through.
    mockFetch(new Response(null, { status: 204 }));

    const junk = 'A'.repeat(5_000);
    await handler(buildEvent({ headers: { 'x-vast-delivery-attempt': junk } }));

    expect(JSON.parse(logs[0] ?? '{}').delivery_attempt).toBeUndefined();
    expect(logs.join('\n')).not.toContain(junk);
  });

  it('returns 401 rather than throwing when the event carries no headers', async () => {
    // Unreachable through API Gateway, which always sends headers — this is for
    // hand-written `sam local invoke` fixtures.
    const event = { version: '2.0', body: '{}', isBase64Encoded: false } as APIGatewayProxyEventV2;

    expect(await handler(event)).toEqual({ statusCode: 401 });
  });
});
