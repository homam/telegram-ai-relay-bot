import Anthropic from '@anthropic-ai/sdk';
import {
  chatMessageText,
  type ChatMessage,
  type ContentBlock,
} from '../sessions/types.js';
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

/** Beta header required for `mcp_servers` on the Anthropic Beta Messages API. */
const MCP_BETA = 'mcp-client-2025-04-04';

/**
 * Translate our internal ToolSpec[] to Anthropic's native tool union.
 * Returns undefined when the list is empty so we omit the param entirely
 * (Anthropic 400s on `tools: []`).
 *
 * Phase 1 wires `web_search` only; web_fetch and code_execution map to
 * their respective server-tool types but are gated to Phase 3.
 */
function mapTools(tools: ToolSpec[] | undefined): Anthropic.ToolUnion[] | undefined {
  if (!tools?.length) return undefined;
  const out: Anthropic.ToolUnion[] = [];
  for (const t of tools) {
    if (t.kind === 'web_search') {
      out.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
    }
    // web_fetch / code_execution intentionally not wired in Phase 1.
  }
  return out.length ? out : undefined;
}

/** Extract Anthropic web-search citations from the response's text blocks. */
function extractCitations(content: Anthropic.ContentBlock[]): Citation[] {
  const out: Citation[] = [];
  for (const b of content) {
    if (b.type !== 'text' || !b.citations) continue;
    for (const c of b.citations) {
      if (c.type === 'web_search_result_location') {
        out.push({
          url: c.url,
          title: c.title ?? undefined,
          snippet: c.cited_text || undefined,
        });
      }
    }
  }
  return out;
}

/**
 * Translate our internal McpServerSpec[] to Anthropic Beta's MCP server
 * definitions. Returns undefined if the list is empty so we can omit the
 * param. Each server's `name` doubles as the label the model sees in tool
 * calls.
 */
function mapMcpServers(
  servers: McpServerSpec[] | undefined,
): Array<{ type: 'url'; name: string; url: string; authorization_token?: string }> | undefined {
  if (!servers?.length) return undefined;
  return servers.map((s) => ({
    type: 'url' as const,
    name: s.name,
    url: s.url,
    ...(s.authToken ? { authorization_token: s.authToken } : {}),
  }));
}

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

/**
 * Map our internal ContentBlock[] to Anthropic's ContentBlockParam[].
 * Anthropic supports text, image, tool_use, and tool_result as first-class
 * blocks — this is the cleanest provider mapping of the three.
 *
 * Returns `null` if the block list contains nothing renderable (e.g. pure
 * image blocks for an assistant role, which Anthropic doesn't allow).
 */
function blocksToAnthropic(
  blocks: ContentBlock[],
  role: 'user' | 'assistant',
): Anthropic.ContentBlockParam[] | null {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'image') {
      // Anthropic only accepts image blocks on user role messages.
      if (role !== 'user') continue;
      out.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: b.mimeType as Anthropic.Base64ImageSource['media_type'],
          data: b.base64,
        },
      });
    } else if (b.type === 'tool_use') {
      // Tool-use blocks belong on assistant messages.
      if (role !== 'assistant') continue;
      out.push({
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Anthropic.ToolUseBlockParam['input'],
      });
    } else if (b.type === 'tool_result') {
      // Tool-result blocks belong on user messages.
      if (role !== 'user') continue;
      out.push({
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
      });
    }
  }
  return out.length ? out : null;
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
      if (m.role === 'system') {
        // System messages are joined as plain text — Anthropic's `system` param
        // doesn't accept tool blocks anyway.
        systemParts.push(chatMessageText(m));
        continue;
      }
      if (typeof m.content === 'string') {
        messages.push({ role: m.role, content: m.content });
      } else {
        const mapped = blocksToAnthropic(m.content, m.role);
        if (mapped) messages.push({ role: m.role, content: mapped });
      }
    }
    messages.push({ role: 'user', content: buildUserContent(userInput) });
    return {
      system: systemParts.length ? systemParts.join('\n\n') : undefined,
      messages,
    };
  }

  async send(
    history: ChatMessage[],
    userInput: UserInput,
    model?: string,
    options?: AgenticOptions,
  ): Promise<ProviderReply> {
    const resolved = model ?? this.defaultModel;
    const { system, messages } = this.prepare(history, userInput);
    const tools = mapTools(options?.tools);
    const mcpServers = mapMcpServers(options?.mcpServers);

    // Conditional dispatch: GA endpoint when no MCP servers (the proven
    // path); Beta endpoint with mcp-client beta header when we need MCP.
    // Same params shape between the two for everything else we use.
    const baseParams = {
      model: resolved,
      max_tokens: 4096,
      system,
      messages,
      ...(tools ? { tools } : {}),
    };
    const r = mcpServers
      ? await this.client.beta.messages.create({
          ...baseParams,
          mcp_servers: mcpServers,
          betas: [MCP_BETA],
        } as never)
      : await this.client.messages.create(baseParams);

    // GA `Message.content` and Beta `BetaMessage.content` differ as types
    // (Beta adds thinking blocks etc) but their text-block shape is the
    // same. Cast through ContentBlock[] for unified handling.
    const content = r.content as Anthropic.ContentBlock[];
    const text = content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const citations = extractCitations(content);

    return {
      text,
      model: resolved,
      usage: {
        input: r.usage.input_tokens,
        output: r.usage.output_tokens,
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
    const { system, messages } = this.prepare(history, userInput);
    const tools = mapTools(options?.tools);
    const mcpServers = mapMcpServers(options?.mcpServers);

    const baseParams = {
      model: resolved,
      max_tokens: 4096,
      system,
      messages,
      ...(tools ? { tools } : {}),
    };
    // Same conditional dispatch as send() — beta endpoint only when MCP is
    // active so we keep the prod-validated GA path untouched for the common
    // case (web_search-only).
    const stream = mcpServers
      ? this.client.beta.messages.stream({
          ...baseParams,
          mcp_servers: mcpServers,
          betas: [MCP_BETA],
        } as never)
      : this.client.messages.stream(baseParams);

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { kind: 'text', delta: event.delta.text };
      }
      // Phase 1.6 (deferred): yield tool_use_start when content_block_start
      // arrives with type='server_tool_use' name='web_search', and
      // tool_use_end on the matching content_block_stop. Skipped for now —
      // the streaming UI doesn't yet handle inline-edit cleanup of the
      // 🔍 status line.
    }
    const final = await stream.finalMessage();
    const citations = extractCitations(final.content as Anthropic.ContentBlock[]);
    return {
      model: resolved,
      usage: { input: final.usage.input_tokens, output: final.usage.output_tokens },
      ...(citations.length ? { citations } : {}),
    };
  }
}
