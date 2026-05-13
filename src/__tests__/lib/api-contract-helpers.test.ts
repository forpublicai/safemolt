/**
 * @jest-environment node
 *
 * Verifies the contract test helpers themselves and that the live jsonResponse
 * helper attaches an X-Request-Id header automatically (UX2 Phase 2).
 */
import {
  assertSuccessEnvelope,
  assertErrorEnvelope,
  assertIsoDate,
  isIsoDate,
} from "@/__tests__/helpers/api-contract";
import { jsonResponse, errorResponse } from "@/lib/auth";

describe("assertSuccessEnvelope", () => {
  it("passes when body has success:true and data", () => {
    assertSuccessEnvelope({ success: true, data: [1, 2, 3] });
  });

  it("accepts optional meta and request_id", () => {
    assertSuccessEnvelope({
      success: true,
      data: { x: 1 },
      meta: { count: 1 },
      request_id: "req_abc",
    });
  });

  it("fails when success is false", () => {
    expect(() => assertSuccessEnvelope({ success: false, data: null })).toThrow();
  });

  it("fails when data key is missing", () => {
    expect(() => assertSuccessEnvelope({ success: true })).toThrow();
  });

  it("enforces dataIsArray when requested", () => {
    assertSuccessEnvelope({ success: true, data: [] }, { dataIsArray: true });
    expect(() =>
      assertSuccessEnvelope({ success: true, data: { x: 1 } }, { dataIsArray: true })
    ).toThrow();
  });
});

describe("assertErrorEnvelope", () => {
  it("passes on canonical error body", () => {
    assertErrorEnvelope({
      success: false,
      error: "Bad",
      error_detail: { code: "bad_request", message: "Bad" },
      request_id: "req_x",
    });
  });

  it("fails when error_detail.code is missing", () => {
    expect(() =>
      assertErrorEnvelope({
        success: false,
        error: "Bad",
        error_detail: { message: "Bad" },
        request_id: "req_x",
      })
    ).toThrow();
  });

  it("fails when request_id is missing", () => {
    expect(() =>
      assertErrorEnvelope({
        success: false,
        error: "Bad",
        error_detail: { code: "bad_request", message: "Bad" },
      })
    ).toThrow();
  });
});

describe("assertIsoDate / isIsoDate", () => {
  it("accepts ISO 8601 Zulu", () => {
    expect(isIsoDate("2026-05-13T10:00:00.000Z")).toBe(true);
    assertIsoDate("2026-05-13T10:00:00.000Z");
  });

  it("accepts ISO 8601 with offset", () => {
    expect(isIsoDate("2026-05-13T10:00:00+00:00")).toBe(true);
  });

  it("rejects locale-formatted strings (the bug toIsoOrNull guards against)", () => {
    expect(isIsoDate("Tue May 13 2026 10:00:00 GMT+0000")).toBe(false);
  });

  it("rejects empty strings and non-strings", () => {
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(123)).toBe(false);
  });
});

describe("jsonResponse contract", () => {
  it("attaches an X-Request-Id header by default (UX2 observability)", () => {
    const res = jsonResponse({ success: true, data: [] });
    const id = res.headers.get("X-Request-Id");
    expect(typeof id).toBe("string");
    expect((id ?? "").length).toBeGreaterThan(0);
  });

  it("preserves a caller-supplied X-Request-Id", () => {
    const res = jsonResponse({ success: true, data: [] }, 200, { "X-Request-Id": "req_custom" });
    expect(res.headers.get("X-Request-Id")).toBe("req_custom");
  });

  it("does not duplicate the header when case differs", () => {
    const res = jsonResponse({ success: true, data: [] }, 200, { "x-request-id": "req_lower" });
    expect(res.headers.get("X-Request-Id")).toBe("req_lower");
  });
});

describe("errorResponse contract", () => {
  it("returns canonical error envelope and X-Request-Id matches body request_id", async () => {
    const res = errorResponse("Bad", "do better", 400);
    const headerId = res.headers.get("X-Request-Id");
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.request_id).toBe(headerId);
    expect(body.error_detail.code).toBe("bad_request");
  });
});
