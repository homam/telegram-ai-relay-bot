import { Bot, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { autoRetry } from '@grammyjs/auto-retry';
import { stream as streamPlugin, type StreamFlavor } from '@grammyjs/stream';
import telegramifyMarkdown from 'telegramify-markdown';
import { randomUUID } from 'node:crypto';
import type { SessionsRepo } from './sessions/types.js';
import type {
  ChatMessage,
  ProviderId,
  Session,
  UserState,
} from './sessions/types.js';
import type { ProviderRegistry } from './providers/registry.js';
import { PROVIDER_LABELS } from './providers/registry.js';
import { isAllowed } from './auth/allowlist.js';
import { checkBudget, recordSpend } from './auth/budget.js';
import { modelKeyboard, sessionsKeyboard } from './ui/keyboards.js';

export type AppContext = StreamFlavor<Context>;

export interface BotDeps {
  token: string;
  repo: SessionsRepo;
  providers: ProviderRegistry;
  allowedUserIds: Set<number>;
  dailyUsdCapPerUser: number;
  /** If provided, the bot skips its own getMe call (avoids a hang under AWS Lambda). */
  botInfo?: UserFromGetMe;
}

const MAX_HISTORY_TURNS = 40;
const MAX_TG_MESSAGE_LEN = 4000;
const SESSION_LIST_LIMIT = 10;

export function createBot(deps: BotDeps): Bot<AppContext> {
  // grammY ships node-fetch v2 which rejects Node 20's native AbortSignal —
  // force it to use the runtime's native fetch. Required for AWS Lambda.
  const bot = new Bot<AppContext>(deps.token, {
    ...(deps.botInfo ? { botInfo: deps.botInfo } : {}),
    client: { fetch: globalThis.fetch as never },
  });

  // Auto-retry on Telegram rate limits (429); MUST be installed BEFORE the stream plugin
  // so streamed sendMessageDraft calls inherit retry behaviour.
  bot.api.config.use(autoRetry());
  bot.use(streamPlugin());

  // ── allowlist gate ──────────────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!isAllowed(deps.allowedUserIds, uid)) {
      if (ctx.message || ctx.callbackQuery) {
        await ctx.reply('Sorry, you are not authorized to use this bot.');
      }
      return;
    }
    await next();
  });

  // ── /start, /help ───────────────────────────────────────────────────────
  bot.command(['start', 'help'], async (ctx) => {
    await ctx.reply(helpText(deps.providers.ids()));
  });

  // ── /model ──────────────────────────────────────────────────────────────
  bot.command('model', async (ctx) => {
    const ids = deps.providers.ids();
    const state = await getOrInitState(deps.repo, ctx.from!.id, ids[0]!);
    await ctx.reply(
      `Current model: *${PROVIDER_LABELS[state.activeProvider]}*\nPick a model:`,
      { parse_mode: 'Markdown', reply_markup: modelKeyboard(ids) },
    );
  });

  bot.callbackQuery(/^model:(openai|anthropic|gemini)$/, async (ctx) => {
    const provider = ctx.match![1] as ProviderId;
    if (!deps.providers.has(provider)) {
      await ctx.answerCallbackQuery({ text: 'Provider not configured' });
      return;
    }
    const state = await getOrInitState(deps.repo, ctx.from!.id, provider);
    state.activeProvider = provider;
    state.updatedAt = Date.now();
    await deps.repo.putState(state);
    await ctx.answerCallbackQuery({ text: `Switched to ${PROVIDER_LABELS[provider]}` });
    await ctx.editMessageText(
      `Active model: *${PROVIDER_LABELS[provider]}*`,
      { parse_mode: 'Markdown' },
    );
  });

  // ── /new ────────────────────────────────────────────────────────────────
  bot.command('new', async (ctx) => {
    const state = await getOrInitState(deps.repo, ctx.from!.id, deps.providers.ids()[0]!);
    const provider = state.activeProvider;
    const session = await createBlankSession(deps, ctx.from!.id, provider);
    state.activeSessionByProvider[provider] = session.sessionId;
    state.updatedAt = Date.now();
    await deps.repo.putState(state);
    await ctx.reply(`Started a new ${PROVIDER_LABELS[provider]} session.`);
  });

  // ── /sessions ───────────────────────────────────────────────────────────
  bot.command('sessions', async (ctx) => {
    const state = await getOrInitState(deps.repo, ctx.from!.id, deps.providers.ids()[0]!);
    const provider = state.activeProvider;
    const list = await deps.repo.listSessions(ctx.from!.id, provider, SESSION_LIST_LIMIT);
    if (list.length === 0) {
      await ctx.reply(`No ${PROVIDER_LABELS[provider]} sessions yet. Send a message to start one.`);
      return;
    }
    await ctx.reply(
      `Recent ${PROVIDER_LABELS[provider]} sessions — tap to resume:`,
      { reply_markup: sessionsKeyboard(list) },
    );
  });

  bot.callbackQuery(/^resume:(.+)$/, async (ctx) => {
    const sessionId = ctx.match![1]!;
    const session = await deps.repo.getSession(ctx.from!.id, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'Session not found' });
      return;
    }
    const state = await getOrInitState(deps.repo, ctx.from!.id, session.provider);
    state.activeProvider = session.provider;
    state.activeSessionByProvider[session.provider] = sessionId;
    state.updatedAt = Date.now();
    await deps.repo.putState(state);
    await ctx.answerCallbackQuery({ text: 'Resumed' });
    await ctx.editMessageText(
      `Resumed *${escapeMd(session.title || sessionId)}* (${PROVIDER_LABELS[session.provider]}, ${session.messages.length} messages).`,
      { parse_mode: 'Markdown' },
    );
  });

  // ── /rename ─────────────────────────────────────────────────────────────
  bot.command('rename', async (ctx) => {
    const newTitle = (ctx.match ?? '').toString().trim();
    if (!newTitle) {
      await ctx.reply('Usage: /rename <new title>');
      return;
    }
    const session = await getActiveSession(deps, ctx.from!.id);
    if (!session) {
      await ctx.reply('No active session — send a message to start one.');
      return;
    }
    session.title = newTitle.slice(0, 80);
    await deps.repo.updateSession(session);
    await ctx.reply(`Renamed to: ${session.title}`);
  });

  // ── /forget ─────────────────────────────────────────────────────────────
  bot.command('forget', async (ctx) => {
    const session = await getActiveSession(deps, ctx.from!.id);
    if (!session) {
      await ctx.reply('No active session.');
      return;
    }
    await deps.repo.deleteSession(ctx.from!.id, session.sessionId);
    const state = await getOrInitState(deps.repo, ctx.from!.id, session.provider);
    delete state.activeSessionByProvider[session.provider];
    state.updatedAt = Date.now();
    await deps.repo.putState(state);
    await ctx.reply(`Deleted session: ${session.title}`);
  });

  // ── /usage ──────────────────────────────────────────────────────────────
  bot.command('usage', async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const b = await deps.repo.getBudget(ctx.from!.id, today);
    const used = b?.usdEstimate ?? 0;
    const tin = b?.tokensIn ?? 0;
    const tout = b?.tokensOut ?? 0;
    await ctx.reply(
      `Today (${today}):\n` +
      `  • Tokens in: ${tin}\n` +
      `  • Tokens out: ${tout}\n` +
      `  • Estimated cost: $${used.toFixed(4)} of $${deps.dailyUsdCapPerUser.toFixed(2)} cap`,
    );
  });

  // ── plain text → stream relay to active provider ────────────────────────
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // unknown commands fall through

    const userId = ctx.from!.id;

    // Budget gate
    const budget = await checkBudget(deps.repo, userId, deps.dailyUsdCapPerUser);
    if (!budget.allowed) {
      await ctx.reply(
        `Daily cap reached: $${budget.usedUsd.toFixed(4)} / $${budget.capUsd.toFixed(2)}.\nResets at UTC midnight.`,
      );
      return;
    }

    const state = await getOrInitState(deps.repo, userId, deps.providers.ids()[0]!);
    const provider = state.activeProvider;
    const providerImpl = deps.providers.get(provider);

    // Resolve or create active session
    let session: Session;
    const activeId = state.activeSessionByProvider[provider];
    const existing = activeId ? await deps.repo.getSession(userId, activeId) : null;
    if (existing) {
      session = existing;
    } else {
      session = await createBlankSession(deps, userId, provider);
      state.activeSessionByProvider[provider] = session.sessionId;
      await deps.repo.putState({ ...state, updatedAt: Date.now() });
    }

    // Auto-title from first message
    if (!session.title && session.messages.length === 0) {
      session.title = text.slice(0, 40);
    }

    // Trim history sent to provider (keep full history in storage)
    const trimmed = trimHistory(session.messages, MAX_HISTORY_TURNS);

    // Run the provider stream and tee the chunks: pass to Telegram, accumulate locally.
    const gen = providerImpl.streamSend(
      trimmed,
      text,
      session.model || providerImpl.defaultModel,
    );
    const meta: { assembled: string; final: { usage: { input: number; output: number }; model: string } | null } = {
      assembled: '',
      final: null,
    };

    async function* relay(): AsyncGenerator<string> {
      while (true) {
        const r = await gen.next();
        if (r.done) {
          meta.final = r.value;
          return;
        }
        if (r.value) {
          meta.assembled += r.value;
          yield r.value;
        }
      }
    }

    let sentMessages: { message_id: number }[] = [];
    try {
      sentMessages = await ctx.replyWithStream(relay());
    } catch (err) {
      console.error('stream error', err);
      await ctx.reply(`Provider error: ${(err as Error).message}`);
      return;
    }

    if (!meta.final) {
      console.warn('stream ended without final usage');
      return;
    }
    const final = meta.final;
    const assembled = meta.assembled;

    // After streaming finishes, reformat the committed message(s) with
    // Telegram's MarkdownV2 dialect so headings, bold/italic, lists, and code
    // blocks actually render. We only edit when there's exactly one committed
    // message (the common case under 4096 chars) — multi-message responses
    // stay as plain text to avoid the complexity of re-splitting a converted
    // string back across messages.
    if (sentMessages.length === 1 && assembled.trim()) {
      const last = sentMessages[0]!;
      try {
        const formatted = telegramifyMarkdown(assembled, 'escape');
        if (formatted.length <= 4096) {
          await ctx.api.editMessageText(ctx.chat!.id, last.message_id, formatted, {
            parse_mode: 'MarkdownV2',
            link_preview_options: { is_disabled: true },
          });
        }
      } catch (err) {
        // Telegram rejected the formatted version — leave the plain text in place.
        console.warn('post-stream MarkdownV2 reformat failed, keeping plain text:', err);
      }
    }

    // Persist turn
    const now = Date.now();
    const userMsg: ChatMessage = { role: 'user', content: text, ts: now };
    const asstMsg: ChatMessage = {
      role: 'assistant',
      content: assembled || '(empty reply)',
      ts: Date.now(),
    };
    session.messages.push(userMsg, asstMsg);
    session.tokensIn += final.usage.input;
    session.tokensOut += final.usage.output;
    session.lastUsedAt = Date.now();
    session.model = final.model;
    await deps.repo.updateSession(session);

    await recordSpend(
      deps.repo,
      userId,
      provider,
      final.model,
      final.usage.input,
      final.usage.output,
    );
  });

  bot.catch((err) => {
    console.error('bot error', err);
  });

  return bot;
}

