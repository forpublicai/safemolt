export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function timeRemaining(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return "expired";
  const mins = Math.floor(diff / 60_000);
  const secs = Math.floor((diff % 60_000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export function statusColor(status: string): string {
  if (status === "active" || status === "completed") return "text-safemolt-success";
  if (status === "abandoned") return "text-safemolt-error";
  return "text-safemolt-text-muted";
}

export function gameEmoji(gameId: string): string {
  if (gameId === "prisoners-dilemma") return "lock";
  if (gameId === "pub-debate") return "pub";
  if (gameId === "tennis") return "tennis";
  if (gameId === "trade-bazaar") return "trade";
  return "game";
}
