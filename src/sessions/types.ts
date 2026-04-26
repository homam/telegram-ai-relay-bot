export type ProviderId = 'openai' | 'anthropic' | 'gemini';

export type Role = 'user' | 'assistant' | 'system';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: Role;
  content: string | ContentBlock[];
  ts: number;
}

/**
 * Extract plain text from a ChatMessage, regardless of whether content is a
 * legacy string or a ContentBlock[]. Tool-use/tool-result blocks are summarized;
 * image blocks are skipped (we never persist image bytes anyway). This is a
 * compatibility shim for code paths that haven't been updated to walk blocks.
 */
export function chatMessageText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  const parts: string[] = [];
  for (const b of m.content) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'tool_result') parts.push(b.content);
    // tool_use and image blocks are intentionally skipped — they have no
    // sensible plain-text projection for legacy callers.
  }
  return parts.join('');
}

export interface Session {
  userId: number;
  sessionId: string;
  provider: ProviderId;
  model: string;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  messages: ChatMessage[];
  tokensIn: number;
  tokensOut: number;
}

export interface UserState {
  userId: number;
  activeProvider: ProviderId;
  activeSessionByProvider: Partial<Record<ProviderId, string>>;
  /** User's preferred model per provider; falls back to provider's defaultModel. */
  modelByProvider: Partial<Record<ProviderId, string>>;
  updatedAt: number;
}

export interface DailyBudget {
  userId: number;
  date: string;
  tokensIn: number;
  tokensOut: number;
  usdEstimate: number;
}

export interface SessionsRepo {
  getState(userId: number): Promise<UserState | null>;
  putState(state: UserState): Promise<void>;

  createSession(s: Session): Promise<void>;
  getSession(userId: number, sessionId: string): Promise<Session | null>;
  updateSession(s: Session): Promise<void>;
  deleteSession(userId: number, sessionId: string): Promise<void>;
  listSessions(userId: number, provider: ProviderId, limit: number): Promise<Session[]>;

  getBudget(userId: number, date: string): Promise<DailyBudget | null>;
  addBudget(
    userId: number,
    date: string,
    tokensIn: number,
    tokensOut: number,
    usd: number,
  ): Promise<DailyBudget>;

  /** Set a per-user cancel flag (auto-expires). Used by /cancel to interrupt streams. */
  setCancelFlag(userId: number, ttlSec?: number): Promise<void>;
  /** Returns true if the cancel flag is currently set. */
  getCancelFlag(userId: number): Promise<boolean>;
  /** Remove the cancel flag explicitly (called after a successful cancel). */
  clearCancelFlag(userId: number): Promise<void>;
}
