import { GoogleGenAI } from '@google/genai';
import type { ChatMessage } from '../sessions/types.js';
import type {
  AIProvider,
  ProviderReply,
  ProviderStream,
  SelectableModel,
  UserInput,
} from './types.js';

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

function buildUserParts(input: UserInput): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const img of input.images ?? []) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
  }
  parts.push({ text: input.text });
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
        systemParts.push(m.content);
      } else {
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        });
      }
    }
    contents.push({ role: 'user', parts: buildUserParts(userInput) });
    return {
      contents,
      config: systemParts.length ? { systemInstruction: systemParts.join('\n\n') } : undefined,
    };
  }

  async send(history: ChatMessage[], userInput: UserInput, model?: string): Promise<ProviderReply> {
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

  async *streamSend(history: ChatMessage[], userInput: UserInput, model?: string): ProviderStream {
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
      if (chunk.text) yield chunk.text;
      const u = chunk.usageMetadata;
      if (u) {
        inputTokens = u.promptTokenCount ?? inputTokens;
        outputTokens = u.candidatesTokenCount ?? outputTokens;
      }
    }
    return { model: resolved, usage: { input: inputTokens, output: outputTokens } };
  }
}
