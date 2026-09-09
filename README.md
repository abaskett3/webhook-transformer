# vast-webhook-transformer

Receives [Vast.ai notification webhooks](https://docs.vast.ai/guides/reference/notification-webhooks),
verifies the HMAC signature, and forwards each event to a Discord channel as an embed.

```
Vast.ai ──POST──▶ API Gateway (HTTP API) ──▶ Lambda (Node 24, arm64) ──▶ Discord webhook
                                                │
                                                └──▶ SSM Parameter Store (SecureString)
```

The Lambda verifies the signature, validates the body, builds an embed, POSTs it to Discord, and
returns `204` — all in one invocation. There is no queue, no database, and no deduplication.

**Behaviour worth knowing up front:**

| Situation | Response | Why |
| --- | --- | --- |
| Valid signature, Discord accepted | `204` | Delivered. |
| Valid signature, Discord failed | `204` | A retry would hit the same failure, and with no dedup store it risks a duplicate message. |
| Bad or stale signature (>300s) | `401` | Vast treats 4xx as permanent and won't retry. |
| Malformed body | `400` | Same — a retry can't fix it. |
| Secrets unavailable | `500` | Transient, so Vast *will* retry. |

Vast delivers **at least once**. Since this service doesn't deduplicate, a Vast-side retry can
produce a duplicate Discord message. That's an accepted trade-off, not an oversight.

## Requirements

| Tool | Notes |
| --- | --- |
| Node.js 24+ | The runtime target. Type stripping means `.ts` files run without a build step. |
| AWS SAM CLI | Needed for `sam build` / `sam local` / `sam deploy`. [Install guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html). |
| AWS CLI v2 | Configured with credentials for the target account. |
| Docker | Only for `sam local`. |

You also need:

- A **Discord webhook URL** — Server Settings → Integrations → Webhooks → New Webhook.
- A Vast **`webhook_secret`** — shown only when the webhook is created or its secret is rotated.
  Copy it then; it is never shown again.

## Quick start (local, no AWS)

```bash
npm ci
npm test          # unit tests
npm run typecheck
```

The tests need no credentials and make no network calls.

### Running the handler locally

```bash
cp .env.example .env              # throwaway values
cp env.json.example env.json      # same values, SAM's format

sam build
sam local start-api               # serves http://127.0.0.1:3000/webhook
```

In another shell, send a correctly signed request:

```bash
node scripts/sign-payload.ts --url http://127.0.0.1:3000/webhook
```

`scripts/sign-payload.ts` signs a payload exactly the way Vast does. Other modes:

```bash
node scripts/sign-payload.ts                                  # print a curl command
node scripts/sign-payload.ts --fresh                          # rewrite event_id + timestamp
node scripts/sign-payload.ts --file events/webhook_test.json
node scripts/sign-payload.ts --emit-event events/x.event.json # for `sam local invoke -e`
```

Signatures expire after 300 seconds — regenerate if you start seeing `401`.

> When `DISCORD_WEBHOOK_URL` and `VAST_WEBHOOK_SECRET` are both set in the environment,
> [`src/config.ts`](src/config.ts) uses them directly and never calls AWS. That's what makes local
> runs work without credentials. Use a **private test channel** and a throwaway secret — the local
> secret only has to match what `sign-payload.ts` uses.

## AWS setup

### 1. Create the secrets in SSM Parameter Store

CloudFormation cannot create `SecureString` parameters, and secret values must not live in the
template — so these are created once, by hand. Both are **standard tier**, which is free, encrypted
with the AWS-managed `alias/aws/ssm` key.

Write the values to temp files first. An inline `--value` lands the secret in your shell history:

```bash
printf '%s' 'https://discord.com/api/webhooks/ID/TOKEN' > discord-url.txt
printf '%s' 'the-vast-webhook-secret' > vast-secret.txt

aws ssm put-parameter \
  --name /vast-webhook-transformer/discord-webhook-url \
  --type SecureString \
  --value file://discord-url.txt

aws ssm put-parameter \
  --name /vast-webhook-transformer/vast-webhook-secret \
  --type SecureString \
  --value file://vast-secret.txt

rm discord-url.txt vast-secret.txt
```

Add `--overwrite` when updating an existing parameter.

### 2. Deploy

```bash
sam build
sam deploy --guided     # first time only; writes your answers to samconfig.toml
```

Subsequent deploys are just `sam deploy`.

The stack outputs the endpoint:

```bash
aws cloudformation describe-stacks \
  --stack-name vast-webhook-transformer \
  --query 'Stacks[0].Outputs[?OutputKey==`WebhookUrl`].OutputValue' \
  --output text
```

### 3. Point Vast at it

Paste that URL into **Account Settings → Notification Settings → Create webhook**, select the events
you want, and save the notification settings form. Vast requires `https://`, which API Gateway
provides.

Then trigger a test delivery — the
[test endpoint](https://docs.vast.ai/api-reference/notifications/test-notification-webhook) sends a
`webhook_test` event with real signature headers:

```bash
curl -X POST "https://console.vast.ai/api/v0/webhooks/<webhook_id>/test/" \
  -H "Authorization: Bearer $VAST_API_KEY"
```

Watch it land:

```bash
sam logs --stack-name vast-webhook-transformer --tail
```

## GitHub Actions

Two workflows:

| Workflow | Trigger | Does |
| --- | --- | --- |
| [ci.yml](.github/workflows/ci.yml) | PR opened, and every push to the PR branch | typecheck, test, `sam validate --lint`, `sam build` |
| [deploy.yml](.github/workflows/deploy.yml) | push to `main` (i.e. a merged PR) | the same checks, then `sam deploy` |

Both skip documentation-only changes (`**/*.md`, `LICENSE`, `.gitignore`).

> **Gotcha:** if you later mark the CI check as *required* for merging, a docs-only PR will never
> report it and will sit unmergeable. Either don't require it, or add a companion job that reports
> success for skipped paths.

### One-time OIDC setup for deploys

Deploys use short-lived OIDC credentials, so there are no long-lived AWS keys in the repo.

**1. Register GitHub as an identity provider** (once per AWS account):

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

No thumbprint is needed. AWS verifies the JWKS endpoint's TLS certificate against its own trusted
root CA library and only falls back to thumbprints for providers using an untrusted CA.

**2. Create a role only this repo's `main` branch can assume.** Save as `trust-policy.json`,
replacing `<ACCOUNT_ID>` and `<GITHUB_USERNAME>`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:<GITHUB_USERNAME>/vast-webhook-transformer:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

The `sub` condition is the security boundary that matters. Keep it exact — a `StringLike` wildcard
such as `repo:<you>/<repo>:*` would let *any* branch or PR in the repo assume the role, which means
anyone who can open a PR can deploy.

```bash
aws iam create-role \
  --role-name gha-vast-webhook-deploy \
  --assume-role-policy-document file://trust-policy.json
```

**3. Attach deploy permissions.** `sam deploy` drives CloudFormation, which in turn creates the
Lambda, the HTTP API, a log group, and an IAM execution role — so the role needs broad-ish
permissions across those services plus `iam:CreateRole` and `iam:PassRole`.

For a personal account the pragmatic choice is `PowerUserAccess` plus the IAM actions CloudFormation
needs, and to treat the trust policy above as the real control:

```bash
aws iam attach-role-policy \
  --role-name gha-vast-webhook-deploy \
  --policy-arn arn:aws:iam::aws:policy/PowerUserAccess
```

`PowerUserAccess` deliberately excludes IAM, so add the IAM actions separately rather than reaching
for `AdministratorAccess`. Scope them to the roles CloudFormation will manage for this stack:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PassRole",
        "iam:TagRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies"
      ],
      "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/vast-webhook-transformer-*"
    }
  ]
}
```

Be honest with yourself about the trade-off: this is a broad grant, justified by a trust policy that
admits exactly one branch of one repo. If that isn't acceptable, narrow it to the specific
CloudFormation, S3, Lambda, API Gateway, and Logs actions `sam deploy` uses.

**4. Tell the repo about the role:**

```bash
gh secret set AWS_DEPLOY_ROLE_ARN --body 'arn:aws:iam::<ACCOUNT_ID>:role/gha-vast-webhook-deploy'
```

The region is not a workflow variable. `sam deploy` reads it from
[samconfig.toml](samconfig.toml), so a variable could only ever disagree with the deploy itself —
authenticating against one region while the stack went to another. To move regions, change
`samconfig.toml` and the two `us-east-1` literals in
[deploy.yml](.github/workflows/deploy.yml) together.

To make merges pause for approval before deploying, add required reviewers to the `production`
environment in **Settings → Environments**.

## Secrets

Both secrets live in SSM Parameter Store as `SecureString`. The Lambda's environment holds only the
parameter *names* — the values are never part of the function configuration, which anyone with
`lambda:GetFunction` could otherwise read. They're fetched once per cold start and cached in memory
for the life of the execution environment.

**The Discord webhook URL is a bearer credential.** Anyone holding it can post to your channel.
`fetch` failures routinely embed the request URL in the error message or its `cause`, which would
write the token straight into CloudWatch Logs — so [`src/discord.ts`](src/discord.ts) strips any
Discord webhook URL out of error text before it is logged. If you add logging, don't log the raw
error, the raw event, or a whole config object.

### Rotating the Vast secret

```bash
aws ssm put-parameter \
  --name /vast-webhook-transformer/vast-webhook-secret \
  --type SecureString --value file://new-secret.txt --overwrite
