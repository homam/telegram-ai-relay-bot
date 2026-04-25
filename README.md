# telegram-ai-relay-bot

Personal Telegram bot that relays your messages to OpenAI, Anthropic Claude, or
Google Gemini — with native streaming, per-provider conversation history, and
a daily spend cap. Runs entirely on AWS Lambda.

## Features

- **Native streaming** — responses appear ChatGPT-style as the LLM types,
  using Telegram's `sendMessageDraft` (Bot API 9.5+).
- **Three providers, one bot** — `/model` switches between OpenAI, Claude,
  and Gemini on the fly. The ⚙ button on each provider opens a variant
  picker (e.g. GPT-5.4 / 5.4-mini / 5.4-nano / 5.4-pro).
- **Photo input** — send any photo (or a JPEG/PNG attached as a document)
  and the active model analyzes it. Use the caption to ask a specific
  question.
- **Voice input** — voice notes and audio files are transcribed with
  OpenAI Whisper, the transcription is echoed back so you can verify, then
  passed to the active chat model.
- **Voice output** — `/say` reads the latest reply aloud as a Telegram
  voice note (OpenAI TTS, default voice "alloy"). Reply to any message
  with `/say` to hear that specific one.
- **`/cancel`** — interrupt a long streaming response mid-flight and keep
  what was already generated.
- **Per-provider sessions** — `/sessions` lists your past conversations for
  the active model and lets you resume any of them.
- **Markdown rendering** — headings, bold, lists, fenced code blocks all
  render properly; conversion handled automatically.
- **Allowlist + daily USD cap** — only configured Telegram user IDs can
  use the bot, and each user has a per-day spend limit (chat tokens +
  Whisper minutes counted in the same budget).

## Architecture

```
Telegram ──▶ API Gateway ──▶ WebhookFn ──async invoke──▶ WorkerFn
                              (256 MB, fast ACK)         (1024 MB, 5 min)
                                                          ├─ DynamoDB (sessions, budget)
                                                          ├─ SSM Parameter Store (secrets)
                                                          └─ OpenAI / Claude / Gemini
```

**Why two Lambdas:** the webhook returns 200 to Telegram in under 100 ms so
Telegram never times out and never retries. The worker handles the slow LLM
call and the streaming UX. See [CLAUDE.md](CLAUDE.md) for details.

## Stack

