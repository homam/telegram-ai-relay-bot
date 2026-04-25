import OpenAI from 'openai';
import type { ChatMessage } from '../sessions/types.js';
import type { AIProvider, ProviderReply, ProviderStream, SelectableModel } from './types.js';

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

  async send(history: ChatMessage[], userMessage: string, model?: string): Promise<ProviderReply> {
    const resolved = model ?? this.defaultModel;
    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: userMessage },
    ];
    const r = await this.client.chat.completions.create({
      model: resolved,
      messages,
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

  async *streamSend(history: ChatMessage[], userMessage: string, model?: string): ProviderStream {
    const resolved = model ?? this.defaultModel;
    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: userMessage },
    ];
    const stream = await this.client.chat.completions.create({
      model: resolved,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) yield delta;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    }
    return { model: resolved, usage: { input: inputTokens, output: outputTokens } };
  }
}