// ── helpers ───────────────────────────────────────────────────────────────

async function getOrInitState(
  repo: SessionsRepo,
  userId: number,
  defaultProvider: ProviderId,
): Promise<UserState> {
  const existing = await repo.getState(userId);
  if (existing) return existing;
  const fresh: UserState = {
    userId,
    activeProvider: defaultProvider,
    activeSessionByProvider: {},
    updatedAt: Date.now(),
  };
  await repo.putState(fresh);
  return fresh;
}

async function createBlankSession(deps: BotDeps, userId: number, provider: ProviderId): Promise<Session> {
  const now = Date.now();
  const s: Session = {
    userId,
    sessionId: randomUUID(),
    provider,
    model: deps.providers.get(provider).defaultModel,
    title: '',
    createdAt: now,
    lastUsedAt: now,
    messages: [],
    tokensIn: 0,
    tokensOut: 0,
  };
  await deps.repo.createSession(s);
  return s;
}

async function getActiveSession(deps: BotDeps, userId: number): Promise<Session | null> {
  const state = await deps.repo.getState(userId);
  if (!state) return null;
  const sid = state.activeSessionByProvider[state.activeProvider];
  if (!sid) return null;
  return deps.repo.getSession(userId, sid);
}

function trimHistory(messages: ChatMessage[], maxTurns: number): ChatMessage[] {
  const maxItems = maxTurns * 2;
  if (messages.length <= maxItems) return messages;
  return messages.slice(messages.length - maxItems);
}

function chunkText(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

function escapeMd(s: string): string {
  return s.replace(/([_*`\[\]])/g, '\\$1');
}

function helpText(available: ProviderId[]): string {
  const list = available.map((id) => PROVIDER_LABELS[id]).join(', ');
  return [
    'Hi! I relay your messages to an AI model and remember the conversation.',
    '',
    `Available models: ${list}`,
    '',
    'Commands:',
    '  /model — choose model (OpenAI / Claude / Gemini)',
    '  /new — start a new session in the current model',
    '  /sessions — list and resume previous sessions for the current model',
    '  /rename <title> — rename the active session',
    '  /forget — delete the active session',
    '  /usage — see today’s token + cost usage',
    '',
    'Just send a message to chat.',
  ].join('\n');
}
