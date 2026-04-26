import type {
  DailyBudget,
  McpServerRecord,
  ProviderId,
  Session,
  SessionsRepo,
  UserState,
} from './types.js';

export class InMemorySessionsRepo implements SessionsRepo {
  private state = new Map<number, UserState>();
  private sessions = new Map<string, Session>();
  private budgets = new Map<string, DailyBudget>();
  private cancelFlags = new Map<number, number>(); // userId → expiresAt (ms)
  private mcpServers = new Map<string, McpServerRecord>(); // `${userId}#${name}` → record

  private sessionKey(userId: number, sessionId: string) {
    return `${userId}#${sessionId}`;
  }
  private budgetKey(userId: number, date: string) {
    return `${userId}#${date}`;
  }

  async getState(userId: number) {
    return this.state.get(userId) ?? null;
  }
  async putState(s: UserState) {
    this.state.set(s.userId, { ...s });
  }

  async createSession(s: Session) {
    this.sessions.set(this.sessionKey(s.userId, s.sessionId), { ...s, messages: [...s.messages] });
  }
  async getSession(userId: number, sessionId: string) {
    const v = this.sessions.get(this.sessionKey(userId, sessionId));
    return v ? { ...v, messages: [...v.messages] } : null;
  }
  async updateSession(s: Session) {
    this.sessions.set(this.sessionKey(s.userId, s.sessionId), { ...s, messages: [...s.messages] });
  }
  async deleteSession(userId: number, sessionId: string) {
    this.sessions.delete(this.sessionKey(userId, sessionId));
  }
  async listSessions(userId: number, provider: ProviderId, limit: number) {
    const out: Session[] = [];
    for (const s of this.sessions.values()) {
      if (s.userId === userId && s.provider === provider) out.push({ ...s, messages: [...s.messages] });
    }
    out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return out.slice(0, limit);
  }

  async getBudget(userId: number, date: string) {
    return this.budgets.get(this.budgetKey(userId, date)) ?? null;
  }
  async addBudget(userId: number, date: string, tokensIn: number, tokensOut: number, usd: number) {
    const key = this.budgetKey(userId, date);
    const prev = this.budgets.get(key) ?? {
      userId,
      date,
      tokensIn: 0,
      tokensOut: 0,
      usdEstimate: 0,
    };
    const next: DailyBudget = {
      userId,
      date,
      tokensIn: prev.tokensIn + tokensIn,
      tokensOut: prev.tokensOut + tokensOut,
      usdEstimate: prev.usdEstimate + usd,
    };
    this.budgets.set(key, next);
    return next;
  }

  async setCancelFlag(userId: number, ttlSec = 60): Promise<void> {
    this.cancelFlags.set(userId, Date.now() + ttlSec * 1000);
  }
  async getCancelFlag(userId: number): Promise<boolean> {
    const exp = this.cancelFlags.get(userId);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.cancelFlags.delete(userId);
      return false;
    }
    return true;
  }
  async clearCancelFlag(userId: number): Promise<void> {
    this.cancelFlags.delete(userId);
  }

  private mcpKey(userId: number, name: string) {
    return `${userId}#${name}`;
  }
  async listMcpServers(userId: number): Promise<McpServerRecord[]> {
    const out: McpServerRecord[] = [];
    for (const r of this.mcpServers.values()) {
      if (r.userId === userId) out.push({ ...r });
    }
    out.sort((a, b) => a.addedAt - b.addedAt);
    return out;
  }
  async getMcpServer(userId: number, name: string): Promise<McpServerRecord | null> {
    const v = this.mcpServers.get(this.mcpKey(userId, name));
    return v ? { ...v } : null;
  }
  async putMcpServer(record: McpServerRecord): Promise<void> {
    this.mcpServers.set(this.mcpKey(record.userId, record.name), { ...record });
  }
  async deleteMcpServer(userId: number, name: string): Promise<void> {
    this.mcpServers.delete(this.mcpKey(userId, name));
  }
}
