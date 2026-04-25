import { InlineKeyboard } from 'grammy';
import type { ProviderId, Session, UserState } from '../sessions/types.js';
import { PROVIDER_LABELS, type ProviderRegistry } from '../providers/registry.js';

/**
 * Two buttons per provider row:
 *   ▸ Provider · current-model        — switches active provider (callback `model:<id>`)
 *   ⚙                                  — opens variant picker     (callback `pickmodel:<id>`)
 */
export function modelKeyboard(
  available: ProviderId[],
  state: UserState | null,
  providers: ProviderRegistry,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const id of available) {
    const impl = providers.get(id);
    const current = state?.modelByProvider[id] ?? impl.defaultModel;
    const variant = impl.selectableModels.find((m) => m.id === current);
    const label = `${PROVIDER_LABELS[id]} · ${variant?.label ?? current}`;
    kb.text(label, `model:${id}`).text('⚙', `pickmodel:${id}`).row();
  }
  return kb;
}

/** Variant picker for one provider — checkmark on the current selection. */
export function variantKeyboard(
  provider: ProviderId,
  current: string,
  variants: ReadonlyArray<{ id: string; label: string }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const v of variants) {
    const mark = v.id === current ? '✓ ' : '   ';
    kb.text(`${mark}${v.label}`, `variant:${provider}:${v.id}`).row();
  }
  return kb;
}

export function sessionsKeyboard(sessions: Session[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of sessions) {
    const date = new Date(s.lastUsedAt).toISOString().slice(0, 10);
    const label = `${truncate(s.title, 32)} · ${date}`;
    kb.text(label, `resume:${s.sessionId}`).row();
  }
  return kb;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
