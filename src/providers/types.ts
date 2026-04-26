import type { ChatMessage, ProviderId } from '../sessions/types.js';

export interface TokenUsage {
  input: number;
  output: number;
}

/**
 * One source citation surfaced by a hosted tool (web search, web fetch,
 * MCP tool, etc). Each provider exposes citation metadata differently —
 * adapters normalize to this shape so the bot can render a single
 * `_Sources:_` footer regardless of which provider answered.
 */
export interface Citation {
  url: string;
  title?: string;
  /** Optional excerpt or page-age metadata; may be empty. */
  snippet?: string;
}

export interface ProviderReply {
  text: string;
  usage: TokenUsage;
  model: string;
  citations?: Citation[];
}

export interface StreamFinal {
  usage: TokenUsage;
  model: string;
  citations?: Citation[];
}

/**
 * One chunk yielded by a provider stream. Most chunks are text deltas; a
 * provider may also signal that it's about to invoke a server-side tool
 * (e.g. web_search) so the UI can surface a transient status line.
 *
 * Phase 0 only emits `{ kind: 'text' }`. Phase 1+ wires the tool-use kinds
 * once hosted tools are enabled per provider.
 */
export type StreamChunk =
  | { kind: 'text'; delta: string }
  | { kind: 'tool_use_start'; name: string; id?: string }
  | { kind: 'tool_use_end'; id?: string };

/**
 * Async generator that yields `StreamChunk`s, then returns a final
 * `{ usage, model }` value when the stream completes.
 */
export type ProviderStream = AsyncGenerator<StreamChunk, StreamFinal, void>;

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

/**
 * Provider-agnostic intent flag for an agentic capability. Each provider's
 * adapter translates these to its native tool format (Anthropic
 * `web_search_20250305`, OpenAI Responses `web_search`, Gemini `googleSearch`,
 * etc). Adapters may ignore kinds they don't support.
 */
export type ToolSpec =
  | { kind: 'web_search' }
  | { kind: 'web_fetch' }
  | { kind: 'code_execution' };

/**
 * Remote MCP server configuration. Passed through to providers that natively
 * host MCP clients (Anthropic `mcp_servers`, OpenAI Responses `tools[].mcp`).
 * Stdio MCP servers are intentionally out of scope — the bot runs in a
 * short-lived Lambda and cannot keep subprocess MCP hosts alive.
 */
export interface McpServerSpec {
  /** Stable identifier surfaced to the model and used in tool ids. */
  name: string;
  /** HTTPS URL of the remote MCP server. */
  url: string;
  /** Optional bearer token; passed in `Authorization: Bearer ...`. */
  authToken?: string;
}

export interface AgenticOptions {
  /** Hosted tools to advertise to the provider. Empty/undefined = no tools. */
  tools?: ToolSpec[];
  /** Remote MCP servers to make available. */
  mcpServers?: McpServerSpec[];
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
  send(
    history: ChatMessage[],
    userInput: UserInput,
    model?: string,
    options?: AgenticOptions,
  ): Promise<ProviderReply>;
  /**
   * Stream a response. Yields `StreamChunk`s and returns final usage.
   */
  streamSend(
    history: ChatMessage[],
    userInput: UserInput,
    model?: string,
    options?: AgenticOptions,
  ): ProviderStream;
}
