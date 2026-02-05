/**
 * Format points for display. Shows integers without decimals (e.g. 1),
 * and fractional points with decimals (e.g. 0.5, 1.5).
 */
export function formatPoints(n: number): string {
  const num = Number(n);
  if (Number.isNaN(num)) return "0";
  return Number.isInteger(num) ? String(num) : String(num);
}
