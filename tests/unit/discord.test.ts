import { describe, expect, it, vi } from 'vitest';

import { postToDiscord, redact } from '../../src/discord.ts';
import { SAMPLE_NOTIFICATION } from '../helpers.ts';
import { buildDiscordPayload } from '../../src/embed.ts';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DISCORD_URL = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
const PAYLOAD = buildDiscordPayload(SAMPLE_NOTIFICATION);

describe('redact', () => {
  it('strips a Discord webhook URL', () => {
    expect(redact(`connect ECONNREFUSED ${DISCORD_URL}`)).toBe(
      'connect ECONNREFUSED https://discord.com/api/webhooks/<redacted>',
    );
  });

  it.each([
    ['versioned', 'https://discord.com/api/v10/webhooks/123456789012345678/tok-EN_123'],
    ['legacy discordapp.com', 'https://discordapp.com/api/webhooks/123/tok-EN_123'],
    ['subdomain', 'https://ptb.discord.com/api/webhooks/123/tok-EN_123'],
  ])('strips a %s webhook URL', (_label, url) => {
    expect(redact(`failed: ${url}`)).not.toContain('tok-EN_123');
  });

  it('strips every occurrence', () => {
    const text = `${DISCORD_URL} then again ${DISCORD_URL}`;

    expect(redact(text)).not.toContain(TOKEN);
  });

  it('leaves unrelated text alone', () => {
    expect(redact('TimeoutError: The operation was aborted')).toBe(
      'TimeoutError: The operation was aborted',
    );
  });
});

describe('postToDiscord', () => {
  it('reports success for a 204', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    expect(await postToDiscord(DISCORD_URL, PAYLOAD)).toEqual({ ok: true, status: 204 });
  });

  it('sends the payload as JSON', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await postToDiscord(DISCORD_URL, PAYLOAD);

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual(PAYLOAD);
  });

  it('reports a Discord error status with its body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"Unknown Webhook","code":10015}', { status: 404 }),
    );

    const result = await postToDiscord(DISCORD_URL, PAYLOAD);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain('Unknown Webhook');
  });

  it('does not throw when the request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    const result = await postToDiscord(DISCORD_URL, PAYLOAD);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('fetch failed');
  });

  it('redacts the webhook URL out of a thrown error', async () => {
    // undici surfaces the request URL in errors; this is the main leak path.
    const error = new TypeError('fetch failed');
    error.cause = new Error(`connect ETIMEDOUT ${DISCORD_URL}`);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);

    const result = await postToDiscord(DISCORD_URL, PAYLOAD);

    expect(result.error).not.toContain(TOKEN);
    expect(result.error).toContain('cause:');
  });

  it('redacts the webhook URL out of an error response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`rejected request to ${DISCORD_URL}`, { status: 400 }),
    );

    const result = await postToDiscord(DISCORD_URL, PAYLOAD);

    expect(result.error).not.toContain(TOKEN);
  });

  it('caps how much of an error body it keeps', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('x'.repeat(10_000), { status: 500 }),
    );

    const result = await postToDiscord(DISCORD_URL, PAYLOAD);

    expect(result.error?.length).toBeLessThanOrEqual(300);
  });

  it('still caps an error body full of webhook URLs', async () => {
    // Redaction lengthens the text (the replacement is longer than the shortest
    // URL it matches), so capping before redacting let the result grow past the
    // cap. This is the case the plain-body test above cannot catch.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`${DISCORD_URL} `.repeat(200), { status: 500 }),
    );

    const result = await postToDiscord(DISCORD_URL, PAYLOAD);

    expect(result.error?.length).toBeLessThanOrEqual(300);
    expect(result.error).not.toContain(TOKEN);
  });

  it('caps a long error from the network stack', async () => {
    // The catch branch had no cap at all: describeError concatenates message
    // and cause with no bound of its own.
    const error = new Error('x'.repeat(5_000), { cause: new Error('y'.repeat(5_000)) });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);

    const result = await postToDiscord(DISCORD_URL, PAYLOAD);

    expect(result.ok).toBe(false);
    expect(result.error?.length).toBeLessThanOrEqual(300);
  });

  it('passes an abort signal so a hung Discord cannot stall the invocation', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await postToDiscord(DISCORD_URL, PAYLOAD);

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
