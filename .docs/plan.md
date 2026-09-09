# v1 Implementation Plan — vast-webhook-transformer

> Status as of 2026-09-08: **steps 1–5 complete**, plus the accepted findings from code review
> round 1 ([feedback.md](feedback.md) → [feedback_response1.md](feedback_response1.md)).
> Steps 6 (deploy) and 7 (push to GitHub) are still gated on explicit go-ahead.

## Context

A standalone **personal project** (unrelated to Vast.ai's codebase or infra — no other local repo
informs its design). It receives Vast.ai notification webhooks at a public HTTPS endpoint, verifies
the HMAC signature, converts the payload to a Discord embed, and forwards it to a Discord channel
webhook.

**Not mission critical.** Low traffic, personal use, worst-case failure is a missed or duplicated
Discord message. Scoped accordingly: no monitoring, no alarms, no dashboards, no dedup store, no
queueing, no multi-environment support.

**Non-goals:** never creates, updates, rotates, or deletes Vast webhooks — none of Vast's
webhook-management API is called. The `webhook_secret` comes from the Vast console once, and is used
only as the HMAC key.

## Verified external contracts

Confirmed against real sources, not assumed:

- Signature input is `<X-Vast-Timestamp>.<raw body bytes>`, header is `sha256=` + hex HMAC-SHA256,
  reject if age > 300s, and **do not re-serialize JSON before verifying**. Payload is `event_id`,
  `user_id`, `notif_type`, `subject`, `message`, `timestamp` (float epoch).
  — [Vast notification webhooks](https://docs.vast.ai/guides/reference/notification-webhooks)
- **Vast retry rules:** `2xx` success; `3xx` and `4xx` (except 408/429) permanent failure;
  `408`/`429`/`5xx`/timeout retryable; 10s delivery timeout; at-least-once delivery.
- **Discord embed limits:** title 256, description 4096, footer 2048, **6000 total** — exceeding any
  cap rejects the whole payload. Embed `timestamp` must be an ISO 8601 string.
- `nodejs24.x` is a GA Lambda managed runtime. Local Node is 24.19.0, so dev and runtime match.

## Decisions

No dedup (a Vast retry may duplicate a Discord message — fine). Always return `2xx` once the
signature verifies, whatever Discord does. Validate the body; malformed → `400`, bad signature →
`401`, secrets unavailable → `500`. AWS SAM, single environment, secrets as SSM SecureString.
Private repo on a personal GitHub account, deployed to a personal AWS account.

**Validation is deliberately minimal.** A `400` is *permanent* in Vast's retry model, so every
rejection discards a notification for good. Only fields the embed cannot be built without are
hard-required — `event_id`, `notif_type`, and a usable `timestamp`. Display text is coerced, and
`user_id` isn't validated at all: it's never rendered, and Vast documents the body with an example
rather than a field schema, so rejecting on its shape would enforce a contract that was only ever
inferred.

## Structure

```
src/
  handler.ts    orchestrates verify → parse → build → post → respond
  signature.ts  HMAC + staleness (pure)
  payload.ts    field validation (pure)
  embed.ts      payload → Discord embed (pure)
  discord.ts    POST to Discord; never throws
  config.ts     env-or-SSM, cached at module scope
  types.ts
tests/unit/     signature / payload / embed / discord / config / handler
scripts/sign-payload.ts   dev helper: emits a validly-signed request
events/                   sample Vast payloads
.github/workflows/        ci.yml, deploy.yml
template.yaml  samconfig.toml  package.json  tsconfig.json
vitest.config.ts  .gitignore  .env.example  env.json.example  README.md
```

ESM, bundled by esbuild via SAM's `BuildMethod: esbuild`. Vitest. Relative imports carry `.ts`
extensions so Node 24's native type stripping runs the sources directly with no build step.
`erasableSyntaxOnly` is on to keep that guarantee enforced.

## Implementation notes

**`handler.ts`** (HTTP API payload format 2.0): recover raw body bytes honoring `isBase64Encoded`
(HMAC must see exact bytes) → read `x-vast-timestamp` / `x-vast-signature-256` (HTTP API lowercases
header keys) → verify, else `401` → parse + validate, else `400` → build embed → POST to Discord →
one structured log line → return **`204`**.

**`signature.ts`**: require an integer timestamp and `sha256=` prefix; reject if
`abs(now - ts) > 300`; HMAC over `Buffer.concat([Buffer.from(ts + '.'), rawBody])`; compare with
`timingSafeEqual` behind an equal-length guard (a length mismatch must return false, not throw).

**`embed.ts`** — the details that actually break things:

- Truncate title→256, description→4096, footer→2048, **and cap the 6000 total** (worst case
  256+4096+2048 = 6400 would make Discord reject the payload outright).
- **Budget counted in UTF-16 units, sliced on code-point boundaries.** Discord documents the limits
  without defining the unit, and it could not be settled from an authoritative source. UTF-16 is the
  conservative reading: correct if Discord counts that way, merely over-truncating if it counts code
  points. The other guess loses the notification silently, since the handler returns 204 regardless.
  Slicing stays on code-point boundaries so an emoji never splits into a lone surrogate.
- `timestamp`: `new Date(payload.timestamp * 1000).toISOString()`; a non-finite or out-of-range
  value throws `RangeError`, so validation rejects it upstream. In-range but absurd values produce
  the expanded-year form (`+275760-…`) that ISO 8601 parsers reject, so the embed **omits the
  timestamp** rather than losing the whole delivery.
- Footer: `` `${notif_type} • ${event_id}` ``.
- Empty title/description are omitted rather than sent blank — Discord rejects a wholly empty embed,
  and the footer is always present.

**`config.ts`**: reads `process.env` first — if both values are set (local dev, tests, `sam local`),
it uses those and never calls AWS. Otherwise one `GetParameters` call (both params,
`WithDecryption`) at module init, cached for the life of the execution environment. Caches the
*promise* so concurrent cold invocations share one call, and clears the cache on failure so a
transient SSM error doesn't poison the sandbox.

**`discord.ts`**: native `fetch` with `AbortSignal.timeout` (5s), well inside Vast's 10s budget.
Never throws. Strips any Discord webhook URL out of error text before it can reach a log.

## SAM template

`AWS::Serverless::Function` on `nodejs24.x`/`arm64`, `Timeout: 10`, `MemorySize: 256`, env vars
carrying the two SSM parameter *names*. `HttpApi` event on `POST /webhook` with route throttling at
**2 rps / burst 5** — the endpoint is public by necessity (auth is the in-Lambda HMAC), and the
throttle is what bounds the bill if it gets scanned. `ReservedConcurrentExecutions: 5` is a second,
independent ceiling on spend that holds even if the throttle is misconfigured. IAM: `ssm:GetParameters` on the two parameter
ARNs plus `kms:Decrypt` conditioned on `kms:ViaService = ssm.<region>.amazonaws.com`. Log group with
`RetentionInDays: 14`. Outputs the endpoint URL.

**The SSM parameters are created manually** — CloudFormation can't create SecureString parameters,
and secret values shouldn't be in IaC. Names: `/vast-webhook-transformer/discord-webhook-url`,
`/vast-webhook-transformer/vast-webhook-secret`.

## CI/CD

Added after the initial plan, at the user's request.

| Workflow | Trigger | Does |
| --- | --- | --- |
| `ci.yml` | PR opened, and every push to the PR branch | typecheck, test, `sam validate --lint`, `sam build` |
| `deploy.yml` | push to `main` (a merged PR) | the same checks, then `sam deploy` |

Both use `paths-ignore` for `**/*.md`, `LICENSE`, `.gitignore` so documentation changes neither run
CI nor redeploy. Deploys authenticate via GitHub OIDC — no long-lived AWS keys — with the role's
trust policy pinned to `repo:<user>/<repo>:ref:refs/heads/main`. Setup steps are in README.md.

**Region has one source of truth: `samconfig.toml`.** `sam deploy` reads it from there, so a
workflow variable could only disagree with it — authenticating against one region while the stack
deployed to another. `deploy.yml` hardcodes the matching literal instead.

Known sharp edge: if the CI check is later made *required* for merging, doc-only PRs will never
report it and will sit unmergeable.

## Cost

Nothing in the stack has an idle or hourly charge. At ~250 deliveries/month the metered cost is
about **$0.003**, and every line item lands inside an always-free allowance, so the realistic bill is
**$0.00**.

| Line item | Volume | Rate | Monthly |
| --- | --- | --- | --- |
| Lambda compute | 62.5 GB-s | $0.0000133334 / GB-s (arm64) | $0.0008 |
| Lambda requests | 250 | $0.20 / M | $0.0001 |
| API Gateway HTTP API | 250 | $1.00 / M | $0.0003 |
| CloudWatch Logs ingest | ~0.25 MB | $0.50 / GB | $0.0001 |
| KMS `Decrypt` | ~500 | $0.03 / 10k | $0.0015 |
| SSM Parameter Store | standard tier | free | $0 |
| **Total** | | | **≈ $0.003** |

Assumes 256 MB / arm64 and a conservative 1.0s billed duration (at ~8 deliveries/day every invoke is
a cold start, and INIT has been billed for on-demand managed-runtime ZIP functions since
2025-08-01).

**The actual risk** is that `/webhook` is public and unauthenticated: rejecting junk still costs an
API Gateway request and a Lambda invoke. 1M junk requests ≈ $1.40; a sustained flood at a 5 rps
throttle ≈ $18/month; at the chosen 2 rps / burst 5 ≈ $7. An AWS Budgets alert at ~$5 is a free
backstop, since API Gateway has no hard spend limit.

## Secrets

SecureString, standard tier (free), AWS-managed `alias/aws/ssm` key. Chosen over plain env vars for
the CloudTrail trail and rotate-without-redeploy; over Secrets Manager because managed rotation and
cross-account don't apply here.

- Create with `--value file://…` then delete the file — an inline `--value` writes the secret into
  shell history.
- **The Discord webhook URL is a bearer credential in a URL.** A failed `fetch` often embeds the
  request URL in the thrown error, so `discord.ts` redacts before logging. Never log the raw event
  or a whole config object.
- Local dev uses throwaway values: a dev Discord webhook into a private test channel, and any random
  string as the HMAC key. `.env` / `env.json` gitignored; `.env.example` / `env.json.example`
  committed.
- Rotation sharp edge: Vast treats 4xx as *permanent*, so a delivery signed with a rotated secret
  arriving before the new value is live gets a `401` and is dropped, not retried. Rotate when it's
  quiet.

## Testing

**Unit (no AWS, no network) — 106 tests, all passing.** Signature: valid, edge-of-window, multi-byte
body, wrong secret, tampered body, re-serialized body, stale, future, wrong timestamp, malformed
headers, empty secret, length-mismatch no-throw. Payload: documented example, extra fields tolerated,
rejection of the fields that are genuinely required, coercion (not rejection) of display text and
`user_id`, out-of-range timestamp, no stringifying of coerced values, and that error strings never
echo field values. Embed: truncation at each cap measured in UTF-16 units, all-emoji payloads at
every cap, surrogate-pair safety, the 6000 total guard, fractional epoch → ISO 8601, timestamp
omitted outside years 0000-9999, empty fields omitted. Discord: redaction across URL variants, error-body cap
(including a body full of webhook URLs, where redaction lengthens the text, and a long error from
the network stack), abort signal, never throws. Config: env path makes no AWS call, single decrypted
GetParameters, caching, shared concurrent call, failures not cached, missing parameter fails loudly.
Handler: 204 happy path, base64 body, 204 despite Discord 4xx/5xx/network failure, 401/400/500
paths, delivery-attempt header parsed to a number and dropped when junk, a headerless event yielding
401 rather than throwing, and that logs contain neither the webhook token nor the notification
content.

**Integration (`sam local`, then deployed):** signed request → 204 and a real Discord message; bad
signature → 401; stale timestamp → 401; malformed JSON → 400; oversized subject/message → 204 with a
truncated message.

**End-to-end:** Vast's test-delivery endpoint (`POST /api/v0/webhooks/{id}/test/`) fired at the
deployed URL.

## Verification

`npm test` green → `sam validate` and `sam build` succeed → `sam local start-api` with
`scripts/sign-payload.ts` produces a Discord message → after deploy, run the integration cases
against the live URL and trigger Vast's test delivery.

## Build order

1. ✅ Scaffold (package.json, tsconfig, vitest, .gitignore).
2. ✅ Pure logic + unit tests: `types`, `signature`, `payload`, `embed`.
3. ✅ `config`, `discord`, `handler` + mocked tests.
4. ✅ `template.yaml`, `samconfig.toml`, fixtures, `sign-payload.ts`, GitHub workflows.
5. ✅ `README.md`.
6. ⬜ **Deploy** — real billable resources; ask first.
7. ⬜ **Create the private GitHub repo and push** — ask first.

## Open items

- **AWS SAM CLI isn't installed** on this machine, so `sam validate` / `sam build` /
  `sam local` have not been run. Everything else has been verified locally. (Node 24.19.0, AWS CLI
  v2.36.29, Docker 29.6.2, gh 2.97.0 are present.)
- **The repo is on branch `master`, but every deploy path targets `main`** — `deploy.yml` triggers
  on `main` and the OIDC trust policy pins `refs/heads/main`. Rename before the first push.
- Which AWS profile is the personal account — `default`, `hf-test`, `VastAITesting` exist, default
  region `us-east-1`. Confirm before deploying.
- Discord webhook URL and Vast `webhook_secret` values to be placed in SSM. Never echoed to files,
  logs, or chat.
- Route path — `/webhook` is currently hardcoded. (Repo name is settled: `webhook-transformer`.)
