import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

/**
 * Usage: npm run set-webhook -- https://<api-id>.execute-api.<region>.amazonaws.com/webhook
 *
 * Reads telegram-bot-token + telegram-webhook-secret from SSM at /tg-ai-relay-bot,
 * then calls Telegram's setWebhook. The secret is sent in the
 * `secret_token` field so Telegram includes it as a header on every webhook call.
 */

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: npm run set-webhook -- <webhook-url>');
    process.exit(1);
  }
  const prefix = process.env.SSM_PREFIX ?? '/tg-ai-relay-bot';
  const region = process.env.AWS_REGION ?? 'eu-west-1';

  const ssm = new SSMClient({ region });
  const r = await ssm.send(
    new GetParametersByPathCommand({
      Path: prefix,
      Recursive: false,
      WithDecryption: true,
    }),
  );
  const params = new Map((r.Parameters ?? []).map((p) => [p.Name?.slice(prefix.length + 1), p.Value]));
  const token = params.get('telegram-bot-token');
  const secret = params.get('telegram-webhook-secret');
  if (!token) throw new Error(`Missing SSM param ${prefix}/telegram-bot-token`);
  if (!secret) throw new Error(`Missing SSM param ${prefix}/telegram-webhook-secret`);

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url,
      secret_token: secret,
      drop_pending_updates: true,
      allowed_updates: ['message', 'callback_query'],
    }),
  });
  const json = (await res.json()) as { ok: boolean; description?: string };
  console.log(json);
  if (!json.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