- TypeScript on Node.js 22
- [grammY](https://grammy.dev) Telegram bot framework
- [@grammyjs/stream](https://grammy.dev/plugins/stream) for native draft streaming
- [@grammyjs/auto-retry](https://grammy.dev/plugins/auto-retry) for rate-limit handling
- [telegramify-markdown](https://www.npmjs.com/package/telegramify-markdown) for MarkdownV2 conversion
- AWS CDK v2 (TypeScript) for all infrastructure
- DynamoDB on-demand, API Gateway HTTP API, Lambda Node 22

## Quick start (local)

```sh
git clone <repo>
cd telegram-ai-relay-bot
npm install

cp .env.example .env.local
# Fill in:
#   TELEGRAM_BOT_TOKEN      — from @BotFather (/newbot)
#   ALLOWED_USER_IDS        — comma-separated Telegram numeric IDs
#   OPENAI_API_KEY (and/or ANTHROPIC_API_KEY / GEMINI_API_KEY)

npm run dev
```

`npm run dev` runs the bot in long-polling mode against real Telegram with
in-memory storage — no AWS needed. Useful for fast iteration.

> ⚠ Running `npm run dev` will **delete the production webhook** (long
> polling and webhooks are mutually exclusive). After local dev, restore
> the production webhook with `npm run set-webhook -- <url>`.

## Tests

```sh
npm test
```

Vitest unit tests for the in-memory session repo, budget cap, and allowlist
parsing.

## Deploying to AWS

### 1. One-time AWS setup

Bootstrap CDK in your target region (only needed once per account/region):

```sh
cd infra
npm install
npx cdk bootstrap aws://<account-id>/<region>
```

### 2. Upload secrets to SSM

Don't put secrets in `cdk.json` or pass them through the deploy command —
they belong in [SSM Parameter Store](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html) as `SecureString`. The provided
script reads `.env.local` and uploads each value:

```sh
bash scripts/push-secrets.sh        # uploads to /tg-ai-relay-bot/* in eu-central-1
```

It pushes:
- `telegram-bot-token`
- `telegram-webhook-secret` (auto-generated if not in `.env.local`)
- `openai-api-key`, `anthropic-api-key`, `gemini-api-key`

### 3. Deploy the stack

```sh
cd infra
npx cdk deploy -c allowedUserIds=<csv-of-tg-user-ids> --require-approval never
```

CDK will print the webhook URL on completion.

### 4. Register the webhook with Telegram

```sh
npm run set-webhook -- <WebhookUrl from stack output>
```

The script reads the bot token + webhook secret from SSM and POSTs to
Telegram's `setWebhook`, including `drop_pending_updates: true` to flush any
stale queue.

## Bot commands

| Command | Behavior |
|---|---|
| `/start`, `/help` | Show help text |
| `/model` | Pick a provider; tap ⚙ to choose the model variant within it |
| `/new` | Start a fresh session in the current model |
| `/sessions` | List + resume previous sessions for the current model |
| `/rename <title>` | Rename the active session |
| `/forget` | Delete the active session |
| `/cancel` | Stop the response currently streaming (keeps what was generated) |
| `/say` | Read the latest reply aloud as a voice note. Reply to any message with `/say` to hear that one |
| `/usage` | Today's tokens + estimated USD spend vs. cap |
| any text | Send to the active session — relayed to the AI |
| a photo or image document | Active model analyzes the image (caption is the prompt; falls back to "describe it" if absent) |
| a voice note or audio file | Whisper transcribes it; the text is sent to the active model |

## Configuration

| Variable / Context | Where set | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | SSM (`/tg-ai-relay-bot/telegram-bot-token`) | — |
| `TELEGRAM_WEBHOOK_SECRET` | SSM | random hex |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | SSM | — (at least one required) |
| `ALLOWED_USER_IDS` | CDK context: `-c allowedUserIds=...` | (empty — bot rejects everyone) |
| `DAILY_USD_CAP_PER_USER` | CDK context: `-c dailyUsdCap=2.50` | `$2.00` |
| Default model per provider | [src/providers/*.ts](src/providers) | `gpt-5.4`, `claude-haiku-4-5`, `gemini-2.0-flash` |

## Repository layout

```
src/
├── webhook.ts          # Lambda 1: fast ACK + async invoke worker
├── worker.ts           # Lambda 2: streaming AI + Telegram replies
├── bot.ts              # grammY commands and the streaming text handler
├── config.ts           # env + SSM loader (cached per cold start)
├── providers/          # OpenAI / Anthropic / Gemini, each with send + streamSend
├── sessions/           # DynamoDB + in-memory repos behind one interface
├── auth/               # allowlist + per-day USD budget cap
└── ui/keyboards.ts     # /model and /sessions inline keyboards
infra/lib/stack.ts      # CDK: 2 Lambdas, HTTP API, DynamoDB, IAM
scripts/
├── local-dev.ts        # long-polling for fast iteration
├── set-webhook.ts      # POST setWebhook to Telegram
└── push-secrets.sh     # upload .env.local → SSM
tests/sessions.test.ts  # vitest unit tests
```

## Cost

At one-user volume on `gpt-5.4`:

- **AWS**: pennies/month — DynamoDB on-demand + Lambda free tier + HTTP API.
- **AI providers**: bounded by `DAILY_USD_CAP_PER_USER` (default $2/user/day).

## Troubleshooting

**Bot replies silent / Telegram says webhook errored?**

```sh
# Check webhook state
node --input-type=module -e "import('@aws-sdk/client-ssm').then(async ({SSMClient,GetParameterCommand})=>{const s=new SSMClient({region:'eu-central-1'});const r=await s.send(new GetParameterCommand({Name:'/tg-ai-relay-bot/telegram-bot-token',WithDecryption:true}));const w=await fetch('https://api.telegram.org/bot'+r.Parameter.Value+'/getWebhookInfo');console.log(JSON.stringify(await w.json(),null,2))})"
```

If `url` is empty: someone ran `npm run dev` recently and didn't restore the
webhook. Run `npm run set-webhook -- <url>` to fix.

If `pending_update_count` is large with `last_error_message` set: the worker
is failing or slow. Tail logs:

```sh
aws logs tail /aws/lambda/$(aws lambda list-functions --region eu-central-1 --query "Functions[?contains(FunctionName,'WorkerFn')].FunctionName" --output text) --region eu-central-1 --since 5m
```

Then re-run `npm run set-webhook -- <url>` to flush the queue (the script
passes `drop_pending_updates: true`).

## License

MIT (or whatever the owner picks).