```

Warm Lambda environments keep the old value cached until they're recycled. Combined with Vast
treating `401` as a **permanent** failure, a delivery signed with the new secret that arrives before
the new value is live is dropped and never retried. Rotate when it's quiet, and force fresh
execution environments by publishing a trivial config change:

```bash
sam deploy --parameter-overrides LogRetentionInDays=14
```

## Cost

Effectively **$0.00/month** at personal-use volume. At ~250 deliveries/month the metered cost is
about **$0.003**, and every line item lands inside an always-free allowance (Lambda's 1M requests and
400,000 GB-seconds, KMS's 20,000 requests, CloudWatch's 5 GB). Nothing in the stack bills for idle.

The real exposure is that `/webhook` is a public endpoint: rejecting junk still costs an API Gateway
request and a Lambda invocation. That's what the route throttle in
[template.yaml](template.yaml) is for — at the default 2 rps / burst 5, a sustained flood tops out
around $7/month instead of unbounded. Raise `ThrottlingRateLimit` only if you have a reason to.

API Gateway has no hard spend limit, so an AWS Budgets alert (first two budgets are free) is a
cheap backstop:

```bash
aws budgets create-budget --account-id <ACCOUNT_ID> \
  --budget '{"BudgetName":"vast-webhook-transformer","BudgetLimit":{"Amount":"5","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}'
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `401` on every delivery | Secret mismatch between SSM and the Vast console, or a warm Lambda still caching a pre-rotation value. |
| `401` only on *some* deliveries | Clock skew, or the delivery took >300s to arrive. |
| `500` on every delivery | SSM parameter missing/misnamed, or the execution role lacks `ssm:GetParameters` / `kms:Decrypt`. Check the `config unavailable` log line. |
| `204` but no Discord message | Discord rejected the payload. Look for `discord delivery failed` with `discord_status` in the logs. |
| Discord returns `400` | Usually an embed limit. The 6000-character total across title + description + footer is the one that bites; the transformer caps it, so this suggests a bug worth reporting. |
| Duplicate Discord messages | Expected. Vast delivers at least once and there's no dedup store. Vast sends `X-Vast-Event-Id` and recommends deduplicating on it; this service deliberately doesn't. A captured request replayed within the 300s signature window produces a duplicate too. |
| `client:` and `host:` events look identical | The payload's `notif_type` is the short slug with no context prefix, so the two are indistinguishable in the embed. Vast's fix is a dedicated webhook per context — subscribe a second webhook and point it at a different Discord channel. |
| Deliveries stop after changing the endpoint URL | Redirects count as *permanent* delivery failures. Update the URL in the Vast console rather than redirecting the old one. |
| A message arrives with no timestamp | The payload's `timestamp` was outside years 0000-9999, so the embed field was omitted rather than sending a date Discord would reject. |

