# Summary
This project a webhook transformer that transforms VastAI Notification Webhooks payloads into Discord ingestiable webhook payloads.

# Architecture:
API Gateway (HTTP API) → Lambda (Node 24) → Discord.
## Runtime
Node.js (Typescript)
## Request flow 
1. API Gateway invokes the Lambda with the raw POST from Vast.ai.
2. Lambda reads X-Vast-Timestamp / X-Vast-Signature-256, verifies HMAC-SHA256 over <timestamp>.<raw body> using the webhook secret, rejects if stale (>300s) or invalid → 401.
3. Parses body: event_id, user_id, notif_type, subject, message, timestamp
5. Builds a Discord embed generically from any notif_type (title=subject truncated to 256, description=message truncated to 4096, footer=notif_type + event_id, embed timestamp from the payload's epoch float) and POSTs to https://discord.com/api/webhooks/{id}/{token} per the Execute Webhook contract above.
6. Returns 2xx to Vast.ai (per their retry rules) — doing the Discord POST synchronously in the same invocation since it's a single fast call well within Vast's 10s timeout; no SQS decoupling layer unless you want one for independent retry/backoff on Discord 429s.
7. Secrets (DISCORD_WEBHOOK_URL) read from SSM Parameter Store SecureString at cold start, cached in memory for the life of the execution environment.

No deduplication DB is needed. Its a simple transform, fire, and forget.

# Documentation
The README.md should have aws setup steps as well as any other requirements and setup for building and testing the app locally.

# Source Control
This will be source controlled via git and hosted on GitHub.

# Webhook documentation
Discord Webhook API Reference: https://docs.discord.com/developers/resources/webhook#execute-webhook
VastAI Notification Docs: https://docs.vast.ai/guides/reference/notification-webhooks 

Vast Example Webhook:
```
{
  "event_id": "7e9a2c4e6f9e4a24a53b77c2d8e3f0aa",
  "user_id": 123,
  "notif_type": "low_credit",
  "subject": "Warning - Your Vast.ai Credit Balance Is Getting Low",
  "message": "Your Vast.ai balance is below your configured threshold.",
  "timestamp": 1772490000.123
}
```