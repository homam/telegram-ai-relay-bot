import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '../sessions/types.js';
import type {
  AIProvider,
  ProviderReply,
  ProviderStream,
  SelectableModel,
  UserInput,
} from './types.js';

type AnthropicMessage = { role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] };

function buildUserContent(input: UserInput): string | Anthropic.ContentBlockParam[] {
  if (!input.images?.length) return input.text;
  const parts: Anthropic.ContentBlockParam[] = [];
  for (const img of input.images) {
    parts.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType as Anthropic.Base64ImageSource['media_type'],
        data: img.base64,
      },
    });
  }
  parts.push({ type: 'text', text: input.text });
  return parts;
}

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

  private prepare(history: ChatMessage[], userInput: UserInput) {
    const systemParts: string[] = [];
    const messages: AnthropicMessage[] = [];
    for (const m of history) {
      if (m.role === 'system') systemParts.push(m.content);
      else messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: 'user', content: buildUserContent(userInput) });
    return {
      system: systemParts.length ? systemParts.join('\n\n') : undefined,
      messages,
    };
  }

  async send(history: ChatMessage[], userInput: UserInput, model?: string): Promise<ProviderReply> {
    const resolved = model ?? this.defaultModel;
    const { system, messages } = this.prepare(history, userInput);

    const r = await this.client.messages.create({
      model: resolved,
      max_tokens: 4096,
      system,
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

  async *streamSend(history: ChatMessage[], userInput: UserInput, model?: string): ProviderStream {
    const resolved = model ?? this.defaultModel;
    const { system, messages } = this.prepare(history, userInput);

    const stream = this.client.messages.stream({
      model: resolved,
      max_tokens: 4096,
      system,
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
