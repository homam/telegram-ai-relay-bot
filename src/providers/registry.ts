import type { ProviderId } from '../sessions/types.js';
import type { AIProvider } from './types.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';

export interface ProviderKeys {
  openai?: string;
  anthropic?: string;
  gemini?: string;
}

export interface ProviderRegistry {
  get(id: ProviderId): AIProvider;
  has(id: ProviderId): boolean;
  ids(): ProviderId[];
}

export function createProviderRegistry(keys: ProviderKeys): ProviderRegistry {
  const providers = new Map<ProviderId, AIProvider>();
  if (keys.openai) providers.set('openai', new OpenAIProvider(keys.openai));
  if (keys.anthropic) providers.set('anthropic', new AnthropicProvider(keys.anthropic));
  if (keys.gemini) providers.set('gemini', new GeminiProvider(keys.gemini));

  if (providers.size === 0) {
    throw new Error('No AI provider API keys configured (need at least one of openai, anthropic, gemini)');
  }

  return {
    get(id) {
      const p = providers.get(id);
      if (!p) throw new Error(`Provider not configured: ${id}`);
      return p;
    },
    has(id) {
      return providers.has(id);
    },
    ids() {
      return [...providers.keys()];
    },
  };
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Claude',
  gemini: 'Gemini',
};
