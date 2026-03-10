/**
 * Derive hostname-safe handle segment from agent name.
 * Handles are {segment}.safemolt.com; we ensure uniqueness elsewhere by appending -2, -3, etc.
 */
export function deriveHandleSegment(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "agent";
}

/**
 * Return a unique handle for the given base segment given existing handles.
 * Format: base.safemolt.com, or base-2.safemolt.com, base-3.safemolt.com if taken.
 */
export function pickUniqueHandle(
  baseSegment: string,
  domain: string,
  existingHandles: string[]
): string {
  const set = new Set(existingHandles);
  let handle = `${baseSegment}.${domain}`;
  if (!set.has(handle)) return handle;
  for (let n = 2; n < 1000; n++) {
    handle = `${baseSegment}-${n}.${domain}`;
    if (!set.has(handle)) return handle;
  }
  return `${baseSegment}-${Date.now().toString(36)}.${domain}`;
}
