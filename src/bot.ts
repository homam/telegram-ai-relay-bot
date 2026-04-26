import { Bot, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { autoRetry } from '@grammyjs/auto-retry';
import { stream as streamPlugin, type StreamFlavor } from '@grammyjs/stream';
import telegramifyMarkdown from 'telegramify-markdown';
import { randomUUID } from 'node:crypto';
import type { SessionsRepo } from './sessions/types.js';
import {
  chatMessageText,
  type ChatMessage,
  type ProviderId,
  type Session,
  type UserState,
} from './sessions/types.js';
import type { ProviderRegistry } from './providers/registry.js';
import { PROVIDER_LABELS } from './providers/registry.js';
import type { Citation, UserInput } from './providers/types.js';
import { isAllowed } from './auth/allowlist.js';
import { checkBudget, recordAudioSpend, recordSpend, recordTtsSpend } from './auth/budget.js';
import { OpenAIProvider } from './providers/openai.js';
import { modelKeyboard, sessionsKeyboard, variantKeyboard } from './ui/keyboards.js';

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
const CANCEL_POLL_MS = 500;

class CancelError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelError';
  }
}

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
    const current = state.modelByProvider[state.activeProvider]
      ?? deps.providers.get(state.activeProvider).defaultModel;
    await ctx.reply(
      `Active: *${PROVIDER_LABELS[state.activeProvider]} · ${current}*\nTap a row to switch provider, or ⚙ to pick a variant:`,
      { parse_mode: 'Markdown', reply_markup: modelKeyboard(ids, state, deps.providers) },
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
    const current = state.modelByProvider[provider] ?? deps.providers.get(provider).defaultModel;
    await ctx.answerCallbackQuery({ text: `Switched to ${PROVIDER_LABELS[provider]}` });
    await ctx.editMessageText(
      `Active: *${PROVIDER_LABELS[provider]} · ${current}*`,
      { parse_mode: 'Markdown' },
    );
  });

  // Open the variant picker for a specific provider.
  bot.callbackQuery(/^pickmodel:(openai|anthropic|gemini)$/, async (ctx) => {
    const provider = ctx.match![1] as ProviderId;
    if (!deps.providers.has(provider)) {
      await ctx.answerCallbackQuery({ text: 'Provider not configured' });
      return;
    }
    const impl = deps.providers.get(provider);
    const state = await getOrInitState(deps.repo, ctx.from!.id, provider);
    const current = state.modelByProvider[provider] ?? impl.defaultModel;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Pick a *${PROVIDER_LABELS[provider]}* variant:`,
      {
        parse_mode: 'Markdown',
        reply_markup: variantKeyboard(provider, current, impl.selectableModels),
      },
    );
  });

  // Set the user's preferred variant for a provider; also activates that provider.
  bot.callbackQuery(/^variant:(openai|anthropic|gemini):(.+)$/, async (ctx) => {
    const provider = ctx.match![1] as ProviderId;
    const modelId = ctx.match![2]!;
    const impl = deps.providers.get(provider);
    if (!impl.selectableModels.some((m) => m.id === modelId)) {
      await ctx.answerCallbackQuery({ text: 'Unknown model' });
      return;
    }
    const state = await getOrInitState(deps.repo, ctx.from!.id, provider);
    state.activeProvider = provider;
    state.modelByProvider[provider] = modelId;
    state.updatedAt = Date.now();
    await deps.repo.putState(state);
    await ctx.answerCallbackQuery({ text: `Set to ${modelId}` });
    await ctx.editMessageText(
      `Active: *${PROVIDER_LABELS[provider]} · ${modelId}*\n_New sessions will use this. Use /new to start one._`,
      { parse_mode: 'Markdown' },
    );
  });

  // ── /new ────────────────────────────────────────────────────────────────
  bot.command('new', async (ctx) => {
    const state = await getOrInitState(deps.repo, ctx.from!.id, deps.providers.ids()[0]!);
    const provider = state.activeProvider;
    const session = await createBlankSession(
      deps,
      ctx.from!.id,
      provider,
      state.modelByProvider[provider],
    );
    state.activeSessionByProvider[provider] = session.sessionId;
    state.updatedAt = Date.now();
    await deps.repo.putState(state);
    await ctx.reply(`Started a new ${PROVIDER_LABELS[provider]} session on \`${session.model}\`.`, {
      parse_mode: 'Markdown',
    });
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

  // ── /cancel — interrupt an in-flight stream ─────────────────────────────
  bot.command('cancel', async (ctx) => {
    await deps.repo.setCancelFlag(ctx.from!.id);
    await ctx.reply('🛑 Stopping…');
  });

  // ── /say — read the active session's latest reply (or a replied-to message) aloud
  bot.command('say', async (ctx) => {
    const userId = ctx.from!.id;

    // Budget gate
    const budget = await checkBudget(deps.repo, userId, deps.dailyUsdCapPerUser);
    if (!budget.allowed) {
      await ctx.reply(
        `Daily cap reached: $${budget.usedUsd.toFixed(4)} / $${budget.capUsd.toFixed(2)}.`,
      );
      return;
    }

    if (!deps.providers.has('openai')) {
      await ctx.reply('Voice replies need OpenAI configured. Add `OPENAI_API_KEY` to SSM.');
      return;
    }
    const openai = deps.providers.get('openai') as OpenAIProvider;

    // Resolve the text to speak:
    // 1. If /say replies to a specific message that has text, use that.
    // 2. Otherwise read the latest assistant message of the active session.
    let text: string | null = null;
    const replied = ctx.message?.reply_to_message;
    if (replied && 'text' in replied && typeof replied.text === 'string' && replied.text.trim()) {
      text = replied.text;
    } else {
      const state = await deps.repo.getState(userId);
      const activeSessionId = state?.activeSessionByProvider[state.activeProvider];
      if (activeSessionId) {
        const session = await deps.repo.getSession(userId, activeSessionId);
        for (let i = (session?.messages.length ?? 0) - 1; i >= 0; i--) {
          const m = session!.messages[i]!;
          if (m.role !== 'assistant') continue;
          const t = chatMessageText(m);
          if (t.trim() && t !== '(empty reply)') {
            text = t;
            break;
          }
        }
      }
    }

    if (!text) {
      await ctx.reply(
        'Nothing to read — reply to a message with /say, or send a message first.',
      );
      return;
    }

    let result;
    try {
      console.log(`[say] starting TTS for ${text.length} chars`);
      const t0 = Date.now();
      result = await openai.textToSpeech(text, 'alloy');
      console.log(`[say] TTS ok (${Date.now() - t0}ms, ${result.audio.length} bytes)`);
    } catch (err) {
      console.error('tts failed', err);
      await ctx.reply(`Voice generation failed: ${(err as Error).message}`);
      return;
    }

    await recordTtsSpend(deps.repo, userId, result.chars);

    try {
      console.log(`[say] sending voice (${result.audio.length} bytes)…`);
      const t0 = Date.now();
      // Bypass grammY's InputFile upload — under Lambda it hangs on multipart
      // streaming. Native fetch + FormData + Blob delivers reliably.
      const fd = new FormData();
      fd.set('chat_id', String(ctx.chat!.id));
      fd.set(
        'voice',
        new Blob([new Uint8Array(result.audio)], { type: 'audio/ogg' }),
        'reply.ogg',
      );
      fd.set('reply_parameters', JSON.stringify({ message_id: ctx.message!.message_id }));
      if (result.truncated) fd.set('caption', '(audio truncated to 4096 chars)');
      const res = await fetch(`https://api.telegram.org/bot${deps.token}/sendVoice`, {
        method: 'POST',
        body: fd,
        signal: AbortSignal.timeout(60_000),
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) throw new Error(json.description ?? `Telegram ${res.status}`);
      console.log(`[say] voice sent (${Date.now() - t0}ms)`);
    } catch (err) {
      console.error('sendVoice failed', err);
      await ctx.reply(`Couldn't deliver the voice note: ${(err as Error).message}`);
    }
  });

  // ── shared relay pipeline (used by text + photo + document handlers) ────
  async function relayToActiveSession(
    ctx: AppContext,
    userInput: UserInput,
    /** Text used for the stored history entry — typically userInput.text or "[image]". */
    historyContent: string,
  ): Promise<void> {
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
      session = await createBlankSession(deps, userId, provider, state.modelByProvider[provider]);
      state.activeSessionByProvider[provider] = session.sessionId;
      await deps.repo.putState({ ...state, updatedAt: Date.now() });
    }

    // Auto-title from first turn
    if (!session.title && session.messages.length === 0) {
      session.title = (userInput.text || historyContent).slice(0, 40) || 'New session';
    }

    // Trim history sent to provider (keep full history in storage)
    const trimmed = trimHistory(session.messages, MAX_HISTORY_TURNS);

    // Run the provider stream and tee the chunks: pass to Telegram, accumulate locally.
    // Phase 1: hosted web search is always-on. Each provider's adapter
    // translates `{ kind: 'web_search' }` to its native tool format
    // (Anthropic web_search_20250305, OpenAI web_search_preview, Gemini
    // googleSearch grounding). The model decides when to actually search.
    const gen = providerImpl.streamSend(
      trimmed,
      userInput,
      session.model || providerImpl.defaultModel,
      { tools: [{ kind: 'web_search' }] },
    );
    const meta: {
      assembled: string;
      final: {
        usage: { input: number; output: number };
        model: string;
        citations?: Citation[];
      } | null;
      cancelled: boolean;
    } = { assembled: '', final: null, cancelled: false };

    // Clear any stale cancel flag from a previous interaction before starting.
    await deps.repo.clearCancelFlag(userId);

    let lastCancelCheck = 0;
    async function* relay(): AsyncGenerator<string> {
      while (true) {
        const r = await gen.next();
        if (r.done) {
          meta.final = r.value;
          return;
        }
        const now = Date.now();
        if (now - lastCancelCheck > CANCEL_POLL_MS) {
          lastCancelCheck = now;
          if (await deps.repo.getCancelFlag(userId)) {
            await deps.repo.clearCancelFlag(userId);
            throw new CancelError();
          }
        }
        // Phase 0.4: providers yield StreamChunk; we forward only text deltas
        // to Telegram. tool_use_start / tool_use_end are wired in Phase 4 to
        // surface a transient "🔍 searching…" status line.
        const chunk = r.value;
        if (chunk.kind === 'text' && chunk.delta) {
          meta.assembled += chunk.delta;
          yield chunk.delta;
        }
      }
    }

    let sentMessages: { message_id: number }[] = [];
    try {
      sentMessages = await ctx.replyWithStream(relay());
    } catch (err) {
      if (err instanceof CancelError) {
        meta.cancelled = true;
        // Fall through to the persist + format-edit path so the partial
        // reply is saved and shown with a "(cancelled)" suffix.
      } else {
        console.error('stream error', err);
        await ctx.reply(`Provider error: ${(err as Error).message}`);
        return;
      }
    }

    if (!meta.final && !meta.cancelled) {
      console.warn('stream ended without final usage');
      return;
    }
    // On cancel, we won't have provider-reported usage; estimate as 0
    // (we still record the partial output so cost is non-zero via output tokens
    // we approximate from char count below).
    // Phase 1: append a `_Sources:_` footer if the provider returned citations
    // (typically from a hosted web_search call). Folded into `assembled` so it
    // persists into session history alongside the answer.
    const citationsFooter = renderCitationsFooter(meta.final?.citations);
    const assembled = meta.assembled + (meta.cancelled ? '' : citationsFooter);
    const final = meta.final ?? {
      model: session.model || providerImpl.defaultModel,
      // Rough fallback: Approximate tokens from character count for the cancelled portion.
      usage: { input: 0, output: Math.ceil(assembled.length / 4) },
    };

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
        console.warn('post-stream MarkdownV2 reformat failed, keeping plain text:', err);
      }
    } else if (sentMessages.length > 1 && citationsFooter) {
      // Multi-message responses don't get the in-place reformat — but we
      // still want users to see citations. Send the footer as a follow-up.
      try {
        const formatted = telegramifyMarkdown(citationsFooter.trimStart(), 'escape');
        await ctx.reply(formatted, {
          parse_mode: 'MarkdownV2',
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        console.warn('citations follow-up failed, sending plain text:', err);
        await ctx.reply(citationsFooter.trimStart());
      }
    }

    // Cancel UX: regardless of how far the stream got, surface a clear
    // marker. If no draft was committed, also resend the partial so it
    // isn't lost when the transient draft animation disappears.
    if (meta.cancelled) {
      if (sentMessages.length === 0 && assembled.trim()) {
        // No commit happened — resend the partial as a real message.
        await ctx.reply(assembled.slice(0, 4000));
      }
      await ctx.reply(assembled.trim() ? '🛑 _(cancelled)_' : '🛑 Cancelled before a reply was started.');
    }

    // Persist turn — image bytes are NOT stored; only the text/marker.
    const now = Date.now();
    const userMsg: ChatMessage = { role: 'user', content: historyContent, ts: now };
    const asstContent = meta.cancelled
      ? `${assembled || ''}${assembled ? '\n' : ''}[cancelled]`
      : assembled || '(empty reply)';
    const asstMsg: ChatMessage = {
      role: 'assistant',
      content: asstContent,
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
  }

  // ── plain text ──────────────────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // unknown commands fall through
    await relayToActiveSession(ctx, { text }, text);
  });

  // ── photos (compressed images sent as messages) ─────────────────────────
  bot.on('message:photo', async (ctx) => {
    const photos = ctx.message.photo;
    // Telegram delivers an array of sizes from smallest to largest.
    // Pick the largest that's still under our hard ceiling for inline base64.
    const largest = photos[photos.length - 1];
    if (!largest) return;
    const caption = ctx.message.caption ?? '';
    await handleImageMessage(
      ctx,
      largest.file_id,
      'image/jpeg', // Telegram re-encodes photos to JPEG
      caption,
    );
  });

  // ── documents — only image/* mime types; other documents fall through ───
  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const mime = doc.mime_type ?? '';
    if (!mime.startsWith('image/')) {
      await ctx.reply('Sorry, only image attachments are supported. Send a JPEG/PNG/WEBP photo or image document.');
      return;
    }
    const caption = ctx.message.caption ?? '';
    await handleImageMessage(ctx, doc.file_id, mime, caption);
  });

  // ── stickers / animations: polite refusal ───────────────────────────────
  bot.on(['message:sticker', 'message:animation'], async (ctx) => {
    await ctx.reply("Stickers and GIFs aren't supported yet — try a regular photo.");
  });

  // ── voice notes ─────────────────────────────────────────────────────────
  bot.on('message:voice', async (ctx) => {
    const v = ctx.message.voice;
    await handleVoice(ctx, v.file_id, v.mime_type ?? 'audio/ogg', 'voice.ogg');
  });

  // ── audio files ─────────────────────────────────────────────────────────
  bot.on('message:audio', async (ctx) => {
    const a = ctx.message.audio;
    await handleVoice(
      ctx,
      a.file_id,
      a.mime_type ?? 'audio/mpeg',
      a.file_name ?? 'audio.mp3',
    );
  });

  async function handleVoice(
    ctx: AppContext,
    fileId: string,
    mimeType: string,
    fileName: string,
  ): Promise<void> {
    const userId = ctx.from!.id;

    // Allowlist already gated globally; budget gate here for fast failure.
    const budget = await checkBudget(deps.repo, userId, deps.dailyUsdCapPerUser);
    if (!budget.allowed) {
      await ctx.reply(
        `Daily cap reached: $${budget.usedUsd.toFixed(4)} / $${budget.capUsd.toFixed(2)}.\nResets at UTC midnight.`,
      );
      return;
    }

    if (!deps.providers.has('openai')) {
      await ctx.reply(
        'Voice messages need OpenAI configured. Add `OPENAI_API_KEY` to SSM and redeploy.',
      );
      return;
    }
    const openai = deps.providers.get('openai') as OpenAIProvider;

    let buf: Buffer;
    try {
      const file = await ctx.api.getFile(fileId);
      const filePath = file.file_path;
      if (!filePath) throw new Error('Telegram getFile returned no file_path');
      const fileUrl = `https://api.telegram.org/file/bot${deps.token}/${filePath}`;
      const res = await fetch(fileUrl, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Telegram file fetch ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.error('voice download failed', err);
      await ctx.reply(`Couldn't download the voice note: ${(err as Error).message}`);
      return;
    }

    let transcribed: string;
    let durationSec: number;
    try {
      await ctx.replyWithChatAction('typing').catch(() => {});
      const r = await openai.transcribe(buf, mimeType, fileName);
      transcribed = r.text.trim();
      durationSec = r.durationSec;
    } catch (err) {
      console.error('whisper failed', err);
      await ctx.reply(`Transcription failed: ${(err as Error).message}`);
      return;
    }

    if (!transcribed) {
      await ctx.reply("🎙️ I couldn't make out any speech — try again?");
      return;
    }

    // Echo what we heard so the user can verify.
    await ctx.reply(`🎙️ ${transcribed}`);

    // Bill the audio minutes alongside chat tokens.
    if (durationSec > 0) {
      await recordAudioSpend(deps.repo, userId, durationSec);
    }

    // Pipe through the same relay path as a typed message.
    await relayToActiveSession(ctx, { text: transcribed }, `🎙️ ${transcribed}`);
  }

  // ── shared image-relay path ─────────────────────────────────────────────
  async function handleImageMessage(
    ctx: AppContext,
    fileId: string,
    mimeType: string,
    caption: string,
  ): Promise<void> {
    let base64: string;
    try {
      const file = await ctx.api.getFile(fileId);
      const filePath = file.file_path;
      if (!filePath) throw new Error('Telegram getFile returned no file_path');
      const fileUrl = `https://api.telegram.org/file/bot${deps.token}/${filePath}`;
      const res = await fetch(fileUrl, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Telegram file fetch ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      base64 = buf.toString('base64');
    } catch (err) {
      console.error('image download failed', err);
      await ctx.reply(`Couldn't download the image: ${(err as Error).message}`);
      return;
    }

    const text = caption.trim() || 'Describe this image in detail.';
    const userInput: UserInput = {
      text,
      images: [{ mimeType, base64 }],
    };
    const historyContent = caption.trim() ? `[image] ${caption.trim()}` : '[image]';
    await relayToActiveSession(ctx, userInput, historyContent);
  }

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
  if (existing) {
    // Backfill: older state items predate modelByProvider.
    if (!existing.modelByProvider) existing.modelByProvider = {};
    return existing;
  }
  const fresh: UserState = {
    userId,
    activeProvider: defaultProvider,
    activeSessionByProvider: {},
    modelByProvider: {},
    updatedAt: Date.now(),
  };
  await repo.putState(fresh);
  return fresh;
}

async function createBlankSession(
  deps: BotDeps,
  userId: number,
  provider: ProviderId,
  preferredModel?: string,
): Promise<Session> {
  const now = Date.now();
  const impl = deps.providers.get(provider);
  // If the preferred model is no longer in the curated list (model removed
  // from selectableModels in a deploy), fall back to the provider default.
  const validPreferred =
    preferredModel && impl.selectableModels.some((m) => m.id === preferredModel)
      ? preferredModel
      : null;
  const s: Session = {
    userId,
    sessionId: randomUUID(),
    provider,
    model: validPreferred ?? impl.defaultModel,
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

/**
 * Render a `_Sources:_` footer for citations returned by hosted tools. Used
 * by both the in-place MarkdownV2 reformat (single-message answers) and the
 * follow-up reply (multi-message answers). De-dupes by URL — providers
 * sometimes surface the same source multiple times. Returns an empty string
 * when there's nothing worth showing.
 *
 * The output text is plain Markdown that telegramifyMarkdown will escape;
 * we don't pre-escape link labels here.
 */
function renderCitationsFooter(citations: Citation[] | undefined): string {
  if (!citations || citations.length === 0) return '';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of citations) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    const idx = lines.length + 1;
    const label = (c.title || '').trim() || c.url;
    lines.push(`[${idx}] [${label}](${c.url})`);
  }
  if (lines.length === 0) return '';
  return `\n\n_Sources:_\n${lines.join('\n')}`;
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
    `Available providers: ${list}`,
    '',
    'Commands:',
    '  /model — choose provider (and a specific variant via the ⚙ button)',
    '  /new — start a new session in the current model',
    '  /sessions — list and resume previous sessions for the current model',
    '  /rename <title> — rename the active session',
    '  /forget — delete the active session',
    '  /cancel — stop the response that\'s currently streaming',
    '  /say — read the latest reply aloud (or reply to any message with /say to read that one)',
    '  /usage — see today\'s token + cost usage',
    '',
    'How to use:',
    '• Send any text message to chat with the active model.',
    '• Send a 📷 photo (or attach a JPEG/PNG document) — the AI sees the image. Add a caption to ask a specific question; otherwise it just describes it.',
    '• Send a 🎙️ voice note or audio file — it gets transcribed via Whisper and the text is sent to the active model. The bot echoes back what it heard so you can verify.',
    '• While a long response is streaming, send /cancel to stop early — you keep what was generated so far.',
    '• Want to listen to a reply? Send /say to hear the latest one read back, or reply to any message with /say to hear that specific one.',
  ].join('\n');
}
