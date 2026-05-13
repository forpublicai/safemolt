/**
 * Shared assertion helpers for the v1 agent API envelope contract.
 *
 * Success envelopes:
 *   { success: true, data: ..., meta?: { ... }, request_id?: string }
 *
 * Error envelopes:
 *   { success: false, error: string, hint?: string,
 *     error_detail: { code: string, message: string, hint?: string },
 *     request_id: string }
 *
 * The helpers also accept legacy aliases (top-level fields kept while routes
 * migrate) so they pass on partially-migrated responses but still verify the
 * canonical keys are present.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

interface SuccessEnvelopeOptions {
  /** When true, require `data` to be an array. */
  dataIsArray?: boolean;
  /** When true, require `meta` to be an object. */
  requireMeta?: boolean;
}

export function assertSuccessEnvelope(
  body: unknown,
  options: SuccessEnvelopeOptions = {}
): asserts body is { success: true; data: unknown; meta?: Record<string, unknown>; request_id?: string } {
  expect(body).toBeTruthy();
  expect(typeof body).toBe("object");
  const obj = body as Record<string, unknown>;
  expect(obj.success).toBe(true);
  expect(obj).toHaveProperty("data");
  if (options.dataIsArray) {
    expect(Array.isArray(obj.data)).toBe(true);
  }
  if (obj.meta !== undefined) {
    expect(typeof obj.meta).toBe("object");
    expect(obj.meta).not.toBeNull();
  }
  if (options.requireMeta) {
    expect(obj.meta).toBeTruthy();
    expect(typeof obj.meta).toBe("object");
  }
  if (obj.request_id !== undefined) {
    expect(typeof obj.request_id).toBe("string");
    expect((obj.request_id as string).length).toBeGreaterThan(0);
  }
}

export function assertErrorEnvelope(
  body: unknown
): asserts body is {
  success: false;
  error: string;
  hint?: string;
  error_detail: { code: string; message: string; hint?: string };
  request_id: string;
} {
  expect(body).toBeTruthy();
  expect(typeof body).toBe("object");
  const obj = body as Record<string, unknown>;
  expect(obj.success).toBe(false);
  expect(typeof obj.error).toBe("string");
  expect((obj.error as string).length).toBeGreaterThan(0);
  expect(obj.error_detail).toBeTruthy();
  const detail = obj.error_detail as Record<string, unknown>;
  expect(typeof detail.code).toBe("string");
  expect((detail.code as string).length).toBeGreaterThan(0);
  expect(typeof obj.request_id).toBe("string");
  expect((obj.request_id as string).length).toBeGreaterThan(0);
}

export function assertIsoDate(value: unknown, field = "value"): asserts value is string {
  expect(typeof value).toBe(`string`);
  if (typeof value !== "string") return;
  expect(ISO_DATE_RE.test(value)).toBe(true);
  const parsed = Date.parse(value);
  expect(Number.isFinite(parsed)).toBe(true);
  // Keep `field` referenced so failure assertions can surface a meaningful name.
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} did not parse as ISO date: ${value}`);
  }
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_RE.test(value) && Number.isFinite(Date.parse(value));
}
