import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  DailyBudget,
  ProviderId,
  Session,
  SessionsRepo,
  UserState,
} from './types.js';

const userPk = (userId: number) => `USER#${userId}`;
const stateSk = () => 'STATE';
const sessionSk = (provider: ProviderId, sessionId: string) =>
  `SESSION#${provider}#${sessionId}`;
const sessionPrefix = (provider: ProviderId) => `SESSION#${provider}#`;
const budgetSk = (date: string) => `BUDGET#${date}`;

const BUDGET_TTL_DAYS = 40;

export class DynamoSessionsRepo implements SessionsRepo {
  private doc: DynamoDBDocumentClient;
  private table: string;

  constructor(opts: { tableName: string; region?: string }) {
    const ddb = new DynamoDBClient({ region: opts.region });
    this.doc = DynamoDBDocumentClient.from(ddb, {
      marshallOptions: { removeUndefinedValues: true },
    });
    this.table = opts.tableName;
  }

  async getState(userId: number): Promise<UserState | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: userPk(userId), sk: stateSk() } }),
    );
    if (!r.Item) return null;
    const i = r.Item;
    return {
      userId,
      activeProvider: i.activeProvider as ProviderId,
      activeSessionByProvider: i.activeSessionByProvider ?? {},
      modelByProvider: i.modelByProvider ?? {},
      updatedAt: i.updatedAt as number,
    };
  }

  async putState(s: UserState): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: userPk(s.userId),
          sk: stateSk(),
          activeProvider: s.activeProvider,
          activeSessionByProvider: s.activeSessionByProvider,
          modelByProvider: s.modelByProvider,
          updatedAt: s.updatedAt,
        },
      }),
    );
  }

  async createSession(s: Session): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: this.toItem(s) }),
    );
  }

  async getSession(userId: number, sessionId: string): Promise<Session | null> {
    // We don't know provider from sessionId alone — fall back to query.
    // Cheap path: try each provider in the SK.
    const providers: ProviderId[] = ['openai', 'anthropic', 'gemini'];
    for (const p of providers) {
      const r = await this.doc.send(
        new GetCommand({
          TableName: this.table,
          Key: { pk: userPk(userId), sk: sessionSk(p, sessionId) },
        }),
      );
      if (r.Item) return this.fromItem(r.Item);
    }
    return null;
  }

  async updateSession(s: Session): Promise<void> {
    // Same shape as create — full overwrite is fine since the bot is single-writer per user.
    await this.doc.send(new PutCommand({ TableName: this.table, Item: this.toItem(s) }));
  }

  async deleteSession(userId: number, sessionId: string): Promise<void> {
    const providers: ProviderId[] = ['openai', 'anthropic', 'gemini'];
    for (const p of providers) {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { pk: userPk(userId), sk: sessionSk(p, sessionId) },
        }),
      );
    }
  }

  async listSessions(userId: number, provider: ProviderId, limit: number): Promise<Session[]> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': userPk(userId),
          ':prefix': sessionPrefix(provider),
        },
      }),
    );
    const items = (r.Items ?? []).map((i) => this.fromItem(i));
    items.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return items.slice(0, limit);
  }

  async getBudget(userId: number, date: string): Promise<DailyBudget | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: userPk(userId), sk: budgetSk(date) },
      }),
    );
    if (!r.Item) return null;
    return {
      userId,
      date,
      tokensIn: (r.Item.tokensIn as number) ?? 0,
      tokensOut: (r.Item.tokensOut as number) ?? 0,
      usdEstimate: (r.Item.usdEstimate as number) ?? 0,
    };
  }

  async addBudget(
    userId: number,
    date: string,
    tokensIn: number,
    tokensOut: number,
    usd: number,
  ): Promise<DailyBudget> {
    const ttl = Math.floor(Date.now() / 1000) + BUDGET_TTL_DAYS * 86400;
    const r = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: userPk(userId), sk: budgetSk(date) },
        UpdateExpression:
          'ADD tokensIn :ti, tokensOut :to_, usdEstimate :usd SET expiresAt = if_not_exists(expiresAt, :ttl)',
        ExpressionAttributeValues: {
          ':ti': tokensIn,
          ':to_': tokensOut,
          ':usd': usd,
          ':ttl': ttl,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    const a = r.Attributes ?? {};
    return {
      userId,
      date,
      tokensIn: (a.tokensIn as number) ?? 0,
      tokensOut: (a.tokensOut as number) ?? 0,
      usdEstimate: (a.usdEstimate as number) ?? 0,
    };
  }

  private toItem(s: Session) {
    return {
      pk: userPk(s.userId),
      sk: sessionSk(s.provider, s.sessionId),
      sessionId: s.sessionId,
      provider: s.provider,
      model: s.model,
      title: s.title,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      messages: s.messages,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
    };
  }

  private fromItem(i: Record<string, unknown>): Session {
    return {
      userId: parseInt(String(i.pk).slice('USER#'.length), 10),
      sessionId: i.sessionId as string,
      provider: i.provider as ProviderId,
      model: i.model as string,
      title: (i.title as string) ?? '',
      createdAt: (i.createdAt as number) ?? 0,
      lastUsedAt: (i.lastUsedAt as number) ?? 0,
      messages: (i.messages as Session['messages']) ?? [],
      tokensIn: (i.tokensIn as number) ?? 0,
      tokensOut: (i.tokensOut as number) ?? 0,
    };
  }
}
