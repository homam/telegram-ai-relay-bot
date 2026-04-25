import type { Bot } from 'grammy';
import { loadConfig } from './config.js';
import { createSessionsRepo } from './sessions/repo.js';
import { createProviderRegistry } from './providers/registry.js';
import { parseAllowedUserIds } from './auth/allowlist.js';
import { createBot, type AppContext } from './bot.js';

interface WorkerEvent {
  update: unknown;
}

let botPromise: Promise<Bot<AppContext>> | null = null;

async function getBot(): Promise<Bot<AppContext>> {
  if (!botPromise) botPromise = bootstrap();
  return botPromise;
}

async function bootstrap(): Promise<Bot<AppContext>> {
  const cfg = await loadConfig();
  const repo = createSessionsRepo({
    backend: 'dynamodb',
    tableName: cfg.tableName,
    region: cfg.region,
  });
  const providers = createProviderRegistry({
    openai: cfg.openaiApiKey,
    anthropic: cfg.anthropicApiKey,
    gemini: cfg.geminiApiKey,
  });

  // Pre-fetch botInfo via native fetch — grammY's own getMe can hang under
  // Lambda's frozen-runtime HTTP agent state.
  const botInfo = await fetchBotInfo(cfg.telegramBotToken);

  return createBot({
    token: cfg.telegramBotToken,
    repo,
    providers,
    allowedUserIds: parseAllowedUserIds(cfg.allowedUserIds),
    dailyUsdCapPerUser: cfg.dailyUsdCapPerUser,
    botInfo,
  });
}

async function fetchBotInfo(token: string) {
  const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(10000),
  });
  const json = (await r.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok || !json.result) {
    throw new Error(`getMe failed: ${json.description ?? 'unknown'}`);
  }
  return json.result as Parameters<typeof createBot>[0]['botInfo'];
}

/**
 * Worker entry point.
 * Triggered asynchronously by the Webhook Lambda. Receives a parsed Telegram
 * update and runs the bot through it. Long-running AI streaming happens here
 * (timeout 5min, plenty of headroom).
 */
export const handler = async (event: WorkerEvent): Promise<void> => {
  if (!event?.update) {
    console.warn('worker invoked without update payload');
    return;
  }
  const bot = await getBot();
  try {
    await bot.handleUpdate(event.update as never);
  } catch (err) {
    // Don't rethrow — async-invoke retries cause duplicate processing and
    // Telegram has already been ACK'd by the webhook. Just log.
    console.error('worker handleUpdate error', err);
  }
};
