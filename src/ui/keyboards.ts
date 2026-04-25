import { InlineKeyboard } from 'grammy';
import type { ProviderId, Session } from '../sessions/types.js';
import { PROVIDER_LABELS } from '../providers/registry.js';

export function modelKeyboard(available: ProviderId[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const id of available) {
    kb.text(PROVIDER_LABELS[id], `model:${id}`);
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
