import type { DiscordEmbed, DiscordWebhookPayload, VastNotification } from './types.ts';

/**
 * Discord embed character limits.
 *
 * `total` is the sum of title + description + footer.text (plus author name and
 * field text, which this transformer doesn't use) across ALL embeds in the
 * message. Exceeding any single limit — or the total — makes Discord reject the
 * whole request, so the per-field caps alone are not enough: 256 + 4096 + 2048
 * is 6400, which is over budget.
 *
 * Source: https://docs.discord.com/developers/resources/message#embed-object-embed-limits
 */
export const LIMITS = {
  title: 256,
  description: 4096,
  footer: 2048,
  total: 6000,
} as const;

/** One UTF-16 unit (U+2026), so it costs exactly 1 against every budget. */
const ELLIPSIS = '…';

/**
 * Truncates to `max` UTF-16 code units, marking the cut with an ellipsis.
 *
 * Two different units are in play and conflating them is the bug this guards
 * against. Discord's documentation states the 256/4096/2048/6000 limits without
 * ever defining whether a "character" is a code point or a UTF-16 unit, and the
 * question could not be settled from an authoritative source. So the budget is
 * counted in UTF-16 units — the conservative reading, since it is correct if
 * Discord counts that way and merely over-truncates if it counts code points.
 * Guessing the other way would make Discord reject the payload outright, and
 * the handler returns 204 regardless, so the notification would vanish silently.
 *
 * Slicing still happens on code-point boundaries, so a multi-byte character (an
 * emoji, say) is never split into a lone surrogate.
 */
export function truncate(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  if (max === 1) return ELLIPSIS;

  // Reserve one unit for the ellipsis, then take whole code points while they
  // fit. A surrogate pair costs 2, so the last one may leave a unit unused.
  const budget = max - 1;
  let used = 0;
  let result = '';

  for (const point of value) {
    if (used + point.length > budget) break;
    result += point;
    used += point.length;
  }

  return result + ELLIPSIS;
}

/**
 * Renders the event time as an ISO 8601 string, or omits it.
 *
 * Outside years 0000-9999 `toISOString()` switches to the expanded-year form
 * (`+275760-09-13T00:00:00.000Z`), which ISO 8601 parsers generally reject —
 * and a rejected embed means a lost notification. Dropping just the timestamp
 * keeps the message deliverable. (`payload.ts` has already ruled out values
 * that would make `toISOString()` throw outright.)
 */
function isoTimestamp(epochSeconds: number): string | undefined {
  const iso = new Date(epochSeconds * 1000).toISOString();
  return iso.startsWith('+') || iso.startsWith('-') ? undefined : iso;
}

/**
 * Converts a Vast notification into a Discord Execute Webhook body.
 *
 * Deliberately generic: every notif_type renders the same way, so a new event
 * type from Vast needs no code change here.
 */
export function buildDiscordPayload(notification: VastNotification): DiscordWebhookPayload {
  const title = truncate(notification.subject, LIMITS.title);
  const footer = truncate(
    `${notification.notif_type} • ${notification.event_id}`,
    LIMITS.footer,
  );
  let description = truncate(notification.message, LIMITS.description);

  // Bring the combined length under the 6000 budget by shaving the description,
  // which is both the largest field and the most tolerant of being cut. Counted
  // in the same UTF-16 units as the per-field caps above.
  const overflow = title.length + description.length + footer.length - LIMITS.total;
  if (overflow > 0) {
    description = truncate(description, description.length - overflow);
  }

  const embed: DiscordEmbed = {
    // The footer is always present (notif_type and event_id are required and
    // non-empty), so the embed can never be wholly empty — which Discord
    // rejects. Empty title/description are omitted rather than sent blank.
    footer: { text: footer },
  };

  const timestamp = isoTimestamp(notification.timestamp);
  if (timestamp !== undefined) embed.timestamp = timestamp;
  if (title.length > 0) embed.title = title;
  if (description.length > 0) embed.description = description;

  return { embeds: [embed] };
}
