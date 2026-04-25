export function parseAllowedUserIds(raw: string | undefined): Set<number> {
  if (!raw) return new Set();
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  return new Set(ids);
}

export function isAllowed(allowed: Set<number>, userId: number | undefined): boolean {
  if (!userId) return false;
  if (allowed.size === 0) return false;
  return allowed.has(userId);
}
