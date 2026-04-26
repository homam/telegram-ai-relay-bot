import { describe, it, expect } from 'vitest';
import { InMemorySessionsRepo } from '../src/sessions/memory-repo.js';
import { chatMessageText, type ChatMessage, type Session } from '../src/sessions/types.js';
import {
  estimateUsd,
  todayDateString,
  checkBudget,
  recordSpend,
} from '../src/auth/budget.js';
import { isAllowed, parseAllowedUserIds } from '../src/auth/allowlist.js';

function mkSession(over: Partial<Session> = {}): Session {
  return {
    userId: 1,
    sessionId: 'sess-1',
    provider: 'openai',
    model: 'gpt-4o-mini',
    title: 't',
    createdAt: 1,
    lastUsedAt: 1,
    messages: [],
    tokensIn: 0,
    tokensOut: 0,
    ...over,
  };
}

describe('InMemorySessionsRepo', () => {
  it('round-trips state', async () => {
    const repo = new InMemorySessionsRepo();
    expect(await repo.getState(1)).toBeNull();
    await repo.putState({
      userId: 1,
      activeProvider: 'anthropic',
      activeSessionByProvider: { anthropic: 's-a' },
      modelByProvider: { anthropic: 'claude-sonnet-4-6' },
      updatedAt: 100,
    });
    const s = await repo.getState(1);
    expect(s?.activeProvider).toBe('anthropic');
    expect(s?.activeSessionByProvider.anthropic).toBe('s-a');
    expect(s?.modelByProvider.anthropic).toBe('claude-sonnet-4-6');
  });

  it('lists sessions filtered by provider, sorted by lastUsedAt desc', async () => {
    const repo = new InMemorySessionsRepo();
    await repo.createSession(mkSession({ sessionId: 'a', provider: 'openai', lastUsedAt: 1 }));
    await repo.createSession(mkSession({ sessionId: 'b', provider: 'openai', lastUsedAt: 5 }));
    await repo.createSession(mkSession({ sessionId: 'c', provider: 'anthropic', lastUsedAt: 10 }));
    const list = await repo.listSessions(1, 'openai', 10);
    expect(list.map((s) => s.sessionId)).toEqual(['b', 'a']);
  });

  it('round-trips a session with ContentBlock[] message content', async () => {
    const repo = new InMemorySessionsRepo();
    const blocks: ChatMessage[] = [
      { role: 'user', content: 'hello', ts: 1 }, // legacy string content
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will search.' },
          { type: 'tool_use', id: 'tu_1', name: 'web_search', input: { query: 'today' } },
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'results...' },
          { type: 'text', text: 'Here is the answer.' },
        ],
        ts: 2,
      },
    ];
    await repo.createSession(mkSession({ messages: blocks }));
    const got = await repo.getSession(1, 'sess-1');
    expect(got?.messages).toHaveLength(2);
    // Legacy string content survives unchanged.
    expect(got?.messages[0]!.content).toBe('hello');
    // Block content survives as the same array (deep-equal, post-clone).
    expect(got?.messages[1]!.content).toEqual(blocks[1]!.content);
    // chatMessageText helper extracts plain text across both shapes.
    expect(chatMessageText(got!.messages[0]!)).toBe('hello');
    expect(chatMessageText(got!.messages[1]!)).toBe('I will search.results...Here is the answer.');
  });

  it('atomically accumulates budget', async () => {
    const repo = new InMemorySessionsRepo();
    const date = todayDateString();
    await repo.addBudget(1, date, 10, 5, 0.001);
    const after = await repo.addBudget(1, date, 20, 7, 0.002);
    expect(after.tokensIn).toBe(30);
    expect(after.tokensOut).toBe(12);
    expect(after.usdEstimate).toBeCloseTo(0.003, 6);
  });
});

describe('InMemorySessionsRepo MCP servers', () => {
  it('round-trips a server, then deletes it', async () => {
    const repo = new InMemorySessionsRepo();
    expect(await repo.listMcpServers(1)).toEqual([]);
    await repo.putMcpServer({
      userId: 1,
      name: 'github',
      url: 'https://mcp.github.com',
      authToken: 'tok',
      enabled: true,
      addedAt: 100,
    });
    const got = await repo.getMcpServer(1, 'github');
    expect(got?.url).toBe('https://mcp.github.com');
    expect(got?.authToken).toBe('tok');
    expect(got?.enabled).toBe(true);
    await repo.deleteMcpServer(1, 'github');
    expect(await repo.getMcpServer(1, 'github')).toBeNull();
  });

  it('lists by user, sorted by addedAt asc, isolated per-user', async () => {
    const repo = new InMemorySessionsRepo();
    await repo.putMcpServer({ userId: 1, name: 'b', url: 'u-b', enabled: true, addedAt: 5 });
    await repo.putMcpServer({ userId: 1, name: 'a', url: 'u-a', enabled: false, addedAt: 1 });
    await repo.putMcpServer({ userId: 2, name: 'a', url: 'u-other', enabled: true, addedAt: 3 });
    const u1 = await repo.listMcpServers(1);
    expect(u1.map((r) => r.name)).toEqual(['a', 'b']);
    const u2 = await repo.listMcpServers(2);
    expect(u2.map((r) => r.url)).toEqual(['u-other']);
  });

  it('toggles enabled state via putMcpServer overwrite', async () => {
    const repo = new InMemorySessionsRepo();
    await repo.putMcpServer({ userId: 1, name: 'x', url: 'u', enabled: true, addedAt: 1 });
    const cur = await repo.getMcpServer(1, 'x');
    await repo.putMcpServer({ ...cur!, enabled: false });
    expect((await repo.getMcpServer(1, 'x'))?.enabled).toBe(false);
  });
});

describe('budget pricing', () => {
  it('estimates known model price', () => {
    // gpt-4o-mini: $0.15 / $0.60 per Mtok
    const usd = estimateUsd('openai', 'gpt-4o-mini', 1_000_000, 1_000_000);
    expect(usd).toBeCloseTo(0.15 + 0.6, 6);
  });

  it('falls back for unknown model', () => {
    const usd = estimateUsd('openai', 'unknown-model', 1_000_000, 0);
    expect(usd).toBeGreaterThan(0);
  });

  it('checks and refuses past cap', async () => {
    const repo = new InMemorySessionsRepo();
    let r = await checkBudget(repo, 1, 0.01);
    expect(r.allowed).toBe(true);
    await recordSpend(repo, 1, 'openai', 'gpt-4o-mini', 1_000_000, 1_000_000); // ~$0.75
    r = await checkBudget(repo, 1, 0.01);
    expect(r.allowed).toBe(false);
  });
});

describe('allowlist', () => {
  it('parses csv', () => {
    const set = parseAllowedUserIds(' 12, 34 , 56 ');
    expect([...set]).toEqual([12, 34, 56]);
  });

  it('rejects unknown / empty', () => {
    const set = parseAllowedUserIds('1,2');
    expect(isAllowed(set, 1)).toBe(true);
    expect(isAllowed(set, 99)).toBe(false);
    expect(isAllowed(set, undefined)).toBe(false);
    expect(isAllowed(new Set(), 1)).toBe(false);
  });
});
