import type { ChatMessage, ProviderId } from '../sessions/types.js';

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ProviderReply {
  text: string;
  usage: TokenUsage;
  model: string;
}

export interface StreamFinal {
  usage: TokenUsage;
  model: string;
}

/**
 * Async generator that yields token-delta strings, then returns a final
 * `{ usage, model }` value when the stream completes.
 */
export type ProviderStream = AsyncGenerator<string, StreamFinal, void>;

export interface SelectableModel {
  /** Model ID as the provider's API expects it (e.g. `gpt-5.4-mini`). */
  id: string;
  /** Human-friendly label shown in the Telegram inline keyboard. */
  label: string;
}

export interface AIProvider {
  id: ProviderId;
  defaultModel: string;
  /** Curated list of variants the bot exposes for end-user selection. */
  readonly selectableModels: ReadonlyArray<SelectableModel>;
  /**
   * Send conversation history (already-trimmed) plus the latest user message.
   * Returns assistant text and token usage.
   */
  send(history: ChatMessage[], userMessage: string, model?: string): Promise<ProviderReply>;
  /**
   * Stream a response. Yields token-delta strings and returns final usage.
   */
  streamSend(history: ChatMessage[], userMessage: string, model?: string): ProviderStream;
}
