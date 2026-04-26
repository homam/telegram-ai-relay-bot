import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { createSessionsRepo } from '../src/sessions/repo.js';
import { createProviderRegistry } from '../src/providers/registry.js';
import { parseAllowedUserIds } from '../src/auth/allowlist.js';
import { createBot } from '../src/bot.js';

dotenvConfig({ path: '.env.local', override: true });

async function main() {
  // Prefer the dev token. Falling back to the prod token is allowed but
  // dangerous: long-polling steals the production webhook (see CLAUDE.md
  // "Local dev nuance"). If TELEGRAM_BOT_TOKEN_DEV isn't set we warn loudly
  // before continuing — Ctrl-C is your friend.
  let token = process.env.TELEGRAM_BOT_TOKEN_DEV;
  let tokenSource: 'dev' | 'prod-fallback';
  if (token) {
    tokenSource = 'dev';
  } else {
    tokenSource = 'prod-fallback';
    token = required('TELEGRAM_BOT_TOKEN');
    console.warn(
      '⚠ TELEGRAM_BOT_TOKEN_DEV is not set; falling back to TELEGRAM_BOT_TOKEN.\n' +
        '⚠ This will DELETE the production webhook (long-polling claims the bot).\n' +
        '⚠ To set up an isolated dev bot: chat with @BotFather → /newbot,\n' +
        '⚠ then put the token in .env.local as TELEGRAM_BOT_TOKEN_DEV=...',
    );
  }

  const allowed = parseAllowedUserIds(process.env.ALLOWED_USER_IDS);
  if (allowed.size === 0) {
    console.warn('⚠ ALLOWED_USER_IDS is empty — bot will refuse everyone.');
  }

  const backend = (process.env.STORAGE_BACKEND ?? 'memory') as 'memory' | 'dynamodb';
  const repo = createSessionsRepo({
    backend,
    tableName: process.env.TABLE_NAME,
    region: process.env.AWS_REGION,
  });

  const providers = createProviderRegistry({
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
  });

  const bot = createBot({
    token,
    repo,
    providers,
    allowedUserIds: allowed,
    dailyUsdCapPerUser: parseFloat(process.env.DAILY_USD_CAP_PER_USER ?? '2.00'),
  });

  console.log(
    `Starting bot in long-polling mode ` +
      `(token=${tokenSource}, backend=${backend}, providers=${providers.ids().join(',')})…`,
  );
  await bot.start({
    drop_pending_updates: true,
    onStart: (me) =>
      console.log(
        `✓ @${me.username} ready (token=${tokenSource}). Send /start from an allowlisted account.`,
      ),
  });
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in .env.local`);
    process.exit(1);
  }
  return v;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