Logs are one structured JSON line per request. The notification's subject and message are
deliberately omitted — they're the content of the alert itself.

```bash
sam logs --stack-name vast-webhook-transformer --tail
```

## Project layout

```
src/
  handler.ts     API Gateway entry point; orchestrates the flow
  signature.ts   HMAC verification + staleness window (pure)
  payload.ts     body validation (pure)
  embed.ts       Vast payload -> Discord embed, incl. truncation (pure)
  discord.ts     POSTs to Discord; never throws; redacts the URL from errors
  config.ts      env-or-SSM secret loading, cached per execution environment
  types.ts
tests/unit/      91 tests, no AWS and no network
scripts/         sign-payload.ts — signs requests the way Vast does
events/          sample Vast payloads
template.yaml    SAM infrastructure
```

## Teardown

```bash
sam delete --stack-name vast-webhook-transformer
```

The SSM parameters are not part of the stack, so remove them separately:

```bash
aws ssm delete-parameters --names \
  /vast-webhook-transformer/discord-webhook-url \
  /vast-webhook-transformer/vast-webhook-secret
```

Delete the webhook in the Vast console too, or it will keep retrying a dead endpoint.

## References

- [Vast.ai notification webhooks](https://docs.vast.ai/guides/reference/notification-webhooks)
- [Discord: Execute Webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook)
- [Discord: embed limits](https://docs.discord.com/developers/resources/message#embed-object-embed-limits)
- [Configuring OpenID Connect in AWS](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)
