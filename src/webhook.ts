import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { loadConfig } from './config.js';

let lambdaClient: LambdaClient | null = null;
let cachedSecret: string | null = null;

async function getSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const cfg = await loadConfig();
  cachedSecret = cfg.telegramWebhookSecret;
  return cachedSecret;
}

function getLambda() {
  if (!lambdaClient) lambdaClient = new LambdaClient({});
  return lambdaClient;
}

/**
 * Webhook entry point.
 * - Verifies Telegram's secret token header.
 * - Async-invokes the Worker Lambda with the raw update.
 * - Returns 200 to Telegram in <1s so Telegram never retries on slow AI calls.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  if (event.requestContext.http.method !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const provided =
    event.headers['x-telegram-bot-api-secret-token'] ??
    event.headers['X-Telegram-Bot-Api-Secret-Token'];
  const expected = await getSecret();
  if (provided !== expected) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  if (!event.body) return { statusCode: 400, body: 'Empty body' };
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  let update: unknown;
  try {
    update = JSON.parse(raw);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const workerFn = process.env.WORKER_FUNCTION_NAME;
  if (!workerFn) {
    console.error('WORKER_FUNCTION_NAME env var not set');
    return { statusCode: 500, body: 'Server misconfigured' };
  }

  try {
    await getLambda().send(
      new InvokeCommand({
        FunctionName: workerFn,
        InvocationType: 'Event', // fire-and-forget
        Payload: Buffer.from(JSON.stringify({ update })),
      }),
    );
  } catch (err) {
    console.error('failed to invoke worker', err);
    // Telegram will redeliver — return 5xx so it knows to retry.
    return { statusCode: 503, body: 'Worker dispatch failed' };
  }

  return { statusCode: 200, body: 'ok' };
};
