import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '../sessions/types.js';
import type { AIProvider, ProviderReply, ProviderStream, SelectableModel } from './types.js';

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  readonly defaultModel: string;
  readonly selectableModels: ReadonlyArray<SelectableModel> = [
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  ];
  private client: Anthropic;

  constructor(apiKey: string, defaultModel = 'claude-haiku-4-5') {
    this.client = new Anthropic({ apiKey });
    this.defaultModel = defaultModel;
  }

  async send(history: ChatMessage[], userMessage: string, model?: string): Promise<ProviderReply> {
    const resolved = model ?? this.defaultModel;

    // Anthropic separates system prompt from messages and only allows user/assistant roles.
    const systemParts: string[] = [];
    const messages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of history) {
      if (m.role === 'system') systemParts.push(m.content);
      else messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: 'user', content: userMessage });

    const r = await this.client.messages.create({
      model: resolved,
      max_tokens: 4096,
      system: systemParts.length ? systemParts.join('\n\n') : undefined,
      messages,
    });

    const text = r.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      text,
      model: resolved,
      usage: {
        input: r.usage.input_tokens,
        output: r.usage.output_tokens,
      },
    };
  }

  async *streamSend(history: ChatMessage[], userMessage: string, model?: string): ProviderStream {
    const resolved = model ?? this.defaultModel;

    const systemParts: string[] = [];
    const messages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of history) {
      if (m.role === 'system') systemParts.push(m.content);
      else messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: 'user', content: userMessage });

    const stream = this.client.messages.stream({
      model: resolved,
      max_tokens: 4096,
      system: systemParts.length ? systemParts.join('\n\n') : undefined,
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
    const final = await stream.finalMessage();
    return {
      model: resolved,
      usage: { input: final.usage.input_tokens, output: final.usage.output_tokens },
    };
  }
}
