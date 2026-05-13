/**
 * @jest-environment node
 *
 * UX2 Phase 6: prove the documented Python PoAW sample produces the same
 * SHA256 hash as the JS/server reference. The Python snippet in skill.md is:
 *
 *     payload = json.dumps(sorted_values, separators=(",", ":")) + nonce
 *     hashlib.sha256(payload.encode()).hexdigest()
 *
 * With compact separators, Python's json.dumps for an integer list emits the
 * *exact same* byte string as JavaScript's JSON.stringify: "[1,2,3]". This
 * test reproduces what a Python client would do and asserts byte-equality
 * with what the server's computeExpectedHash() produces.
 */
import { computeExpectedHash } from "@/lib/vetting";
import { createHash } from "crypto";

/**
 * Replicates Python's `json.dumps(values, separators=(",", ":"))` for integer
 * lists. This is the smallest possible reference implementation; we are
 * verifying that the *documented* Python snippet matches the server. If the
 * documented snippet were wrong (e.g. omitted separators), this test would
 * fail because Python's default `json.dumps([1,2,3])` produces "[1, 2, 3]"
 * (with spaces), which our pythonCompactJson does NOT replicate — and that
 * mismatch is exactly the bug fix.
 */
function pythonCompactJson(values: number[]): string {
  return `[${values.join(",")}]`;
}

function pythonDefaultJson(values: number[]): string {
  // What `json.dumps([1, 2, 3])` produces by default: spaces after each comma.
  return `[${values.join(", ")}]`;
}

describe("PoAW Python sample hash matches server", () => {
  const values = [1, 2, 3];
  const nonce = "abc";

  it("server computeExpectedHash matches JS JSON.stringify(sorted)+nonce", () => {
    const jsPayload = JSON.stringify([...values].sort((a, b) => a - b)) + nonce;
    const jsHash = createHash("sha256").update(jsPayload).digest("hex");
    expect(computeExpectedHash(values, nonce)).toBe(jsHash);
  });

  it("Python compact json.dumps(separators=(',', ':')) matches server", () => {
    const pyPayload = pythonCompactJson([...values].sort((a, b) => a - b)) + nonce;
    const pyHash = createHash("sha256").update(pyPayload).digest("hex");
    const serverHash = computeExpectedHash(values, nonce);
    expect(pyHash).toBe(serverHash);
  });

  it("Python DEFAULT json.dumps (with spaces) does NOT match — proves doc fix is required", () => {
    const badPayload = pythonDefaultJson([...values].sort((a, b) => a - b)) + nonce;
    const badHash = createHash("sha256").update(badPayload).digest("hex");
    const serverHash = computeExpectedHash(values, nonce);
    expect(badHash).not.toBe(serverHash);
  });

  it("documented Python snippet is preserved in skill.md", () => {
    // Light cross-check that the doc fix is present. If someone reverts the
    // doc without updating the test, this will catch it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    const path = require("path");
    const doc = fs.readFileSync(
      path.resolve(__dirname, "../../../public/skill.md"),
      "utf8"
    );
    expect(doc).toContain('separators=(",", ":")');
  });
});
