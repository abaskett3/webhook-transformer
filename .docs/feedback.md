# Code Review — vast-webhook-transformer

**Reviewer:** Claude (QA)
**Date:** 2026-09-08
**Scope:** Full repo at working-tree state. Read against [plan.md](plan.md) and [todo.md](todo.md).
**Nothing was changed.** This document is findings only.

---

## Methodology

Every claim below is backed by one of:

- **Source read** — all 7 files in [src/](../src/), all 6 unit test files, [template.yaml](../template.yaml),
  [samconfig.toml](../samconfig.toml), both GitHub workflows, [README.md](../README.md),
  [scripts/sign-payload.ts](../scripts/sign-payload.ts), `.gitignore`, both env examples, both event fixtures.
- **Commands actually run** (read-only, non-destructive):
  - `npm run typecheck` → clean, exit 0.
  - `npm test` → **6 files, 91 tests, all passing**, 311 ms.
  - A throwaway Node probe against `src/` to confirm three edge cases empirically (results quoted inline).
- **Authoritative spec** — the Vast notification webhook contract was verified against the *local docs
  repo*, `C:\Users\Arland\Repositories\docs\guides\reference\notification-webhooks.mdx`, not from memory
  and not from the plan's own summary of it.

Nothing here is assumed. Where something could not be verified, it is labelled **UNVERIFIED** explicitly.

---

## Headline

