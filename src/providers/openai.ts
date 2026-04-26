import OpenAI from 'openai';
import type {
  ResponseInputItem,
  ResponseInputContent,
  ResponseOutputItem,
  Tool,
} from 'openai/resources/responses/responses.js';
import type { ChatMessage, ContentBlock } from '../sessions/types.js';
import type {
  AgenticOptions,
  AIProvider,
  Citation,
  McpServerSpec,
  ProviderReply,
  ProviderStream,
  SelectableModel,
  ToolSpec,
  UserInput,
} from './types.js';

/**
 * Translate our internal ToolSpec[] + McpServerSpec[] to Responses API
 * native tools entries. Returns undefined when nothing maps so we omit
 * the param entirely.
 *
 * - web_search → { type: 'web_search_preview' }. SDK 4.104.0 only exposes
 *   the *_preview literal; GA name will roll in via a later SDK bump.
 * - Each MCP server → { type: 'mcp', server_label, server_url, headers? }.
 *   Auto-approve every tool call: the bot is already gated by an
 *   allowlist, so an inline-button approval round-trip would only break
 *   the streaming UX. (Phase 4 can revisit if a per-tool toggle is wanted.)
 */
function mapTools(
  tools: ToolSpec[] | undefined,
  mcpServers: McpServerSpec[] | undefined,
): Tool[] | undefined {
  const out: Tool[] = [];
  for (const t of tools ?? []) {
    if (t.kind === 'web_search') {
      out.push({ type: 'web_search_preview' });
    }
  }
  for (const s of mcpServers ?? []) {
    out.push({
      type: 'mcp',
      server_label: s.name,
      server_url: s.url,
      ...(s.authToken ? { headers: { Authorization: `Bearer ${s.authToken}` } } : {}),
      require_approval: 'never',
    });
  }
  return out.length ? out : undefined;
}

/** Count hosted-tool calls in the Responses API output[] for billing. */
function countWebSearchCalls(output: ResponseOutputItem[]): number {
  let n = 0;
  for (const item of output) {
    if (item.type === 'web_search_call') n++;
  }
  return n;
}

/**
 * Walk the Responses API output[] for assistant messages, collect URL
 * citations from output_text annotations, and normalize to our Citation
 * shape. De-dupes by URL across all output_text content items.
 */
function extractCitations(output: ResponseOutputItem[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const c of item.content) {
      if (c.type !== 'output_text' || !c.annotations) continue;
      for (const a of c.annotations) {
        if (a.type !== 'url_citation') continue;
        if (seen.has(a.url)) continue;
        seen.add(a.url);
        out.push({ url: a.url, title: a.title || undefined });
      }
    }
  }
  return out;
}

/**
 * Build the user-content array for the *current* turn (text + optional images).
 * Uses the Responses API content-item shape: `input_text` and `input_image`.
 */
function buildUserContent(input: UserInput): string | ResponseInputContent[] {
  if (!input.images?.length) return input.text;
  const parts: ResponseInputContent[] = [{ type: 'input_text', text: input.text }];
  for (const img of input.images) {
    parts.push({
      type: 'input_image',
      image_url: `data:${img.mimeType};base64,${img.base64}`,
      detail: 'auto',
    });
  }
  return parts;
}

/**
 * Map our internal ContentBlock[] to a Responses API user/assistant message
 * `content` value. Tool blocks are NOT mapped here — they have to be split
 * into separate `function_call` / `function_call_output` items at the
 * prepare() level. For Phase 0 nothing in history actually carries tool
 * blocks yet (no tool is enabled until Phase 1), so we conservatively drop
 * unknown variants and log once.
 */
