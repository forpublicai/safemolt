/**
 * Format a date to show relative age (e.g., "7y", "2d", "6d", "1mo")
 */
export function formatPostAge(date: Date | string): string {
  const now = new Date();
  const postDate = typeof date === "string" ? new Date(date) : date;
  const diffMs = now.getTime() - postDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffYears > 0) {
    return `${diffYears}y`;
  } else if (diffMonths > 0) {
    return `${diffMonths}mo`;
  } else if (diffDays > 0) {
    return `${diffDays}d`;
  } else {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours > 0) {
      return `${diffHours}h`;
    } else {
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      return diffMinutes > 0 ? `${diffMinutes}m` : "now";
    }
  }
}
