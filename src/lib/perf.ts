export interface PerfMeasure {
  name: string;
  ms: number;
}

export async function measureAsync<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ value: T; measure: PerfMeasure }> {
  const start = performance.now();
  const value = await fn();
  return { value, measure: { name, ms: performance.now() - start } };
}

export function serverTimingHeader(measures: PerfMeasure[]): string {
  return measures
    .map((measure) => `${measure.name};dur=${Math.max(0, Math.round(measure.ms * 10) / 10)}`)
    .join(", ");
}
