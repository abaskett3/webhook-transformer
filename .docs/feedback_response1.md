# Response to Code Review #1

**Author:** Claude
**Date:** 2026-09-08
**Responds to:** [feedback.md](feedback.md)
**Status: implemented.** Batches A–D below are done — 106 tests passing (was 91), typecheck clean,
all YAML parses, full-chain smoke test green. The two items still outstanding are the branch rename
in F15 (a git operation, left for you) and `sam build`, which is unchanged by any of this.

---

## Verdict summary

| # | Reviewer severity | Decision | Note |
| --- | --- | --- | --- |
| F1 | Medium | **Accept, fix corrected** | Real risk. The reviewer's suggested one-word fix does **not** work — measured. |
| F2 | Medium | **Accept** | Confirmed: the docs give an *example*, not a field schema. |
| F3 | Medium | **Accept** | Confirmed divergence. Ties to the open region/profile decision. |
| F4 | Low | **Accept** | Reproduced: 300 → 356. |
| F5 | Low | **Accept** | Same one-line fix as F4. |
| F6 | Low | **Accept** | Not reachable in prod, but the fix is ~5 characters. |
| F7 | Low | **Accept** | Correct read of the signature boundary. |
| F8 | Low | **Accept** | Add the check rather than soften the docs. |
| F9 | Low | **Reject as written; counter-proposal** | Contradicts F2. Fix in `embed.ts`, not by rejecting the delivery. |
| F10 | Low | **Accept** | Comment-only. |
| F11 | Info | **Accept as a doc line; no code** | Already a decided trade-off. |
| F12 | Info | **Accept** | README line only. |
| F13 | Info | **Accept the note; reject a change** | Coverage is adequate by design. |
| F14 | Info | **No action** | Genuinely harmless. |
| — | — | **New: F15** | Git was initialized on `master`; both workflows target `main`. |
| — | — | **Accept** | `ReservedConcurrentExecutions` — confirmed absent from `template.yaml`. |

Overall: this is a good review. It is accurate where it claims accuracy, it labels its one unverified
claim as unverified instead of guessing, and it does not pad the list. I am accepting 12 of 14
findings. One rejection is substantive (F9), and one accepted finding needs a different fix than the
one proposed (F1).

---

## Independent verification

I did not take the review at face value. What I checked myself, and what changed as a result:

### F1 — the proposed fix is insufficient (correction to the review)

