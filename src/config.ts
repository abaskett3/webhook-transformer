import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';

export interface Config {
  discordWebhookUrl: string;
  vastWebhookSecret: string;
}

/**
 * Cached for the life of the execution environment, so a warm invocation makes
 * no AWS call. The *promise* is cached rather than the value, so two concurrent
 * cold invocations share a single GetParameters call.
 */
let cached: Promise<Config> | undefined;

export function getConfig(): Promise<Config> {
  cached ??= loadConfig().catch((error: unknown) => {
    // Never cache a failure. A transient SSM error would otherwise poison this
    // execution environment for as long as Lambda keeps it alive.
    cached = undefined;
    throw error;
  });

  return cached;
}

/** Test seam. Not used in production. */
export function resetConfigCache(): void {
  cached = undefined;
}

async function loadConfig(): Promise<Config> {
  return readFromEnvironment() ?? (await readFromParameterStore());
}

/**
 * Local development, `sam local`, and tests supply the values directly. When
 * both are present no AWS call is made and no credentials are needed.
 *
 * In the deployed stack these are never set — the Lambda's environment carries
 * only the SSM parameter *names*, so the secrets are absent from the function
 * configuration that anyone with lambda:GetFunction can read.
 */
function readFromEnvironment(): Config | undefined {
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const vastWebhookSecret = process.env.VAST_WEBHOOK_SECRET;

  if (discordWebhookUrl && vastWebhookSecret) {
    return { discordWebhookUrl, vastWebhookSecret };
  }

  return undefined;
}

let client: SSMClient | undefined;

async function readFromParameterStore(): Promise<Config> {
  const discordParameter = requireEnv('DISCORD_WEBHOOK_URL_PARAMETER');
  const secretParameter = requireEnv('VAST_WEBHOOK_SECRET_PARAMETER');

  client ??= new SSMClient({});

  const response = await client.send(
    new GetParametersCommand({
      Names: [discordParameter, secretParameter],
      WithDecryption: true,
    }),
  );

  const values = new Map(
    (response.Parameters ?? []).map((parameter) => [parameter.Name, parameter.Value]),
  );

  return {
    // Parameter names aren't secret, so naming them in the error is safe and
    // makes a misconfigured stack obvious from the logs.
    discordWebhookUrl: requireParameter(values, discordParameter),
    vastWebhookSecret: requireParameter(values, secretParameter),
  };
}

function requireParameter(
  values: Map<string | undefined, string | undefined>,
  name: string,
): string {
  const value = values.get(name);
  if (!value) throw new Error(`SSM parameter ${name} is missing or empty`);
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`environment variable ${name} is not set`);
  return value;
}
