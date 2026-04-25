# telegram-ai-relay-bot

Telegram bot that relays messages to OpenAI, Anthropic Claude, or Google Gemini.
Hosted on AWS Lambda + API Gateway, with conversation history in DynamoDB.

## Features

- `/model` — switch active provider (OpenAI · Claude · Gemini).
- `/new` — start a fresh conversation in the current provider.
- `/sessions` — list and resume previous conversations for the current provider.
- `/rename`, `/forget`, `/usage`.
- Allowlist of Telegram user IDs + daily USD spend cap per user.

## Local development

```sh
cp .env.example .env.local
# fill in TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, at least one provider API key
npm install
npm run dev          # long-polling mode against real Telegram, in-memory storage
```

## Tests

```sh
npm test
```

## Deployment (AWS)

Secrets are stored in SSM Parameter Store, NOT in CDK source. Create them once:

```sh
PREFIX=/tg-ai-relay-bot
aws ssm put-parameter --name $PREFIX/telegram-bot-token       --type SecureString --value '…'
aws ssm put-parameter --name $PREFIX/telegram-webhook-secret  --type SecureString --value "$(openssl rand -hex 32)"
aws ssm put-parameter --name $PREFIX/openai-api-key           --type SecureString --value '…'
aws ssm put-parameter --name $PREFIX/anthropic-api-key        --type SecureString --value '…'
aws ssm put-parameter --name $PREFIX/gemini-api-key           --type SecureString --value '…'
```

Then deploy:

```sh
cd infra
npm install
npx cdk deploy
```

After the first deploy, register the webhook with Telegram:

```sh
npm run set-webhook -- https://<api-id>.execute-api.<region>.amazonaws.com/webhook
```

## Architecture

```
Telegram → API Gateway (HTTP API) → Lambda (Node 20, grammY)
                                       ├─→ DynamoDB (sessions, state, budget)
                                       ├─→ SSM Parameter Store (tokens & API keys)
                                       └─→ OpenAI / Anthropic / Gemini
```
