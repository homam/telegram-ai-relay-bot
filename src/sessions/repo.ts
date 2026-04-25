import type { SessionsRepo } from './types.js';
import { InMemorySessionsRepo } from './memory-repo.js';
import { DynamoSessionsRepo } from './dynamo-repo.js';

export function createSessionsRepo(opts: {
  backend: 'memory' | 'dynamodb';
  tableName?: string;
  region?: string;
}): SessionsRepo {
  if (opts.backend === 'memory') return new InMemorySessionsRepo();
  if (!opts.tableName) throw new Error('TABLE_NAME required for dynamodb backend');
  return new DynamoSessionsRepo({ tableName: opts.tableName, region: opts.region });
}

export type { SessionsRepo } from './types.js';
