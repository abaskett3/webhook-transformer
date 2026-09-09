/**
 * Dev helper: signs a Vast.ai notification payload the way Vast.ai would, so a
 * locally running handler can be exercised end to end.
 *
 * Run with plain `node` -- Node 24 strips the types itself, no build step:
 *
 *   node scripts/sign-payload.ts                       # print a curl command
 *   node scripts/sign-payload.ts --url http://127.0.0.1:3000/webhook
 *   node scripts/sign-payload.ts --emit-event events/generated.event.json
 *   node scripts/sign-payload.ts --file events/webhook_test.json --fresh
 *
 * The secret comes from --secret, else VAST_WEBHOOK_SECRET, else .env. It only
 * has to match whatever the handler is configured with; for local runs that is
 * a throwaway value, never the real Vast secret.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';

const USAGE = `Usage: node scripts/sign-payload.ts [options]

  -f, --file <path>       Vast payload to send   (default: events/low_credit.json)
  -u, --url <url>         POST the signed request to this URL
      --emit-event <path> Write an API Gateway v2 event JSON for \`sam local invoke -e\`
      --fresh             Rewrite event_id and timestamp to be current
  -s, --secret <secret>   HMAC key (default: $VAST_WEBHOOK_SECRET, or .env)
  -h, --help              Show this message
`;

const { values } = parseArgs({
  options: {
    file: { type: 'string', short: 'f', default: 'events/low_credit.json' },
    url: { type: 'string', short: 'u' },
    'emit-event': { type: 'string' },
    fresh: { type: 'boolean', default: false },
    secret: { type: 'string', short: 's' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

// Best effort: a .env is convenient locally but not required.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env present */
}

const secret = values.secret ?? process.env.VAST_WEBHOOK_SECRET;
if (!secret) {
  console.error(
    'No secret. Pass --secret, set VAST_WEBHOOK_SECRET, or copy .env.example to .env.',
  );
  process.exit(1);
}

// Sign exactly the bytes that get sent. Re-serializing after signing is the
// classic way to produce a signature that never verifies.
let body: Buffer;
let bodyPath = values.file;

if (values.fresh) {
  const payload = JSON.parse(readFileSync(values.file, 'utf8')) as Record<string, unknown>;
  payload.event_id = randomBytes(16).toString('hex');
  payload.timestamp = Date.now() / 1000;
  body = Buffer.from(JSON.stringify(payload), 'utf8');

  // The printed curl reads the body from a file, so the rewritten payload has
  // to land on disk -- otherwise curl would send the original bytes and the
  // signature would never match. Gitignored.
  bodyPath = 'events/.signed.json';
  writeFileSync(bodyPath, body);
} else {
  body = readFileSync(values.file);
}

const timestamp = Math.floor(Date.now() / 1000);
const signature = `sha256=${createHmac('sha256', secret)
  .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]))
  .digest('hex')}`;

/** Tolerates a non-JSON body so the handler's 400 path can be exercised too. */
function readEventId(raw: Buffer): string {
  try {
    return String((JSON.parse(raw.toString('utf8')) as { event_id?: unknown }).event_id ?? '');
  } catch {
    return '';
  }
}

const headers: Record<string, string> = {
  'content-type': 'application/json',
  'x-vast-event-id': readEventId(body),
  'x-vast-delivery-attempt': '1',
  'x-vast-timestamp': String(timestamp),
  'x-vast-signature-256': signature,
};

const eventPath = values['emit-event'];
if (eventPath) {
  const event = {
    version: '2.0',
    routeKey: 'POST /webhook',
    rawPath: '/webhook',
    rawQueryString: '',
    headers,
    requestContext: {
      http: {
        method: 'POST',
        path: '/webhook',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'sign-payload.ts',
      },
    },
    body: body.toString('utf8'),
    isBase64Encoded: false,
  };

  writeFileSync(eventPath, `${JSON.stringify(event, null, 2)}\n`);
  console.log(`Wrote ${eventPath}`);
  console.log('Heads up: the signature goes stale in 300s. Regenerate if it starts 401ing.');
  process.exit(0);
}

if (values.url) {
  const response = await fetch(values.url, { method: 'POST', headers, body });
  const text = await response.text();

  console.log(`${response.status} ${response.statusText}`);
  if (text) console.log(text);
  process.exit(response.ok ? 0 : 1);
}

const headerArgs = Object.entries(headers)
  .map(([name, value]) => `  -H '${name}: ${value}' \\`)
  .join('\n');

console.log(`curl -i -X POST http://127.0.0.1:3000/webhook \\
${headerArgs}
  --data-binary @${bodyPath}`);
console.log('\n# Signature valid for 300s. Re-run to refresh.');
