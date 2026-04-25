#!/usr/bin/env bash
# Push secrets from .env.local to AWS SSM Parameter Store.
# Usage: bash scripts/push-secrets.sh [region]
# Reads env values without echoing them.

set -eu

REGION="${1:-${AWS_REGION:-eu-central-1}}"
PREFIX="/tg-ai-relay-bot"
ENV_FILE=".env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found. Run from project root." >&2
  exit 1
fi

# Read keys from .env.local without printing values.
# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

put() {
  local name="$1" value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "  · skip $name (empty in .env.local)"
    return
  fi
  aws ssm put-parameter \
    --region "$REGION" \
    --name "$PREFIX/$name" \
    --type SecureString \
    --value "$value" \
    --overwrite \
    --no-cli-pager \
    --output text > /dev/null
  echo "  ✓ $PREFIX/$name"
}

echo "Pushing to region $REGION under $PREFIX/ …"

put telegram-bot-token "${TELEGRAM_BOT_TOKEN:-}"

# Webhook secret: reuse from env if set, else generate.
WEBHOOK_SECRET="${TELEGRAM_WEBHOOK_SECRET:-}"
if [[ -z "$WEBHOOK_SECRET" || "$WEBHOOK_SECRET" == "local-dev-not-used" ]]; then
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
  echo "  · generated random telegram-webhook-secret"
fi
put telegram-webhook-secret "$WEBHOOK_SECRET"

put openai-api-key    "${OPENAI_API_KEY:-}"
put anthropic-api-key "${ANTHROPIC_API_KEY:-}"
put gemini-api-key    "${GEMINI_API_KEY:-}"

echo "Done."
