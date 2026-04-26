import { GoogleGenAI, type GroundingMetadata, type Tool } from '@google/genai';
import {
  chatMessageText,
  type ChatMessage,
  type ContentBlock,
} from '../sessions/types.js';
import type {
  AgenticOptions,
  AIProvider,
  Citation,
  ProviderReply,
  ProviderStream,
  SelectableModel,
  ToolSpec,
  UserInput,
} from './types.js';

/**
 * Translate our internal ToolSpec[] to Gemini's tool config. Gemini's hosted
 * grounding tools are expressed as fields on a single Tool object — there's
 * no per-call selection like Anthropic/OpenAI. We bundle them into a single
 * entry. Returns undefined when nothing maps so we omit the param entirely.
 */
function mapTools(tools: ToolSpec[] | undefined): Tool[] | undefined {
  if (!tools?.length) return undefined;
  const tool: Tool = {};
  for (const t of tools) {
    if (t.kind === 'web_search') {
      tool.googleSearch = {};
    }
    // web_fetch (Gemini's `urlContext`) and code_execution are gated to Phase 3.
  }
  return Object.keys(tool).length ? [tool] : undefined;
}

/**
 * Pull web citations out of grounding metadata. Gemini groups all
 * grounding evidence under `groundingChunks[]` — we only surface the `web`
 * variant as Citation entries (not Maps, image search, etc).
 */
function extractCitations(meta: GroundingMetadata | undefined): Citation[] {
  if (!meta?.groundingChunks?.length) return [];
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const chunk of meta.groundingChunks) {
    const w = chunk.web;
    if (!w?.uri || seen.has(w.uri)) continue;
    seen.add(w.uri);
    out.push({ url: w.uri, title: w.title ?? undefined });
  }
  return out;
}

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
    options?: AgenticOptions,
  ): Promise<ProviderReply> {
    const resolved = model ?? this.defaultModel;
    const { contents, config } = this.prepare(history, userInput);
    const tools = mapTools(options?.tools);
    const fullConfig = tools ? { ...(config ?? {}), tools } : config;

    const r = await this.client.models.generateContent({
      model: resolved,
      contents,
      config: fullConfig,
    });

    const text = r.text ?? '';
    const usage = r.usageMetadata;
    const citations = extractCitations(r.candidates?.[0]?.groundingMetadata);

    return {
      text,
      model: resolved,
      usage: {
        input: usage?.promptTokenCount ?? 0,
        output: usage?.candidatesTokenCount ?? 0,
      },
      ...(citations.length ? { citations } : {}),
    };
  }

  async *streamSend(
    history: ChatMessage[],
    userInput: UserInput,
    model?: string,
    options?: AgenticOptions,
  ): ProviderStream {
    const resolved = model ?? this.defaultModel;
    const { contents, config } = this.prepare(history, userInput);
    const tools = mapTools(options?.tools);
    const fullConfig = tools ? { ...(config ?? {}), tools } : config;

    const stream = await this.client.models.generateContentStream({
      model: resolved,
      contents,
      config: fullConfig,
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let lastGrounding: GroundingMetadata | undefined;
    for await (const chunk of stream) {
      if (chunk.text) yield { kind: 'text', delta: chunk.text };
      const u = chunk.usageMetadata;
      if (u) {
        inputTokens = u.promptTokenCount ?? inputTokens;
        outputTokens = u.candidatesTokenCount ?? outputTokens;
      }
      // Grounding metadata accumulates across chunks; the latest chunk
      // carrying it has the most complete picture.
      const g = chunk.candidates?.[0]?.groundingMetadata;
      if (g) lastGrounding = g;
    }
    const citations = extractCitations(lastGrounding);
    return {
      model: resolved,
      usage: { input: inputTokens, output: outputTokens },
      ...(citations.length ? { citations } : {}),
    };
  }
}
