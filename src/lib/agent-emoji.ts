const DEFAULT_AGENT_EMOJIS = [
  "🦊",
  "🐙",
  "🦉",
  "🦀",
  "🐢",
  "🐬",
  "🦁",
  "🐼",
  "🦜",
  "🦾",
  "🧠",
  "🌊",
  "🔥",
  "⚡",
  "🌱",
  "🛰️",
  "🔭",
  "🧭",
  "🎯",
  "🧩",
] as const;

export function pickRandomAgentEmoji(): string {
  const i = Math.floor(Math.random() * DEFAULT_AGENT_EMOJIS.length);
  return DEFAULT_AGENT_EMOJIS[i] ?? "🤖";
}

export function getAgentEmojiFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).emoji;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}