function blocksToResponsesContent(
  blocks: ContentBlock[],
  role: 'user' | 'assistant' | 'system',
): string | ResponseInputContent[] {
  const parts: ResponseInputContent[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push({ type: 'input_text', text: b.text });
    } else if (b.type === 'image') {
      // Images are only valid on user role.
      if (role !== 'user') continue;
      parts.push({
        type: 'input_image',
        image_url: `data:${b.mimeType};base64,${b.base64}`,
        detail: 'auto',
      });
    } else {
      // tool_use / tool_result need separate ResponseInputItem entries
      // (function_call / function_call_output) — they cannot live inside a
      // message content array. They're skipped here; prepare() handles them.
      // Phase 1 will fill in the proper item-emission path.
    }
  }
  // Collapse single-text-part to a string so the API call is more readable.
  if (parts.length === 1 && parts[0]!.type === 'input_text') {
    return (parts[0] as { type: 'input_text'; text: string }).text;
  }
  if (parts.length === 0) return '';
  return parts;
}

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

  /**
   * Build the Responses API request payload. System messages are joined and
   * lifted into the top-level `instructions` field (Responses API's preferred
   * pattern). Everything else becomes a `ResponseInputItem`.
   */
  private prepare(history: ChatMessage[], userInput: UserInput) {
    const systemParts: string[] = [];
    const items: ResponseInputItem[] = [];

    for (const m of history) {
      if (m.role === 'system') {
        const text = typeof m.content === 'string' ? m.content : (() => {
          const c = blocksToResponsesContent(m.content, 'system');
          return typeof c === 'string' ? c : '';
        })();
        if (text) systemParts.push(text);
        continue;
      }
      const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
      if (typeof m.content === 'string') {
        items.push({ role, content: m.content, type: 'message' });
      } else {
        // Phase 0 only emits text/image content; tool_use / tool_result blocks
        // (which won't appear until Phase 1) need to be split into separate
        // function_call / function_call_output items. Punted until then.
        const content = blocksToResponsesContent(m.content, role);
        if (content !== '') {
          items.push({ role, content, type: 'message' });
        }
      }
    }

    // Append the current turn.
    items.push({ role: 'user', content: buildUserContent(userInput), type: 'message' });

    return {
      instructions: systemParts.length ? systemParts.join('\n\n') : undefined,
      input: items,
    };
  }

  async send(
    history: ChatMessage[],
    userInput: UserInput,
    model?: string,
    options?: AgenticOptions,
  ): Promise<ProviderReply> {
    const resolved = model ?? this.defaultModel;
    const { instructions, input } = this.prepare(history, userInput);
    const tools = mapTools(options?.tools, options?.mcpServers);

    const r = await this.client.responses.create({
      model: resolved,
      instructions,
      input,
      ...(tools ? { tools } : {}),
    });

    const citations = extractCitations(r.output);
    const webSearches = countWebSearchCalls(r.output);
    return {
      text: r.output_text ?? '',
      model: resolved,
      usage: {
        input: r.usage?.input_tokens ?? 0,
        output: r.usage?.output_tokens ?? 0,
      },
      ...(citations.length ? { citations } : {}),
      ...(webSearches > 0 ? { toolCalls: { web_search: webSearches } } : {}),
    };
  }

  async *streamSend(
    history: ChatMessage[],
    userInput: UserInput,
    model?: string,
    options?: AgenticOptions,
  ): ProviderStream {
    const resolved = model ?? this.defaultModel;
    const { instructions, input } = this.prepare(history, userInput);
    const tools = mapTools(options?.tools, options?.mcpServers);

    const stream = await this.client.responses.create({
      model: resolved,
      instructions,
      input,
      stream: true,
      ...(tools ? { tools } : {}),
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let citations: Citation[] = [];
    let webSearches = 0;
    for await (const event of stream) {
      // Text deltas — the bread-and-butter case.
      if (event.type === 'response.output_text.delta') {
        if (event.delta) yield { kind: 'text', delta: event.delta };
        continue;
      }
      // Final usage + full output (with annotations) arrive on the terminal
      // `response.completed` event.
      if (event.type === 'response.completed') {
        const u = event.response.usage;
        if (u) {
          inputTokens = u.input_tokens;
          outputTokens = u.output_tokens;
        }
        citations = extractCitations(event.response.output);
        webSearches = countWebSearchCalls(event.response.output);
        continue;
      }
      // Phase 1.6 (deferred) would surface tool-use start/end here:
      //   response.web_search_call.in_progress  → tool_use_start
      //   response.web_search_call.completed    → tool_use_end
      //   response.code_interpreter_call.*      → idem
      //   response.mcp_call.*                   → idem
    }
    return {
      model: resolved,
      usage: { input: inputTokens, output: outputTokens },
      ...(citations.length ? { citations } : {}),
      ...(webSearches > 0 ? { toolCalls: { web_search: webSearches } } : {}),
    };
  }

  /**
   * Whisper STT. Note: this lives on OpenAIProvider only (not the AIProvider
   * interface) because Whisper is OpenAI-specific. The bot calls it directly
   * regardless of the user's active chat provider.
   */
  async transcribe(
    audio: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<{ text: string; durationSec: number }> {
    const file = await OpenAI.toFile(audio, fileName, { type: mimeType });
    const r = await this.client.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      response_format: 'verbose_json',
    });
    return {
      text: r.text,
      durationSec: (r as { duration?: number }).duration ?? 0,
    };
  }

  /**
   * TTS. Returns OPUS-encoded audio (Telegram expects this format for voice
   * notes). Truncates to 4096 chars — OpenAI's hard limit per request.
   */
  async textToSpeech(
    text: string,
    voice: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' | 'coral' = 'alloy',
  ): Promise<{ audio: Buffer; chars: number; truncated: boolean }> {
    const truncated = text.length > 4096;
    const input = truncated ? text.slice(0, 4096) : text;
    const r = await this.client.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice,
      input,
      response_format: 'opus',
    });
    return { audio: Buffer.from(await r.arrayBuffer()), chars: input.length, truncated };
  }
}
