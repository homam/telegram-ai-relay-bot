import { GoogleGenAI } from '@google/genai';
import {
  chatMessageText,
  type ChatMessage,
  type ContentBlock,
} from '../sessions/types.js';
import type {
  AgenticOptions,
  AIProvider,
  ProviderReply,
  ProviderStream,
  SelectableModel,
  UserInput,
} from './types.js';

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };
type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

function buildUserParts(input: UserInput): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const img of input.images ?? []) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
  }
  parts.push({ text: input.text });
  return parts;
}

/**
 * Map our internal ContentBlock[] to Gemini parts on a single content entry.
 * Gemini's role conventions:
 *   - tool_use → `functionCall` part on a `model` role content
 *   - tool_result → `functionResponse` part on a `user` role content
 *   - text → `text` part on whichever role
 *   - image → `inlineData` part (only valid on `user` role)
 *
 * Returns empty array if nothing maps cleanly.
 */
function blocksToGeminiParts(
  blocks: ContentBlock[],
  role: 'user' | 'model',
): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push({ text: b.text });
    } else if (b.type === 'image') {
      if (role !== 'user') continue;
      parts.push({ inlineData: { mimeType: b.mimeType, data: b.base64 } });
    } else if (b.type === 'tool_use') {
      if (role !== 'model') continue;
      parts.push({
        functionCall: {
          name: b.name,
          args: (b.input as Record<string, unknown>) ?? {},
        },
      });
    } else if (b.type === 'tool_result') {
      if (role !== 'user') continue;
      // Gemini's functionResponse uses the function NAME as key, not the
      // tool_use id. We don't have the name here — fall back to a stable
      // placeholder; callers wiring real tools should preserve the name.
      // For Phase 0 nothing actually round-trips this path.
      parts.push({
        functionResponse: {
          name: b.tool_use_id,
          response: { content: b.content, ...(b.isError ? { isError: true } : {}) },
        },
      });
    }
  }
  return parts;
}

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini' as const;
  readonly defaultModel: string;
  readonly selectableModels: ReadonlyArray<SelectableModel> = [
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  ];
  private client: GoogleGenAI;

  constructor(apiKey: string, defaultModel = 'gemini-2.0-flash') {
    this.client = new GoogleGenAI({ apiKey });
    this.defaultModel = defaultModel;
  }

  private prepare(history: ChatMessage[], userInput: UserInput) {
    // Gemini uses 'user' / 'model' roles. Map system messages to a system
    // instruction, and assistant -> model.
    const systemParts: string[] = [];
    const contents: GeminiContent[] = [];
    for (const m of history) {
      if (m.role === 'system') {
        systemParts.push(chatMessageText(m));
        continue;
      }
      const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
      if (typeof m.content === 'string') {
        contents.push({ role, parts: [{ text: m.content }] });
      } else {
        const parts = blocksToGeminiParts(m.content, role);
        if (parts.length) contents.push({ role, parts });
      }
    }
    contents.push({ role: 'user', parts: buildUserParts(userInput) });
    return {
      contents,
      config: systemParts.length ? { systemInstruction: systemParts.join('\n\n') } : undefined,
    };
  }

  async send(
    history: ChatMessage[],
    userInput: UserInput,
    model?: string,
    _options?: AgenticOptions,
  ): Promise<ProviderReply> {
    const resolved = model ?? this.defaultModel;
    const { contents, config } = this.prepare(history, userInput);

    const r = await this.client.models.generateContent({
      model: resolved,
      contents,
      config,
    });

    const text = r.text ?? '';
    const usage = r.usageMetadata;

    return {
      text,
      model: resolved,
      usage: {
        input: usage?.promptTokenCount ?? 0,
        output: usage?.candidatesTokenCount ?? 0,
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
    const { contents, config } = this.prepare(history, userInput);

    const stream = await this.client.models.generateContentStream({
      model: resolved,
      contents,
      config,
    });

    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of stream) {
      if (chunk.text) yield { kind: 'text', delta: chunk.text };
      const u = chunk.usageMetadata;
      if (u) {
        inputTokens = u.promptTokenCount ?? inputTokens;
        outputTokens = u.candidatesTokenCount ?? outputTokens;
      }
    }
    return { model: resolved, usage: { input: inputTokens, output: outputTokens } };
  }
}
