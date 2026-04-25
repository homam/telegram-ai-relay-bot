# CLAUDE.md

Notes for future Claude sessions working on this repo. Don't restate what's
visible in the code — focus on the non-obvious: deploy environment, sharp
edges that already cost a deploy cycle, and conventions.

## What this is

Single-tenant Telegram AI relay bot. Lets the owner (and a small allowlist) chat
with OpenAI / Claude / Gemini from inside Telegram, with per-provider session
history and a daily USD spend cap. Runs entirely on AWS Lambda. The bot itself
is **@pam_ai_relay_bot**.

## Live deployment

Don't re-derive these. Verify with `aws cloudformation describe-stacks --stack-name TgAiRelayBotStack --region eu-central-1` if something feels off.

| | |
|---|---|
| AWS account | `178269041738` |
| Region | `eu-central-1` |
| CDK stack | `TgAiRelayBotStack` |
| DynamoDB table | `tg-ai-relay-bot` |
| SSM prefix | `/tg-ai-relay-bot/` |
| Webhook URL | `https://ctlnzowkrh.execute-api.eu-central-1.amazonaws.com/webhook` |

Allowlist is passed at deploy time via CDK context: `-c allowedUserIds=1652769327,97557194` (the `1652769327` is the owner's Telegram ID).

## Architecture (the non-obvious bits)

```
Telegram → API Gateway → WebhookFn ──async invoke──▶ WorkerFn
                            (256MB)                  (1024MB, 5min, Node 22)
                            returns 200              streams via @grammyjs/stream
                            in <100ms                edits final msg with MarkdownV2
```

**Why two Lambdas?** Telegram retries on any 5xx. With a single Lambda, a slow LLM call (>30s) would time out → API Gateway 5xx → Telegram redelivers the same update → another LLM call → spend storm + queue clog. The `WebhookFn` ACKs Telegram immediately, then async-invokes `WorkerFn` (`InvocationType: 'Event'`). Worker can take up to 5 minutes; Telegram never knows.

**Streaming:** Uses Telegram Bot API 9.5's native `sendMessageDraft` (March 2026) via `@grammyjs/stream`. User sees the response animate ChatGPT-style. After stream completes, the worker edits the committed message with `parse_mode: 'MarkdownV2'` (converted via `telegramify-markdown`) so headings/bold/lists/code blocks actually render. The plain-text-during-stream → formatted-on-commit "snap" is the chosen UX trade-off.

**Storage:** DynamoDB single-table, keys documented at [src/sessions/dynamo-repo.ts](src/sessions/dynamo-repo.ts):
- `USER#<id> | STATE` — active provider + active session per provider + `modelByProvider` preferences
- `USER#<id> | SESSION#<provider>#<uuid>` — title, model, full message array, token counters
- `USER#<id> | BUDGET#<YYYY-MM-DD>` — daily token + USD spend (TTL 40 days)
- `USER#<id> | CANCEL` — `/cancel` flag (TTL 60s); set by the cancel command's worker, polled by an in-flight streaming worker

**Multimodal:**
- **Photos / image documents** — `bot.on('message:photo' | 'message:document')` downloads via `getFile`, base64-encodes inline, passes as `UserInput.images[]` to `streamSend`. Each provider builds its own content shape (OpenAI `image_url`, Anthropic `image source.base64`, Gemini `inlineData`). Bytes are NEVER persisted in DDB; history stores `[image] <caption>` so follow-up turns reference the assistant's own description, not the bytes.
- **Voice / audio** — `bot.on('message:voice' | 'message:audio')` always uses OpenAI Whisper (`whisper-1`) regardless of active chat provider. Echoes `🎙️ <transcription>` so user can verify, then relays the text through the same `relayToActiveSession` pipeline. Audio time is billed via [recordAudioSpend](src/auth/budget.ts) at $0.006/min, folded into the same daily USD cap.
- **Voice output (`/say`)** — On-demand TTS via `gpt-4o-mini-tts` (OpenAI). Default voice "alloy". Source text is either the message the user replied to (when `/say` is sent as a reply) or the latest assistant message in the active session. Output is OPUS/OGG → delivered via `replyWithVoice` as a native voice note. Hard-truncates at 4096 chars (OpenAI limit) with an "(audio truncated)" caption. Billed via [recordTtsSpend](src/auth/budget.ts) at $15/Mchars.

**`/cancel`:** Cross-Lambda IPC via DynamoDB. The worker streaming a response and the worker handling `/cancel` are different invocations; they communicate through a `CANCEL` row with TTL 60s. The streaming worker's `relay()` generator polls the flag every 500ms (timestamp-gated). On cancel: throws `CancelError`, the bot's catch persists the partial reply with `[cancelled]` marker and posts a "🛑 _(cancelled)_" footer. If no draft was committed yet, the partial is resent as a real message so the transient draft animation isn't lost.

## Critical pitfalls already discovered

These will reoccur if not preserved. Each cost ≥1 deploy cycle to find.

1. **`bot.init()` hangs forever in Lambda.** Never call it. Pre-fetch `botInfo` with native `fetch` in `worker.ts` and pass to `new Bot(token, { botInfo })`. See [src/worker.ts:46-56](src/worker.ts:46).

2. **grammY's bundled `node-fetch` v2 throws `TypeError: Expected signal to be an instanceof AbortSignal`** under Node 20+. Fix: pass native fetch via `client: { fetch: globalThis.fetch as never }`. See [src/bot.ts:38-41](src/bot.ts:38).

3. **`@grammyjs/stream` requires Node 22**, not Node 20. Symptom: `Promise.withResolvers is not a function`. Lambda runtime must be `NODEJS_22_X` and esbuild target `'node22'`. See [infra/lib/stack.ts](infra/lib/stack.ts).

4. **Plugin order matters: `auto-retry` MUST be installed BEFORE `stream`.** Otherwise streaming crashes on Telegram 429s. See [src/bot.ts:43-44](src/bot.ts:43).

5. **LLM Markdown ≠ Telegram MarkdownV2.** Don't pass `parse_mode` during streaming — partial chunks have unbalanced delimiters and Telegram will 400. The two-phase approach (stream plain → edit final with `telegramify-markdown` conversion) is in [src/bot.ts:223-240](src/bot.ts:223). Multi-message responses (>4096 chars) stay plain text — re-splitting converted MarkdownV2 across messages is fiddly and was punted.

6. **Worker must never throw to the Lambda runtime.** Async invokes retry up to 2x on uncaught errors → duplicate replies (Telegram has already been ACK'd by webhook). The try/catch in [src/worker.ts:70-77](src/worker.ts:70) catches everything and just logs.

7. **grammY's `InputFile` upload (e.g. `replyWithVoice`, `sendDocument` with bytes) hangs indefinitely under Lambda.** Same family of bug as #2 — multipart streaming through grammY's stack times out without erroring. **Always upload binary attachments via native `fetch` + `FormData` + `Blob` direct to Telegram's bot API.** See the `/say` handler in [src/bot.ts](src/bot.ts) for the pattern: build a FormData manually with `fd.set('voice', new Blob([new Uint8Array(buf)], { type: 'audio/ogg' }), 'reply.ogg')`, POST to `https://api.telegram.org/bot${token}/sendVoice`. Same approach works for `sendPhoto`, `sendDocument`, etc.

## Commands

```sh
npm run dev               # long-polling locally; in-memory backend by default
npm test                  # vitest, 8 sessions/budget tests
npm run set-webhook -- <url>   # register API Gateway URL with Telegram (reads SSM)
cd infra && npx cdk deploy -c allowedUserIds=<csv> --require-approval never
bash scripts/push-secrets.sh   # uploads .env.local values to SSM (USER runs this, not me)
```

## Conventions

- **Don't transit secrets through Bash tool calls.** Every command and its stdout is logged in the conversation. For uploading secrets to SSM, write a script the user runs (e.g. `scripts/push-secrets.sh`). For *reading* secrets in scripts (set-webhook etc.), it's fine — only `{ok: true}`-shape responses come back.
- **Don't change the model defaults silently** — they live in [src/providers/openai.ts](src/providers/openai.ts), [src/providers/anthropic.ts](src/providers/anthropic.ts), [src/providers/gemini.ts](src/providers/gemini.ts). Existing sessions persist their model, so changing defaults only affects new sessions (good, intentional).
- **Pricing table in [src/auth/budget.ts](src/auth/budget.ts) is approximate** — guardrail, not billing. If a model isn't listed it falls back to a conservative `$5/$15` per Mtok.
- **Don't put port 3000/3001/4000/5000/5173/8000 in any local dev script** — owner runs many parallel projects on those.

## Local dev nuance

Running `npm run dev` calls `bot.start()` which **automatically `deleteWebhook`s on Telegram** to use long-polling. After local dev, the production webhook is gone — you must `npm run set-webhook -- <url>` to restore it. If the deployed bot suddenly goes silent, suspect this first.

## Verifying it's healthy

```sh
# Webhook + queue
node --input-type=module -e "import('@aws-sdk/client-ssm').then(async ({SSMClient,GetParameterCommand})=>{const s=new SSMClient({region:'eu-central-1'});const r=await s.send(new GetParameterCommand({Name:'/tg-ai-relay-bot/telegram-bot-token',WithDecryption:true}));const w=await fetch('https://api.telegram.org/bot'+r.Parameter.Value+'/getWebhookInfo');console.log(JSON.stringify(await w.json(),null,2))})"

# Recent worker activity
aws logs tail /aws/lambda/$(aws lambda list-functions --region eu-central-1 --query "Functions[?contains(FunctionName,'WorkerFn')].FunctionName" --output text) --region eu-central-1 --since 5m

# DynamoDB sessions
aws dynamodb scan --table-name tg-ai-relay-bot --region eu-central-1 --max-items 5
```

`pending_update_count > 0` for long with `last_error_message` set means the queue clogged; re-run `npm run set-webhook -- <url>` (the script passes `drop_pending_updates: true`).

## What changing the providers' SDKs touches

If upgrading `openai` / `@anthropic-ai/sdk` / `@google/genai`, both the non-streaming `send()` and streaming `streamSend()` need attention — they're separate code paths in [src/providers/](src/providers/). Each takes a `UserInput` (`{ text, images? }`) and builds the vendor-specific content array when images are present. Token-usage extraction differs per provider (OpenAI needs `stream_options: { include_usage: true }` on the streaming call; Anthropic exposes `stream.finalMessage()`; Gemini accumulates usage across chunks).

`OpenAIProvider` also has `transcribe(audio, mimeType, fileName)` (Whisper) and `textToSpeech(text, voice)` (`gpt-4o-mini-tts`) methods — neither is on the `AIProvider` interface (both are OpenAI-specific). The bot calls them directly via `deps.providers.get('openai') as OpenAIProvider` regardless of the active chat provider, and returns a polite refusal if OpenAI isn't configured.
