import { GoogleGenAI } from '@google/genai';
import type { ChatMessage } from '../sessions/types.js';
import type { AIProvider, ProviderReply, ProviderStream, SelectableModel } from './types.js';

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

  async send(history: ChatMessage[], userMessage: string, model?: string): Promise<ProviderReply> {
    const resolved = model ?? this.defaultModel;

    // Gemini uses 'user' / 'model' roles. Map system messages to a system instruction,
    // and assistant -> model.
    const systemParts: string[] = [];
    const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
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
    contents.push({ role: 'user', parts: [{ text: userMessage }] });

    const r = await this.client.models.generateContent({
      model: resolved,
      contents,
      config: systemParts.length ? { systemInstruction: systemParts.join('\n\n') } : undefined,
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

  async *streamSend(history: ChatMessage[], userMessage: string, model?: string): ProviderStream {
    const resolved = model ?? this.defaultModel;

    const systemParts: string[] = [];
    const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
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
    contents.push({ role: 'user', parts: [{ text: userMessage }] });

    const stream = await this.client.models.generateContentStream({
      model: resolved,
      contents,
      config: systemParts.length ? { systemInstruction: systemParts.join('\n\n') } : undefined,
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
