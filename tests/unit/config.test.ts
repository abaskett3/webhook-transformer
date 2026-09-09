import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = send;
  },
  GetParametersCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const { getConfig, resetConfigCache } = await import('../../src/config.ts');

const DISCORD_PARAMETER = '/vast-webhook-transformer/discord-webhook-url';
const SECRET_PARAMETER = '/vast-webhook-transformer/vast-webhook-secret';

beforeEach(() => {
  resetConfigCache();
  for (const name of [
    'DISCORD_WEBHOOK_URL',
    'VAST_WEBHOOK_SECRET',
    'DISCORD_WEBHOOK_URL_PARAMETER',
    'VAST_WEBHOOK_SECRET_PARAMETER',
  ]) {
    delete process.env[name];
  }
});

describe('getConfig', () => {
  it('uses environment variables and makes no AWS call when both are set', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/token';
    process.env.VAST_WEBHOOK_SECRET = 'local-secret';

    await expect(getConfig()).resolves.toEqual({
      discordWebhookUrl: 'https://discord.com/api/webhooks/1/token',
      vastWebhookSecret: 'local-secret',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('falls back to SSM when only one environment variable is set', async () => {
    // A half-configured environment must not silently start up.
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/token';

    await expect(getConfig()).rejects.toThrow(
      'environment variable DISCORD_WEBHOOK_URL_PARAMETER is not set',
    );
  });

  it('reads both parameters from SSM in a single decrypted call', async () => {
    process.env.DISCORD_WEBHOOK_URL_PARAMETER = DISCORD_PARAMETER;
    process.env.VAST_WEBHOOK_SECRET_PARAMETER = SECRET_PARAMETER;
    send.mockResolvedValue({
      Parameters: [
        { Name: DISCORD_PARAMETER, Value: 'https://discord.com/api/webhooks/2/from-ssm' },
        { Name: SECRET_PARAMETER, Value: 'ssm-secret' },
      ],
    });

    await expect(getConfig()).resolves.toEqual({
      discordWebhookUrl: 'https://discord.com/api/webhooks/2/from-ssm',
      vastWebhookSecret: 'ssm-secret',
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Names: [DISCORD_PARAMETER, SECRET_PARAMETER],
      WithDecryption: true,
    });
  });

  it('caches across calls so a warm invocation makes no AWS call', async () => {
    process.env.DISCORD_WEBHOOK_URL_PARAMETER = DISCORD_PARAMETER;
    process.env.VAST_WEBHOOK_SECRET_PARAMETER = SECRET_PARAMETER;
    send.mockResolvedValue({
      Parameters: [
        { Name: DISCORD_PARAMETER, Value: 'url' },
        { Name: SECRET_PARAMETER, Value: 'secret' },
      ],
    });

    await getConfig();
    await getConfig();
    await getConfig();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('shares one SSM call between concurrent cold invocations', async () => {
    process.env.DISCORD_WEBHOOK_URL_PARAMETER = DISCORD_PARAMETER;
    process.env.VAST_WEBHOOK_SECRET_PARAMETER = SECRET_PARAMETER;
    send.mockResolvedValue({
      Parameters: [
        { Name: DISCORD_PARAMETER, Value: 'url' },
        { Name: SECRET_PARAMETER, Value: 'secret' },
      ],
    });

    await Promise.all([getConfig(), getConfig()]);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure', async () => {
    // A transient SSM error must not poison the execution environment.
    process.env.DISCORD_WEBHOOK_URL_PARAMETER = DISCORD_PARAMETER;
    process.env.VAST_WEBHOOK_SECRET_PARAMETER = SECRET_PARAMETER;
    send.mockRejectedValueOnce(new Error('ThrottlingException'));
    send.mockResolvedValueOnce({
      Parameters: [
        { Name: DISCORD_PARAMETER, Value: 'url' },
        { Name: SECRET_PARAMETER, Value: 'secret' },
      ],
    });

    await expect(getConfig()).rejects.toThrow('ThrottlingException');
    await expect(getConfig()).resolves.toEqual({
      discordWebhookUrl: 'url',
      vastWebhookSecret: 'secret',
    });
  });

  it('fails loudly when a parameter is missing from the SSM response', async () => {
    process.env.DISCORD_WEBHOOK_URL_PARAMETER = DISCORD_PARAMETER;
    process.env.VAST_WEBHOOK_SECRET_PARAMETER = SECRET_PARAMETER;
    send.mockResolvedValue({
      Parameters: [{ Name: DISCORD_PARAMETER, Value: 'url' }],
      InvalidParameters: [SECRET_PARAMETER],
    });

    await expect(getConfig()).rejects.toThrow(
      `SSM parameter ${SECRET_PARAMETER} is missing or empty`,
    );
  });
});
