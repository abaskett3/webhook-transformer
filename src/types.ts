/**
 * The JSON body Vast.ai POSTs to the webhook endpoint.
 *
 * Source: https://docs.vast.ai/guides/reference/notification-webhooks
 *
 * Only the fields this transformer actually renders are modelled. Vast's docs
 * describe the body with an example rather than a field schema, so treating any
 * unrendered field as load-bearing would mean guessing at a contract. `user_id`
 * is sent but never used, so it is deliberately absent here — see payload.ts.
 */
export interface VastNotification {
  /** Stable event ID, also sent as the X-Vast-Event-Id header. */
  event_id: string;
  /** Short slug such as `low_credit` — no `client:` / `host:` prefix. */
  notif_type: string;
  subject: string;
  message: string;
  /** Event time as floating-point epoch seconds. */
  timestamp: number;
}

/**
 * The subset of Discord's embed object this transformer emits.
 *
 * Source: https://docs.discord.com/developers/resources/message#embed-object
 */
export interface DiscordEmbedFooter {
  text: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  footer?: DiscordEmbedFooter;
  /** ISO 8601 timestamp string. Discord rejects epoch numbers here. */
  timestamp?: string;
}

/** The body POSTed to https://discord.com/api/webhooks/{id}/{token}. */
export interface DiscordWebhookPayload {
  embeds: DiscordEmbed[];
}

/** Discriminated result used by the pure parsing/validation helpers. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
