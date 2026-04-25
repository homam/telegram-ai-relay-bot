import type { ProviderId } from '../sessions/types.js';
import type { SessionsRepo } from '../sessions/types.js';

/**
 * Approximate input/output prices in USD per 1 million tokens.
 * These are guardrails, NOT billing — they may drift from actual list prices.
 * Update as needed; if a model isn't found we fall back to FALLBACK_PRICE.
 */
const PRICES: Record<ProviderId, Record<string, { input: number; output: number }>> = {
  openai: {
    // GPT-5.4 family (defaults; verified April 2026)
    'gpt-5.4': { input: 2.5, output: 15 },
    'gpt-5.4-mini': { input: 0.75, output: 4.5 },
    'gpt-5.4-nano': { input: 0.2, output: 1.25 },
    'gpt-5.4-pro': { input: 30, output: 180 },
    // Older
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4o': { input: 2.5, output: 10 },
    'o1-mini': { input: 1.1, output: 4.4 },
    'o1': { input: 15, output: 60 },
  },
  anthropic: {
    'claude-haiku-4-5': { input: 1, output: 5 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-opus-4-7': { input: 15, output: 75 },
  },
  gemini: {
    'gemini-2.0-flash': { input: 0.1, output: 0.4 },
    'gemini-1.5-pro': { input: 1.25, output: 5 },
  },
};

const FALLBACK_PRICE = { input: 5, output: 15 };

export function estimateUsd(
  provider: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICES[provider]?.[model] ?? FALLBACK_PRICE;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export function todayDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export interface BudgetCheckResult {
  allowed: boolean;
  usedUsd: number;
  capUsd: number;
}

export async function checkBudget(
  repo: SessionsRepo,
  userId: number,
  capUsd: number,
): Promise<BudgetCheckResult> {
  const today = todayDateString();
  const b = await repo.getBudget(userId, today);
  const used = b?.usdEstimate ?? 0;
  return { allowed: used < capUsd, usedUsd: used, capUsd };
}

export async function recordSpend(
  repo: SessionsRepo,
  userId: number,
  provider: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<{ usd: number; totalUsdToday: number }> {
  const usd = estimateUsd(provider, model, inputTokens, outputTokens);
  const today = todayDateString();
  const updated = await repo.addBudget(userId, today, inputTokens, outputTokens, usd);
  return { usd, totalUsdToday: updated.usdEstimate };
}

/** Whisper-1 pricing (USD per minute of audio). */
const WHISPER_PER_MINUTE_USD = 0.006;

/** gpt-4o-mini-tts pricing (USD per million input characters). */
const TTS_PER_MILLION_CHARS_USD = 15;

/**
 * Records audio-by-duration spend (e.g. Whisper transcription). Folded into
 * the same daily USD counter; tokensIn/Out left at 0 since audio isn't
 * token-priced.
 */
export async function recordAudioSpend(
  repo: SessionsRepo,
  userId: number,
  durationSec: number,
): Promise<{ usd: number; totalUsdToday: number }> {
  const usd = (durationSec / 60) * WHISPER_PER_MINUTE_USD;
  const today = todayDateString();
  const updated = await repo.addBudget(userId, today, 0, 0, usd);
  return { usd, totalUsdToday: updated.usdEstimate };
}

/** Records TTS spend (cost-per-character). Folded into the same daily counter. */
export async function recordTtsSpend(
  repo: SessionsRepo,
  userId: number,
  characters: number,
): Promise<{ usd: number; totalUsdToday: number }> {
  const usd = (characters / 1_000_000) * TTS_PER_MILLION_CHARS_USD;
  const today = todayDateString();
  const updated = await repo.addBudget(userId, today, 0, 0, usd);
  return { usd, totalUsdToday: updated.usdEstimate };
}