This is careful, well-documented code. The external contract in `signature.ts` matches Vast's published
Python reference exactly, the tests are honest (they don't validate the implementation against itself),
and the plan/todo docs do not overclaim — I verified the "91 tests passing", "typecheck clean", and
"git not initialized" statements in `todo.md` and all three are accurate.

The findings below are mostly **latent risks and consistency gaps**, not live bugs. Two are worth
acting on before deploy (F1, F2). Nothing here blocks step 6 on correctness grounds — the one true
blocker is the one `todo.md` already names: `sam build` has never been run.

---

## Contract verification (against the local docs repo)

The plan's "Verified external contracts" section holds up. Confirmed line-by-line against
`docs/guides/reference/notification-webhooks.mdx`:

| Plan claim | Doc says | Verdict |
| --- | --- | --- |
| Signature input `<X-Vast-Timestamp>.<raw body>` | Line 114, identical | ✅ |
| `sha256=` + hex HMAC-SHA256 | Line 101, 148 | ✅ |
| Reject if age > 300s | Line 138, `if age > 300` | ✅ |
| Don't re-serialize JSON before verifying | Line 151, stated verbatim | ✅ |
| `X-Vast-Timestamp` is an **integer** | Line 100, "Integer Unix timestamp" | ✅ |
| 2xx success; 3xx/4xx permanent except 408/429; 408/429/5xx/timeout retryable | Lines 158-163, table matches exactly | ✅ |
| 10s delivery timeout | Line 165 | ✅ |
| At-least-once delivery | Line 168 | ✅ |
| Payload shape (6 fields, float `timestamp`) | Lines 79-86, matches [events/low_credit.json](../events/low_credit.json) byte for byte | ✅ |

**`src/signature.ts` is a faithful port of the reference implementation**, with one improvement: the
reference has no empty-secret guard, and [signature.ts:42](../src/signature.ts#L42) adds one. The
`/^\d+$/` integer check is also *correct rather than merely strict* — Vast's own reference does
`int(timestamp)` inside a `try/except ValueError`, so a fractional header value is rejected on their
side too. This was worth confirming; had the header been a float, every delivery would 401.

Two facts from the docs that the code correctly relies on and that are **not** currently in the README:

- `X-Vast-Event-Id` is sent as a header, and Vast explicitly recommends deduplicating on it (line 98, 168).
- Redirect responses are treated as **permanent** delivery failures (line 68).

---

## Findings

| # | Severity | Finding | Verified how |
| --- | --- | --- | --- |
| F1 | Medium | Embed budget counted in code points; Discord's unit is unconfirmed | Probe: 4096 cp = 8192 UTF-16 units |
| F2 | Medium | Strict validation of the unused `user_id` can permanently drop deliveries | Source + docs retry table |
| F3 | Medium | Region is defined in two places and they can disagree | Source read |
| F4 | Low | `redact()` can push an error string back over its 300-char cap | Probe: 300 → 342 |
| F5 | Low | The `catch` branch of `postToDiscord` is not length-capped at all | Source read |
| F6 | Low | `handler` throws if `event.headers` is absent | Probe: TypeError |
| F7 | Low | Unsigned `x-vast-delivery-attempt` header logged raw and unbounded | Source + docs |
| F8 | Low | `deploy.yml` omits `sam validate --lint` that the docs promise | Source read |
| F9 | Low | Accepted timestamp range exceeds what Discord will parse | Source read |
| F10 | Low | `payload.ts` comment describes a 400 response body that doesn't exist | Source read |
| F11 | Info | Replay inside the 300s window is possible | Design |
| F12 | Info | `client:` vs `host:` events render identically | Docs line 90 |
| F13 | Info | `ci.yml` never runs on a direct push to `main` | Source read |
| F14 | Info | No `LICENSE` despite both workflows ignoring it | Directory listing |

---

### F1 — Embed budget is counted in code points; Discord's counting unit is unconfirmed *(Medium)*

[embed.ts:24-26](../src/embed.ts#L24-L26) counts characters as **code points** (`Array.from(value).length`),
and the 6000-total guard at [embed.ts:60-64](../src/embed.ts#L60-L64) uses that count.

Measured directly:

```
description codepoints: 4096   utf16 units: 8192
```

So a message of 4096 emoji passes the guard at "4096 characters" while being 8192 UTF-16 code units.
If Discord measures its 4096/6000 limits in UTF-16 units (the way JS `.length` does) rather than code
points, that payload is rejected with a `400` — and because
[handler.ts:79](../src/handler.ts#L79) returns `204` regardless, the notification is **silently lost**.
The only trace is a `discord delivery failed` log line.

**This is UNVERIFIED in both directions.** I did not confirm which unit Discord uses; the linked docs say
only "characters." Note also that
[embed.test.ts:9-18](../tests/unit/embed.test.ts#L9-L18) computes `budgetUsed` with the same code-point
helper as the implementation, so the test *agrees with the code* rather than checking it against Discord.

Two honest observations on impact: Vast's `subject`/`message` are English notification text, so an
emoji-dense payload is unlikely in practice — this is a latent risk, not an active bug. And the safe fix
is cheap: count with `.length` (UTF-16) for the *budget*, while continuing to slice on code-point
boundaries for *safety*. Counting conservatively can only over-truncate, never get rejected.

### F2 — Strict validation of `user_id` can permanently drop deliveries *(Medium)*

[payload.ts:48-50](../src/payload.ts#L48-L50) rejects the whole delivery if `user_id` is not a finite
number. But `user_id` **is never used** — it isn't in the embed, the footer, or the log line. It is
carried in `VastNotification` and then dropped.

The consequence is disproportionate. Vast's docs (line 161) treat `400` as a *permanent* failure with no
retry, so if Vast ever changes `user_id` to a string, sends it as `null`, or omits it for some event
type, **every affected notification is discarded forever** over a field this service does not read. The
same applies to a non-string `subject`/`message` at [payload.ts:42-46](../src/payload.ts#L42-L46).

This also sits awkwardly against the project's own stated philosophy. [payload.ts:13-14](../src/payload.ts#L13-L14)
says unknown fields are tolerated "so that new fields added by Vast don't start rejecting deliveries" —
correct instinct — and the handler deliberately returns `204` on Discord failure rather than losing the
event to a retry loop. Strict rejection on an unused field is the opposite trade.

Suggestion: hard-validate only what the embed actually needs (`event_id`, `notif_type`, `timestamp`), and
coerce or default the rest. `user_id` could drop out of validation entirely, or become advisory.

### F3 — Region defined in two places that can disagree *(Medium)*

[samconfig.toml:17](../samconfig.toml#L17) pins `region = "us-east-1"` under `[default.deploy.parameters]`.
[deploy.yml:54](../.github/workflows/deploy.yml#L54) sets the credential region from
`${{ vars.AWS_REGION || 'us-east-1' }}`, and the README (line 267) tells you to
`gh variable set AWS_REGION`.

If `AWS_REGION` is ever set to anything other than `us-east-1`, the two diverge: `configure-aws-credentials`
uses the variable, but `sam deploy` reads its region from `samconfig.toml` and deploys to `us-east-1`
anyway. The `describe-stacks` step at [deploy.yml:62-66](../.github/workflows/deploy.yml#L62-L66) then
queries whichever region the CLI defaults to and may report nothing.

Pick one source of truth — either drop `region` from `samconfig.toml` and let the env supply it, or drop
the `AWS_REGION` variable and the README step.

### F4 — `redact()` can exceed the cap it is applied after *(Low, confirmed)*

[discord.ts:40](../src/discord.ts#L40) slices to `MAX_ERROR_DETAIL` (300) **inside** `readErrorBody`, then
redacts the already-capped string. The replacement text
(`https://discord.com/api/webhooks/<redacted>`, 43 chars) is longer than the shortest URL it can match
(36 chars), so redaction grows the string. Measured:

```
capped input len: 300 -> after redact: 342
```

[discord.test.ts:101-109](../tests/unit/discord.test.ts#L101-L109) asserts `<= 300`, but only for a body
containing no webhook URLs, so it doesn't catch this. Cosmetic — it affects log volume only, and the
redaction itself is still correct. Cap after redacting if you care.

### F5 — The error path in `postToDiscord` has no length cap *(Low)*

`MAX_ERROR_DETAIL` is applied only in `readErrorBody`. The `catch` branch at
[discord.ts:45-47](../src/discord.ts#L45-L47) passes `describeError(error)` straight through, and that
concatenates `error.message` plus `error.cause.message` with no bound. An adverse network stack can
produce long messages. Same fix as F4: cap once, at the end.

### F6 — `handler` throws when `event.headers` is absent *(Low, confirmed)*

[handler.ts:40-41](../src/handler.ts#L40-L41) dereferences `event.headers[...]` unguarded. Probe result:

```
no-headers event THREW: TypeError Cannot read properties of undefined (reading 'x-vast-timestamp')
```

**Not reachable from production** — API Gateway HTTP API payload format 2.0 always includes `headers`, and
`sign-payload.ts --emit-event` always writes them. It matters only for a hand-written event passed to
`sam local invoke -e`, where you'd get an unhandled `TypeError` and a `502` instead of a clean `401`.
Listed for completeness, not as a defect worth code churn.

### F7 — An unsigned header is logged raw and unbounded *(Low)*

[handler.ts:70](../src/handler.ts#L70) logs `event.headers['x-vast-delivery-attempt']` verbatim.

Worth being precise about the security boundary here: the HMAC covers **only** `X-Vast-Timestamp` and the
raw body. Every other `X-Vast-*` header is unauthenticated and can be set freely by anyone replaying or
crafting a request whose body/timestamp pair does verify. `JSON.stringify` escapes the value, so log-format
injection is not possible — but the length is unbounded, and this is the one attacker-influenced value that
reaches the logs. Bound it to a few characters, or parse it to an integer.

### F8 — `deploy.yml` doesn't run the check the docs say it runs *(Low)*

Both [plan.md:116](plan.md#L116) and [README.md:160](../README.md#L160) describe deploy.yml as running
"the same checks, then `sam deploy`." It runs `npm run typecheck`, `npm test`, and `sam build`, but
**not** `sam validate --lint`, which [ci.yml:41-49](../.github/workflows/ci.yml#L41-L49) does run. Either
add it or soften the wording.

### F9 — Accepted timestamp range is wider than Discord will parse *(Low)*

[payload.ts:8](../src/payload.ts#L8) caps at `8.64e12` seconds, which is correct for keeping
`toISOString()` from throwing `RangeError` — the stated goal, and it works. But that admits timestamps up
to year ±275760, and Discord's ISO 8601 parser will not accept those, producing a `400` and a lost message.

Only reachable via an authentically-signed payload, so this is robustness rather than security. A sanity
window (say, ±1 year of now) would be more useful than the `Date`-representable bound, though it's
arguably over-engineering for this service.

### F10 — Stale comment about the 400 response body *(Low)*

[payload.ts:16-17](../src/payload.ts#L16-L17) says error strings "end up in logs and in the 400 response."
They don't — [handler.ts:56](../src/handler.ts#L56) returns `{ statusCode: 400 }` with no body, and the
error only reaches `console.warn`.

The discipline of not echoing field values is still right and
[payload.test.ts:101-106](../tests/unit/payload.test.ts#L101-L106) tests it. The comment just describes a
disclosure surface that doesn't exist, which could mislead a future reader into thinking one does.

### F11 — Replay within the 300s window *(Info)*

No dedup store and no nonce, so a captured valid request replayed inside 300 seconds produces a duplicate
Discord message. This is consistent with the accepted "duplicates are fine" trade-off in
[todo.md:86-87](todo.md#L86-L87) and is not a defect.

Worth noting only because the docs currently frame duplicates purely as a *delivery-semantics* consequence
of Vast's at-least-once retries. There is also a small *adversarial* path to the same outcome. Vast's docs
(line 168) recommend storing `event_id` to suppress it; the project declined that by decision, which is
reasonable for a personal Discord relay.

### F12 — `client:` and `host:` events render identically *(Info)*

Vast's docs (line 90) state the payload's `notif_type` is the short slug **without** the `client:`/`host:`
prefix, and advise "use a dedicated webhook per context to tell them apart reliably."
[types.ts:10](../src/types.ts#L10) documents this correctly, but the footer built at
[embed.ts:52-55](../src/embed.ts#L52-L55) carries only the slug. Subscribe one webhook to both
`client:low_credit` and `host:low_credit` and the two are indistinguishable in Discord.

Not fixable in code — the distinguishing information isn't in the payload. Worth one line in the README's
troubleshooting table.

### F13 — `ci.yml` never runs on a direct push to `main` *(Info)*

[ci.yml:5-10](../.github/workflows/ci.yml#L5-L10) triggers on `pull_request` only. The initial push in
step 7, and any later direct commit to `main`, runs no CI — it goes straight to `deploy.yml`. Coverage is
adequate in practice because deploy.yml re-runs typecheck and tests before deploying (a good call, and the
comment at [deploy.yml:39-40](../.github/workflows/deploy.yml#L39-L40) explains why). Noting the asymmetry
only so it isn't a surprise.

### F14 — No `LICENSE` file *(Info)*

Both workflows list `LICENSE` in `paths-ignore` and no such file exists. Harmless; `paths-ignore` doesn't
error on absent paths.

---

## What's done well

Calling these out explicitly, because several are non-obvious and shouldn't get lost in a findings list:

- **[helpers.ts:20-22](../tests/helpers.ts#L20-L22) signs independently of `src/signature.ts`.** This is
  the single best decision in the test suite — it means a bug in the implementation cannot make the tests
  agree with it. Most codebases get this wrong.
- **The 6000-character total guard.** Per-field caps sum to 6400, which Discord rejects outright. This is
  a genuine trap and [embed.ts:60-64](../src/embed.ts#L60-L64) catches it, with
  [embed.test.ts:87-102](../tests/unit/embed.test.ts#L87-L102) pinning the exact failing case. (F1 is about
  the *unit* of counting, not the existence of the guard.)
- **Promise-caching with failure eviction** in [config.ts:15-24](../src/config.ts#L15-L24). Caching the
  promise rather than the value collapses concurrent cold starts into one `GetParameters`, and clearing
  the cache on rejection avoids poisoning the sandbox. Both behaviours are directly tested
  ([config.test.ts:94-126](../tests/unit/config.test.ts#L94-L126)).
- **Redaction of the Discord URL before logging.** Correctly identified as the highest-risk leak path,
  handled at both the response-body and the `cause` chain, and tested across four URL variants.
- **The `isBase64Encoded` handling** at [handler.ts:89-92](../src/handler.ts#L89-L92) — a classic source of
  "every signature fails in prod but works locally," and it has a dedicated test.
- **Secrets held as SSM parameter *names* in the function env,** so `lambda:GetFunction` doesn't disclose
  them. The KMS grant is correctly conditioned on `kms:ViaService`.
- **Log discipline.** No notification content, no secrets; asserted by two explicit tests
  ([handler.test.ts:168-185](../tests/unit/handler.test.ts#L168-L185)).
- **`.gitignore` ordering is correct** — `.env.*` would swallow `.env.example`, and the `!.env.example`
  negation on the next line rescues it. Easy to get backwards.
- **Comments explain *why*, not *what*.** Nearly every non-obvious line has a rationale attached. This is
  unusually good.

---

## On the plan and todo docs

Both are accurate, which is worth stating since I checked rather than assumed:

- "91 passing across 6 files" — **confirmed**, ran it.
- "`npm run typecheck` clean" — **confirmed**, exit 0.
- "`git init` — not yet initialized" — **confirmed**, the repo is not a git repository.
- The plan's external-contract section — **confirmed** against the local docs repo, point by point.

`todo.md` correctly identifies the real blocker. To reinforce it: **`sam build` is the highest-risk
unverified step in the project**, and everything else is downstream of it. The specific things it would
prove are the ESM output naming (`OutExtension: - .js=.mjs` at
[template.yaml:72-73](../template.yaml#L72-L73) producing `handler.mjs` to satisfy
`Handler: handler.handler`), and that esbuild bundles `@aws-sdk/client-ssm` cleanly. Both are plausible as
written; neither has been executed.

Two smaller items not currently in `todo.md` that you may want to add:

- **`ReservedConcurrentExecutions` is not set.** The 2 rps route throttle bounds the request rate, but a
  concurrency cap is a free second backstop on the bill. Given the cost section treats a scanning flood as
  "the actual risk," it fits the threat model.
- **F3 (region defined twice)** should be settled at the same time as the "which AWS profile" decision
  that's already open, since they're the same conversation.

---

## Recommendation

Nothing found here blocks deploy on correctness. If you want to touch code before step 6, I'd do **F2**
(stop rejecting on an unused field — highest real-world payoff, since it's the one that can permanently
discard a notification) and **F3** (region ambiguity — cheapest to fix now, most annoying to debug later).

**F1** is the one I'd most want an answer on before calling this done, but the answer is a docs question
for Discord, not a code change — and if the answer is "UTF-16," the fix is a one-word change from
`characterLength` to `.length` in the budget calculation.

Everything else is cleanup that can wait, or is already a documented, deliberate trade-off.
