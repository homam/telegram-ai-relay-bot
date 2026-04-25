export type ProviderId = 'openai' | 'anthropic' | 'gemini';

export type Role = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  role: Role;
  content: string;
  ts: number;
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
}
