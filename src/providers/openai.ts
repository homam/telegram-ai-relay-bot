import OpenAI from 'openai';
import { chatMessageText, type ChatMessage } from '../sessions/types.js';
import type {
  AgenticOptions,
  AIProvider,
  ProviderReply,
  ProviderStream,
  SelectableModel,
  UserInput,
} from './types.js';

type UserContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

function buildUserContent(input: UserInput): UserContent {
  if (!input.images?.length) return input.text;
  const parts: Exclude<UserContent, string> = [{ type: 'text', text: input.text }];
  for (const img of input.images) {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    });
  }
  return parts;
}

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const;
  readonly defaultModel: string;
  readonly selectableModels: ReadonlyArray<SelectableModel> = [
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
    { id: 'gpt-5.4-pro', label: 'GPT-5.4 Pro' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
  ];
  private client: OpenAI;

  constructor(apiKey: string, defaultModel = 'gpt-5.4') {
    this.client = new OpenAI({ apiKey });
    this.defaultModel = defaultModel;
  }

  async send(
    history: ChatMessage[],
    userInput: UserInput,
    model?: string,
    _options?: AgenticOptions,
  ): Promise<ProviderReply> {
    const resolved = model ?? this.defaultModel;
    const messages = [
      // Phase 0.1 compat: collapse blocks to plain text. Phase 0.3 will walk
      // ContentBlock[] into OpenAI's tool_calls / role:'tool' message shape.
      ...history.map((m) => ({ role: m.role, content: chatMessageText(m) })),
      { role: 'user' as const, content: buildUserContent(userInput) },
    ];
    const r = await this.client.chat.completions.create({
      model: resolved,
      // The OpenAI SDK accepts either string or content-array for `content`.
      messages: messages as never,
    });
    const text = r.choices[0]?.message?.content ?? '';
    return {
      text,
      model: resolved,
      usage: {
        input: r.usage?.prompt_tokens ?? 0,
        output: r.usage?.completion_tokens ?? 0,
      },
    };
  }

  async *streamSend(
    history: ChatMessage[],
    userInput: UserInput,
    model?: string,
    _options?: AgenticOptions,
  ): ProviderStream {
    const resolved = model ?? this.defaultModel;
    const messages = [
      // Phase 0.1 compat: collapse blocks to plain text. Phase 0.5 will walk
      // ContentBlock[] into the Responses API native shape (we're skipping the
      // Chat Completions tool_calls path because it's about to be replaced).
      ...history.map((m) => ({ role: m.role, content: chatMessageText(m) })),
      { role: 'user' as const, content: buildUserContent(userInput) },
    ];
    const stream = await this.client.chat.completions.create({
      model: resolved,
      messages: messages as never,
      stream: true,
      stream_options: { include_usage: true },
    });
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) yield { kind: 'text', delta };
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    }
    return { model: resolved, usage: { input: inputTokens, output: outputTokens } };
  }

  /**
   * Whisper STT. Note: this lives on OpenAIProvider only (not the AIProvider
   * interface) because Whisper is OpenAI-specific. The bot calls it directly
   * regardless of the user's active chat provider.
   */
  async transcribe(
    audio: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<{ text: string; durationSec: number }> {
    const file = await OpenAI.toFile(audio, fileName, { type: mimeType });
    const r = await this.client.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      response_format: 'verbose_json',
    });
    return {
      text: r.text,
      durationSec: (r as { duration?: number }).duration ?? 0,
    };
  }

  /**
   * TTS. Returns OPUS-encoded audio (Telegram expects this format for voice
   * notes). Truncates to 4096 chars — OpenAI's hard limit per request.
   */
  async textToSpeech(
    text: string,
    voice: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' | 'coral' = 'alloy',
  ): Promise<{ audio: Buffer; chars: number; truncated: boolean }> {
    const truncated = text.length > 4096;
    const input = truncated ? text.slice(0, 4096) : text;
    const r = await this.client.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice,
      input,
      response_format: 'opus',
    });
    return { audio: Buffer.from(await r.arrayBuffer()), chars: input.length, truncated };
  }
}
