import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

export interface AppConfig {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  allowedUserIds: string;
  dailyUsdCapPerUser: number;
  tableName: string;
  region: string;
}

let cached: AppConfig | null = null;

/**
 * Load config from environment first, then fall back to SSM Parameter Store
 * for any *secret* fields that aren't set in env. In Lambda, env contains
 * non-secret values (TABLE_NAME, ALLOWED_USER_IDS, …) and secrets come from SSM.
 * Locally, .env.local supplies everything.
 */
export async function loadConfig(opts?: { ssmPrefix?: string; region?: string }): Promise<AppConfig> {
  if (cached) return cached;

  const region = opts?.region ?? process.env.AWS_REGION ?? 'eu-west-1';
  const ssmPrefix = opts?.ssmPrefix ?? process.env.SSM_PREFIX ?? '/tg-ai-relay-bot';

  const env = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
  };

  const allFromEnv =
    env.telegramBotToken &&
    env.telegramWebhookSecret &&
    (env.openaiApiKey || env.anthropicApiKey || env.geminiApiKey);

  let secrets = env;
  if (!allFromEnv && process.env.AWS_LAMBDA_FUNCTION_NAME) {
    secrets = { ...env, ...(await fetchSsmSecrets(ssmPrefix, region)) };
  }

  if (!secrets.telegramBotToken) throw new Error('Missing TELEGRAM_BOT_TOKEN');
  if (!secrets.telegramWebhookSecret) throw new Error('Missing TELEGRAM_WEBHOOK_SECRET');

  cached = {
    telegramBotToken: secrets.telegramBotToken,
    telegramWebhookSecret: secrets.telegramWebhookSecret,
    openaiApiKey: secrets.openaiApiKey,
    anthropicApiKey: secrets.anthropicApiKey,
    geminiApiKey: secrets.geminiApiKey,
    allowedUserIds: process.env.ALLOWED_USER_IDS ?? '',
    dailyUsdCapPerUser: parseFloat(process.env.DAILY_USD_CAP_PER_USER ?? '2.00'),
    tableName: process.env.TABLE_NAME ?? 'tg-ai-relay-bot',
    region,
  };
  return cached;
}

async function fetchSsmSecrets(prefix: string, region: string) {
  const ssm = new SSMClient({ region });
  const out: Record<string, string> = {};
  let nextToken: string | undefined;
  do {
    const r = await ssm.send(
      new GetParametersByPathCommand({
        Path: prefix,
        Recursive: false,
        WithDecryption: true,
        NextToken: nextToken,
      }),
    );
    for (const p of r.Parameters ?? []) {
      if (!p.Name || !p.Value) continue;
      const key = p.Name.slice(prefix.length + 1); // strip "<prefix>/"
      out[key] = p.Value;
    }
    nextToken = r.NextToken;
  } while (nextToken);

  return {
    telegramBotToken: out['telegram-bot-token'],
    telegramWebhookSecret: out['telegram-webhook-secret'],
    openaiApiKey: out['openai-api-key'],
    anthropicApiKey: out['anthropic-api-key'],
    geminiApiKey: out['gemini-api-key'],
  };
}
