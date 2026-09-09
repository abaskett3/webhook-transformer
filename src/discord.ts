import type { DiscordWebhookPayload } from './types.ts';

/**
 * Well inside Vast's 10s delivery timeout, leaving room for the rest of the
 * invocation. If Discord hasn't answered in 5s, the notification is dropped
 * rather than risking a Vast-side timeout and a retry storm.
 */
const TIMEOUT_MS = 5_000;

/** Cap on how much of a Discord error body reaches the logs. */
const MAX_ERROR_DETAIL = 300;

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  /** Redacted, safe to log. */
  error?: string;
}

/**
 * POSTs the embed to Discord. Never throws and never rejects — delivery failure
 * is reported, not raised, because the handler returns 2xx to Vast regardless.
 */
export async function postToDiscord(
  webhookUrl: string,
  payload: DiscordWebhookPayload,
): Promise<DeliveryResult> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: safeDetail(await readErrorBody(response)),
      };
    }

    return { ok: true, status: response.status };
  } catch (error: unknown) {
    return { ok: false, error: safeDetail(describeError(error)) };
  }
}

/**
 * The single choke point for anything that reaches a log.
 *
 * Redaction has to run before the length cap, not after: the replacement text
 * is longer than the shortest URL it matches, so redacting a string that was
 * already capped pushes it back over. Both failure paths go through here so
 * neither can grow unbounded — `describeError` in particular concatenates
 * messages from the network stack with no length of its own.
 */
function safeDetail(text: string): string {
  return redact(text).slice(0, MAX_ERROR_DETAIL);
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    // Trimmed to a generous prefix before redaction so the regex never runs
    // over a huge body. Nothing beyond this point could survive the final cap
    // anyway, and a webhook URL is far shorter than the slack left here, so no
    // URL that reaches the log can be split across the cut.
    return (await response.text()).slice(0, MAX_ERROR_DETAIL * 4);
  } catch {
    return '<unreadable response body>';
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // `cause` is where undici puts the underlying network failure, and it is a
    // common place for the request URL to resurface.
    const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : '';
    return `${error.name}: ${error.message}${cause}`;
  }

  return String(error);
}

/**
 * A Discord webhook URL is a bearer credential — anyone holding it can post to
 * the channel. `fetch` failures routinely embed the request URL in the message
 * or in `cause`, which would write the token straight into CloudWatch Logs.
 *
 * This is the single most likely leak path in the service, so any Discord
 * webhook URL is stripped before the text goes anywhere near a log.
 */
const DISCORD_WEBHOOK_URL = /https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/gi;

export function redact(text: string): string {
  return text.replace(DISCORD_WEBHOOK_URL, 'https://discord.com/api/webhooks/<redacted>');
}
