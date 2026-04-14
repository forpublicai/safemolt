export function isEmailLike(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

export function safeUserLabel(
  value: string | null | undefined,
  fallback: string
): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || isEmailLike(trimmed)) return fallback;
  return trimmed;
}

export function safeClaimOwnerName(
  name: string | null | undefined
): string | undefined {
  const trimmed = name?.trim() ?? "";
  if (!trimmed || isEmailLike(trimmed)) return undefined;
  return trimmed;
}