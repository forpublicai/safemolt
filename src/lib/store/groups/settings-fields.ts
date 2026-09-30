/**
 * M11-2 P1.3 — the group settings vocabulary, in one place.
 *
 * Three modules need the same list and the same notion of "supplied": both store implementations,
 * which must write the same fields, and the action, whose `group.settings_updated` payload names
 * which of them an edit touched. Three copies of a five-element list is three chances for the two
 * stores to accept different fields and for the event to describe an edit that did not happen.
 */
export interface GroupSettingsUpdates {
  displayName?: string;
  description?: string;
  bannerColor?: string;
  themeColor?: string;
  emoji?: string;
}

export const GROUP_SETTINGS_FIELDS = [
  "displayName",
  "description",
  "bannerColor",
  "themeColor",
  "emoji",
] as const satisfies ReadonlyArray<keyof GroupSettingsUpdates>;

/**
 * The one field whose `undefined` MEANS something: an empty emoji is a deliberate clear.
 *
 * Both REST and the tool normalize `emoji: ""` to the key being present with the value `undefined`,
 * so emoji is detected by key presence. Every other field's `undefined` is simply absent.
 */
const CLEARABLE_FIELD = "emoji";

/**
 * Which settings this call asks to write.
 *
 * **Presence for `emoji`, a real value for everything else** — and both halves are corrections of a
 * store divergence:
 *
 *  - Presence alone was wrong for the other four. `{ displayName: undefined }` is what a caller
 *    building an update object conditionally produces, and Postgres binds it as NULL where
 *    `COALESCE(NULL, display_name)` **preserves the old value** — so the column never moved, while
 *    the memory store's object spread replaced the field with `undefined` and both stores emitted an
 *    event naming a field nothing had written.
 *  - A value test alone was wrong for `emoji`. The db store used exactly that and silently ignored
 *    every emoji removal, while the memory spread performed it.
 *
 * Sorted, so two edits of the same fields produce byte-identical event payloads.
 */
export function suppliedGroupSettingsFields(updates: GroupSettingsUpdates): string[] {
  return GROUP_SETTINGS_FIELDS.filter((field) =>
    field === CLEARABLE_FIELD
      ? Object.prototype.hasOwnProperty.call(updates, field)
      : updates[field] !== undefined
  )
    .slice()
    .sort();
}
