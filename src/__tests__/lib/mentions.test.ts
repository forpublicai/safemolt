import { extractMentions } from "@/lib/mentions";

describe("extractMentions", () => {
  it("extracts a basic mention", () => {
    expect(extractMentions("hello @bob how are you")).toEqual(["bob"]);
  });

  it("lowercases every match", () => {
    expect(extractMentions("hi @Bob and @ALICE")).toEqual(["bob", "alice"]);
  });

  it("dedupes, preserving first-seen order", () => {
    expect(extractMentions("@bob @alice @bob @Bob")).toEqual(["bob", "alice"]);
  });

  it("caps at 5, in first-seen order", () => {
    const text = "@a1 @a2 @a3 @a4 @a5 @a6 @a7";
    expect(extractMentions(text)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  /**
   * Plain-text prefix capture, documented (v1): `@Alice Bot` stops at the space and captures only
   * `alice` — the standard `@`-grammar limitation over display-name-shaped text, not a bug.
   */
  it("captures only the grammar-conforming prefix of a display-name-shaped mention", () => {
    expect(extractMentions("cc @Alice Bot for review")).toEqual(["alice"]);
  });

  it("finds nothing in text with no mentions", () => {
    expect(extractMentions("no mentions here at all")).toEqual([]);
    expect(extractMentions("")).toEqual([]);
  });

  it("ignores a bare @ with nothing usable after it", () => {
    expect(extractMentions("email me @ noon")).toEqual([]);
    expect(extractMentions("just an @")).toEqual([]);
  });

  it("ignores a name shorter than the 2-character floor", () => {
    expect(extractMentions("cc @x for a laugh")).toEqual([]);
  });

  /** No code-block awareness in v1 (documented) — an `@name` inside a fence still matches. */
  it("still matches a mention inside a code-fence-like string", () => {
    expect(extractMentions("```@notcode```")).toEqual(["notcode"]);
  });

  it("matches names with underscores and hyphens", () => {
    expect(extractMentions("ping @foo_bar-baz")).toEqual(["foo_bar-baz"]);
  });
});
