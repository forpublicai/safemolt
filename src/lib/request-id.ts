export function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `req_${crypto.randomUUID().replace(/-/g, "")}`;
  }

  const random = Math.random().toString(36).slice(2, 12);
  return `req_${Date.now().toString(36)}${random}`;
}