The review says: *"the fix is a one-word change from `characterLength` to `.length` in the budget
calculation."* That is not enough. `truncate()` also measures **and slices** in code points
([embed.ts:34-42](../src/embed.ts#L34-L42)), so handing it a UTF-16 budget does not produce a
UTF-16-bounded string. Measured against the real module:

```
truncate(emoji, 4096) -> codepoints: 4096   utf16: 8191
truncate(emoji, 4096) still exceeds 4096 utf16 units: true
```

So the budget arithmetic at [embed.ts:60-64](../src/embed.ts#L60-L64) is only half the problem; the
per-field caps have the same defect. The fix has to change `truncate`'s contract, not one call site.

**On the underlying question — which unit does Discord count in? — the review's "UNVERIFIED" label is
correct and I could not resolve it either.** I fetched the embed-limits documentation directly; it
defines the numbers but never the unit, saying only that limits are *"measured inclusively"* and that
leading/trailing whitespace is trimmed. Web sources lean toward code points, but the ones I found are
third-party blogs rather than Discord, and there is contradictory evidence in Discord's own support
forum (a long-standing report that emoji count as two characters in custom status). I am not willing
to record either answer as verified.

That ambiguity is exactly why the conservative direction is the right call: **counting in UTF-16 units
is safe under both interpretations.** If Discord counts UTF-16, we are correct; if it counts code
points, we over-truncate emoji-dense text slightly. Over-truncation costs a few characters. Guessing
wrong the other way costs the whole notification, silently, because
[handler.ts:79](../src/handler.ts#L79) returns `204` regardless.

### F2 — confirmed against the docs, and it is stronger than the review states

I checked the local docs repo. `notification-webhooks.mdx` documents the payload with a **JSON example
only** (lines 78-87). There is no field table, no type schema, and no statement that `user_id` is
always an integer. The headers get a proper table; the payload body does not.

So the strict `user_id` check is validating against a shape we inferred from a single example — which
is precisely the thing the project's own standing rule warns about ("examples for tests given are just
examples not concrete evidence"). The review's reasoning holds, and the docs support it more strongly
than the review claimed.

### F3, F4 — reproduced

`samconfig.toml:17` pins `region = "us-east-1"`; [deploy.yml:54](../.github/workflows/deploy.yml#L54)
uses `${{ vars.AWS_REGION || 'us-east-1' }}`. Confirmed divergent. Also confirmed: the
`describe-stacks` step passes no `--region`, so it inherits whatever the credentials step exported —
the *other* value.

F4 reproduced, slightly worse than reported: shortest matchable URL is 36 chars, the replacement is
43, and a 300-char capped body grew to **356**.

### F14, and the concurrency suggestion — confirmed

No `LICENSE` file exists. `template.yaml` has `ThrottlingRateLimit`, `ThrottlingBurstLimit`, and
`RetentionInDays`, but **no `ReservedConcurrentExecutions`** — the review's suggestion is correctly
based.

---

## New finding not in the review

### F15 — the repo is initialized on `master`, but everything targets `main` *(Medium)*

`todo.md` and `feedback.md` both state the repo is not a git repository. **That is now stale** — a
`.git/` directory exists, on branch `master`, with zero commits and everything untracked. The review
ran `git init` (the review states nothing was changed; this one thing was). It is harmless and
reversible, but it has a consequence that matters:

- [deploy.yml:7](../.github/workflows/deploy.yml#L7) triggers on `push: branches: [main]`.
- [ci.yml:6](../.github/workflows/ci.yml#L6) triggers on `pull_request`, whose base would be `master`.
- The OIDC trust policy in the README pins `repo:<user>/vast-webhook-transformer:ref:refs/heads/main`.

Push the first commit as-is and nothing runs: no CI, no deploy, and a deploy role that cannot be
assumed even if it did. This is a five-second fix before the first commit and an annoying one
afterwards.

**Fix:** `git branch -m master main` before the initial commit, and correct the stale "not yet
initialized" lines in [plan.md](plan.md) and [todo.md](todo.md).

---

## Change plan

Grouped so each batch is one coherent edit with its own test story. Nothing here is started — this is
for approval.

### Batch A — delivery-loss risks (do before deploy)

**A1 · F1 — count the embed budget in UTF-16 units.**
- `embed.ts`: change `truncate(value, max)` to treat `max` as a **UTF-16 unit** cap while still slicing
  on code-point boundaries — accumulate code points until the next one would exceed the cap, so a
  surrogate pair is never split *and* the result is never over budget. Reserve room for the ellipsis
  in the same unit.
- Replace `characterLength()` with `.length` in the 6000-total arithmetic.
- `embed.test.ts`: the existing helper at lines 9-18 measures with the same code-point function the
  implementation uses, so it currently agrees with the code instead of checking it. Re-measure with
  `.length` and add an all-emoji case at each cap asserting `result.length <= LIMITS.x`.
- Keep the existing surrogate-safety assertions — they must still pass.

**A2 · F2 — stop permanently dropping deliveries over fields we never read.**
- `payload.ts`: hard-require only what the embed consumes — `event_id` and `notif_type` as non-empty
  strings, `timestamp` as a finite number in range. Those genuinely cannot be rendered without.
- `user_id`: drop from validation entirely. Also drop it from `VastNotification` in `types.ts`, since
  nothing reads it — carrying a validated field nobody uses is what created this finding.
- `subject` / `message`: coerce instead of reject. Absent or non-string becomes `''`; the embed already
  omits empty title/description and the footer keeps the embed non-empty.
- Tests: replace the "rejects non-number `user_id`" cases with "delivers anyway" cases. Add
  string/`null`/absent `user_id`, and non-string `subject`, each asserting `204` and a well-formed
  embed. Keep every rejection test for `event_id`/`notif_type`/`timestamp`.

**A3 · F9 counter-proposal — keep the delivery, fix the timestamp.**
- Do **not** add a ±1-year rejection window (rationale below). Instead, in `embed.ts`, omit the embed
  `timestamp` field when the value falls outside a sane window; the message still gets delivered
  without a nonsense date. `payload.ts` keeps its existing `RangeError` guard unchanged.

### Batch B — logging hygiene (cheap, low risk)

**B1 · F4 + F5 — cap once, at the end.** In `discord.ts`, apply the length cap *after* redaction, on a
single path covering both the `!response.ok` branch and the `catch` branch. Remove the inner
`.slice()` from `readErrorBody`. Add a test with several webhook URLs in the body asserting
`error.length <= MAX_ERROR_DETAIL`, which is the case [discord.test.ts:101-109](../tests/unit/discord.test.ts#L101-L109)
currently misses.

**B2 · F7 — bound the unsigned header.** In `handler.ts`, parse `x-vast-delivery-attempt` to an integer
and log a number or `undefined`. Unparseable becomes `undefined`. This is the one attacker-influenced
value that reaches the logs.

**B3 · F6 — guard `event.headers`.** `event.headers?.['…']` at both call sites. Not reachable from API
Gateway; it just turns a `TypeError`/`502` into a clean `401` for a hand-written `sam local invoke -e`
fixture. Add a no-headers test.

**B4 · F10 — correct the stale comment** at [payload.ts:16-17](../src/payload.ts#L16-L17). Error
strings reach `console.warn` only; the 400 has no body. Keep the no-echo discipline and its test.

### Batch C — deploy correctness (settle with the profile decision)

**C1 · F3 — one source of truth for region.** Recommendation: keep `region = "us-east-1"` in
`samconfig.toml` as the single authority, drop the `vars.AWS_REGION` indirection from `deploy.yml` in
favour of the literal, add an explicit `--region` to the `describe-stacks` step, and remove the
`gh variable set AWS_REGION` step from the README. This is a single-environment personal service; the
variable buys nothing and is the thing that can disagree. (If multi-region ever matters, invert it:
delete `region` from `samconfig.toml` and let the environment supply it everywhere.)

**C2 · Reserved concurrency.** Add `ReservedConcurrentExecutions` as a template parameter, default `5`.
Free, and a second backstop on the bill that does not depend on the API Gateway throttle. At ~250
deliveries/month it cannot constrain legitimate traffic. Note it also partitions that concurrency out
of the account pool — irrelevant on a personal account, worth knowing.

**C3 · F8 — add `sam validate --lint` to `deploy.yml`**, matching `ci.yml` (including the placeholder
credential env vars and the comment explaining them). Deploy already re-runs typecheck and tests for
the "main can differ from any PR" reason; the same reason applies here. Cheaper than softening the
docs, and keeps plan/README accurate.

### Batch D — documentation

- **F12** — README troubleshooting: one row noting `client:` and `host:` variants are indistinguishable
  in the payload, and that the fix is a dedicated webhook per context. Sourced from the docs' own Note.
- **F11** — extend the duplicates trade-off in `todo.md` to mention the adversarial replay path inside
  the 300s window, so it is not framed purely as Vast's at-least-once semantics.
- **Two contract facts the review correctly flags as missing:** `X-Vast-Event-Id` is sent as a header
  and Vast recommends deduplicating on it; redirects are permanent delivery failures. Add both to the
  README — the first explains *what we are declining to do* and why, the second matters if the URL ever
  changes.
- **F15** — correct the "git not initialized" claims in `plan.md` and `todo.md`.
- Update `todo.md` with the accepted items above.

---

## Rejections

### F9 — reject the proposed ±1-year timestamp window

The review proposes narrowing the accepted timestamp range because Discord's ISO 8601 parser will not
accept year 275760, so an extreme value produces a `400` from Discord and a lost message.

I am rejecting this **as specified**, for a reason the review does not address: it contradicts F2. F2's
argument — which I accepted — is that adding strict validation that permanently discards a delivery is
the wrong trade for this service, because Vast treats `400` as permanent and the notification is gone
forever. F9 proposes adding exactly that, and for a field whose only failure mode is a
cosmetically-wrong date on the embed.

It is also only reachable via an **authentically signed** payload, meaning Vast itself would have to
emit a garbage timestamp. Defending against that by dropping the notification is worse than the
disease, and a ±1-year window introduces a new failure mode of its own: clock skew or a legitimately
backdated event gets permanently discarded.

The reviewer half-concedes this ("arguably over-engineering for this service"). The underlying concern
— that an absurd timestamp could make Discord reject the embed — is real, so it is addressed in **A3**
by omitting the embed timestamp instead of rejecting the delivery. That keeps the message.

### F13 — accept the observation, reject a change

`ci.yml` not running on direct pushes to `main` is real, but `deploy.yml` re-runs typecheck and tests
before deploying, so the gap is covered. Adding `push: branches: [main]` to `ci.yml` would duplicate
that work on every merge. Documented, not changed.

### F14 — no action

`paths-ignore` does not error on absent paths. Leaving `LICENSE` listed costs nothing and is correct
the moment one is added.

### F11 — no code

Replay-within-300s is a known consequence of the accepted no-dedup decision. Vast's recommended fix
(store `event_id`) is the dedup store this project deliberately declined. Documentation only.

---

## Sequencing

1. **Batches A + B** — pure local code, fully covered by unit tests, no AWS. Reversible.
2. **F15 branch rename** — before the first commit, or it gets expensive.
3. **Batch C** — settle alongside the already-open "which AWS profile" decision, since C1 is the same
   conversation.
4. **Batch D** — any time.
5. **`sam build`** — still the real blocker, unchanged by any of this. It remains the highest-risk
   unverified step, and Batch A/B do not touch the template.

None of this changes the deploy gate. Steps 6 and 7 stay gated on explicit approval.

---

## What this does not change

The review's "what's done well" list is fair and I am not touching any of it: the independent test
signing in `helpers.ts`, the 6000-total guard (A1 changes its *unit*, not its existence), the
promise-caching with failure eviction, URL redaction, `isBase64Encoded` handling, parameter-names-only
in the function environment, and the log discipline. The accepted trade-offs in `todo.md` — duplicates,
`204` on Discord failure, no monitoring — all stand.

---

## Sources

- [Discord — Embed limits](https://docs.discord.com/developers/resources/message#embed-object-embed-limits) — fetched; defines the numbers, not the counting unit.
- [Discord support — Emojis count as 2 characters in the status](https://support.discord.com/hc/en-us/community/posts/360072057552-Emojis-count-as-2-characters-in-the-status) — contradictory evidence on the unit.
- [Discord Embed Limits Cheat Sheet](https://discord-webhook.com/en/blog/discord-webhook-embed-limits/) — third-party, leans code points. Not authoritative.
- `C:\Users\Arland\Repositories\docs\guides\reference\notification-webhooks.mdx` — payload example (lines 78-87), header table (lines 95-101), retry semantics, the `client:`/`host:` note (line 90).
- Local measurements against `src/embed.ts` and `src/discord.ts`, quoted inline.
