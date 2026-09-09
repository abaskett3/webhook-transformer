# TODO — vast-webhook-transformer

Remaining work as of 2026-09-08. Build steps 1–5 of [plan.md](plan.md) are complete; everything
below is what's left.

## Done

- [x] Scaffold (package.json, tsconfig, vitest, .gitignore)
- [x] Pure logic + unit tests: `types`, `signature`, `payload`, `embed`
- [x] `config`, `discord`, `handler` + mocked tests
- [x] `template.yaml`, `samconfig.toml`, event fixtures, `scripts/sign-payload.ts`
- [x] GitHub Actions workflows (`ci.yml`, `deploy.yml`)
- [x] `README.md`
- [x] Code review round 1 applied — see [feedback_response1.md](feedback_response1.md) for what was
      accepted, what was rejected, and why

**Verified locally:** `npm test` → 106 passing across 6 files (no AWS, no network);
`npm run typecheck` clean; `sign-payload.ts` works in all three modes under Node 24 native type
stripping; full-chain smoke test (independently-signed event → real handler → `204`, no secret or
notification content in logs); all YAML parses.

## Blocking

- [ ] **Install the AWS SAM CLI.** The one gap in verification — `sam validate`, `sam build`, and
      `sam local` have never been run on this machine. Everything upstream of them is confirmed.
      [Install guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html).
  - [ ] `sam validate --lint`
  - [ ] `sam build` — confirms the esbuild ESM bundle actually produces `handler.mjs`
  - [ ] `sam local start-api` + `node scripts/sign-payload.ts --url http://127.0.0.1:3000/webhook`
        → expect `204` and a real message in a private test Discord channel

## Decisions needed

- [ ] **Which AWS profile is the personal account?** `default`, `hf-test`, and `VastAITesting` all
      exist locally; default region is `us-east-1`. Must be settled before any deploy.
- [ ] **Route path** — `/webhook` is currently hardcoded in `template.yaml`.
- [ ] **Stack name vs. repo name.** The remote is `abaskett3/webhook-transformer`, but the
      CloudFormation stack, the SSM parameter paths, and the log group all say
      `vast-webhook-transformer`. Harmless if left alone — just confirm it's intentional before the
      names are baked into deployed resources.

## Deploy (step 6 — gated, creates billable resources)

- [ ] Create the two SSM SecureString parameters by hand (CloudFormation can't create them).
      Use `--value file://…` and delete the file after; an inline `--value` lands the secret in
      shell history. See "AWS setup" in the README.
  - [ ] `/vast-webhook-transformer/discord-webhook-url`
  - [ ] `/vast-webhook-transformer/vast-webhook-secret`
- [ ] `sam deploy --guided` (first time only)
- [ ] Capture the `WebhookUrl` stack output
- [ ] Paste it into Vast → Account Settings → Notification Settings → Create webhook, select events,
      **and save the notification settings form** (webhook changes aren't persisted otherwise)
- [ ] Copy the `webhook_secret` immediately — it's shown only on create and on rotate
- [ ] Fire Vast's test-delivery endpoint and confirm the message lands
- [ ] Optional: AWS Budgets alert at ~$5/month. Free for the first two budgets, and API Gateway has
      no hard spend limit.

## Source control (step 7 — gated)

- [x] `git init` — done; remote is `git@github.com:abaskett3/webhook-transformer.git`
- [x] Renamed `master` → `main`, locally and on the remote; GitHub default branch flipped to match
- [x] Committed the rest of the tree and pushed
- [x] Confirmed the GitHub repo is **private**
- [x] Set up OIDC for deploys — role is named `gh-vast-webhook-deploy` (not `gha-`), trust policy
      pinned to the `production` environment claim. See "One-time OIDC setup for deploys" in the
      README for the full walkthrough and the two gotchas hit getting it working:
  - The job's `environment: production` means the `sub` claim is
    `repo:OWNER/REPO:environment:production`, not `repo:OWNER/REPO:ref:refs/heads/main`.
  - This repo was created after GitHub's July 15, 2026 change to immutable-ID `sub` claims for new
    repos, so the real working value embeds numeric IDs:
    `repo:abaskett3@10681302/webhook-transformer@1362037256:environment:production`.
  - `AWS_DEPLOY_ROLE_ARN` is set via `gh secret set`. `gh variable set AWS_REGION` was never done —
    the region was deliberately kept out of workflow variables (see "region single-sourcing" in the
    README) rather than added as one.

## Flagged — read before acting

- **The deploy IAM grant in the README is broad** (`PowerUserAccess` plus scoped IAM actions). The
  real security control is the OIDC trust policy. Keep the `sub` condition on `StringEquals` with
  the exact branch ref — the `StringLike` wildcard form GitHub's docs also show
  (`repo:<you>/<repo>:*`) would let *any* branch or PR assume the role, meaning anyone who can open
  a PR could deploy. Narrow the permissions to specific CloudFormation/S3/Lambda/API Gateway/Logs
  actions if the broad grant isn't acceptable.
- **`paths-ignore` vs. required checks.** Both workflows skip `**/*.md`, `LICENSE`, and `.gitignore`
  as requested. If the CI check is later marked *required* for merging, a docs-only PR will never
  report it and will sit unmergeable. Fix by adding a companion job that reports success for skipped
  paths.
- **Rotation is not seamless.** Warm Lambda environments cache the old secret, and Vast treats `401`
  as a *permanent* failure — so a delivery signed with a new secret arriving before the new value is
  live is dropped, never retried. Rotate when it's quiet and force fresh execution environments with
  a trivial redeploy.

## Accepted trade-offs — not bugs

- **Duplicate Discord messages are possible.** Vast delivers at least once and there is no dedup
  store, by decision. Vast sends `X-Vast-Event-Id` and recommends deduplicating on it. Note this
  also has an adversarial path, not just a delivery-semantics one: a captured valid request replayed
  inside the 300s signature window produces a duplicate. Same accepted outcome, different cause.
- **The handler returns `204` even when Discord fails.** A retry would hit the same failure, and
  without dedup it risks duplicating the message.
- **No monitoring, alarms, or dashboards.** Out of scope for a non-mission-critical personal
  service.

## Possible later

- [ ] Companion CI job so docs-only PRs can satisfy a required status check
- [ ] Lint/format (ESLint + Prettier) — deliberately not in v1
- [ ] Narrow the deploy role to least privilege
- [ ] Embed colour keyed off `notif_type` (currently generic on purpose, so new Vast event types
      need no code change)
- [ ] **Settle Discord's character-counting unit.** The embed budget now counts UTF-16 units, which
      is safe either way but over-truncates emoji-dense text if Discord actually counts code points.
      Discord's docs don't say. Answerable empirically after deploy: post a 4096-emoji description
      and see whether it's accepted.
