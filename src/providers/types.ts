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

export interface ImageInput {
  /** MIME type, e.g. `image/jpeg` or `image/png`. */
  mimeType: string;
  /** Raw base64-encoded image bytes (no `data:` prefix). */
  base64: string;
}

/**
 * What the user just said, plus any attachments on this turn. Images are
 * turn-local — they're sent to the provider for this turn only and are not
 * persisted in session history.
 */
export interface UserInput {
  text: string;
  images?: ImageInput[];
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
  send(history: ChatMessage[], userInput: UserInput, model?: string): Promise<ProviderReply>;
  /**
   * Stream a response. Yields token-delta strings and returns final usage.
   */
  streamSend(history: ChatMessage[], userInput: UserInput, model?: string): ProviderStream;
}
