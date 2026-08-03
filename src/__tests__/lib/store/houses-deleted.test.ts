/**
 * Houses are removed (M11-1b, closing D1 finding 2 and half of finding 4).
 *
 * M2 deleted the separate `houses` / `house_members` tables and left house-ness as a group TYPE
 * with four rules attached: one house per agent, an evaluation gate on joining, a promoted founder,
 * and a points total fed by every vote on a member's content. That last one is why D1 could not
 * finish: a house award was keyed on membership at vote time and nothing recorded which house
 * received what, so a post deletion could not reverse it. The rules are gone rather than repaired.
 *
 * These are the invariants that keep them gone.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { createAgent } from "@/lib/store/agents/memory";
import {
  createGroup,
  getGroup,
  getGroupMemberCount,
  getGroupMembers,
  isGroupMember,
  joinGroup,
  leaveGroup,
  listGroups,
} from "@/lib/store/groups/memory";
import { rowToGroup } from "@/lib/store/rows";
import { groups } from "@/lib/store/_memory-state";
import type { StoredGroup } from "@/lib/store-types";

/** Every .ts/.tsx file under a directory, tests excluded. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe("houses removal: schema and migrations", () => {
  const root = process.cwd();

  it("keeps the legacy house tables out of the base schema and records their drop", () => {
    const schema = readFileSync(join(root, "scripts/schema.sql"), "utf8");
    const dropHouses = readFileSync(join(root, "scripts/migrate-drop-houses.sql"), "utf8");
    const memoryState = readFileSync(join(root, "src/lib/store/_memory-state.ts"), "utf8");

    expect(schema).not.toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+houses\b/i);
    expect(schema).not.toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+house_members\b/i);
    expect(dropHouses).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+house_members\b/i);
    expect(dropHouses).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+houses\b/i);
    expect(memoryState).not.toContain("houseMembers");
  });

  it("runs the conversion as a migration and the column drop as a runbook step", () => {
    const migrate = readFileSync(join(root, "scripts/migrate.js"), "utf8");
    const conversion = readFileSync(join(root, "scripts/migrate-remove-houses.sql"), "utf8");
    const contract = readFileSync(join(root, "scripts/contract-drop-house-columns.sql"), "utf8");

    // NEITHER script is a migration, and for the same reason. Migrations run during the build,
    // while the previous instances still serve: an old instance awards house points as a
    // post-commit follow-up and throws "House … not found" once the row is no longer house-typed,
    // so converting under it turns an ordinary upvote into a 500 AFTER the vote committed. Both
    // are runbook steps behind the drain barrier — the new code treats an unconverted house as an
    // ordinary group from the moment it is live, so nothing is waiting on the conversion.
    expect(migrate).not.toContain("migrate-remove-houses.sql");
    expect(conversion).toMatch(/UPDATE groups SET type = ''group''/);
    expect(conversion).toMatch(/DROP INDEX IF EXISTS uniq_group_members_single_house/);

    // Order is the whole correctness of this file, and a text match is the cheap half of the
    // check — `src/__tests__/integration/houses-removal.test.ts` runs it against a real house
    // row, which is what actually catches a reordering.
    //   1. the two immediate CHECK constraints that state "a house has points" must go FIRST,
    //      because no order of row updates satisfies them while converting;
    //   2. the promoted founder must be carried into `owner_id` BEFORE `founder_id` is cleared,
    //      or a converted house is handed back to a creator who left.
    const dropPoints = conversion.indexOf("DROP CONSTRAINT IF EXISTS chk_house_points");
    const dropFounder = conversion.indexOf("DROP CONSTRAINT IF EXISTS chk_house_founder");
    const carryOwner = conversion.indexOf("SET owner_id = founder_id");
    const clearFounder = conversion.indexOf("SET founder_id = NULL");
    const flipType = conversion.indexOf("SET type = ''group''");
    for (const index of [dropPoints, dropFounder, carryOwner, clearFounder, flipType]) {
      expect(index).toBeGreaterThan(-1);
    }
    expect(dropPoints).toBeLessThan(carryOwner);
    expect(dropFounder).toBeLessThan(carryOwner);
    expect(carryOwner).toBeLessThan(clearFounder);
    expect(carryOwner).toBeLessThan(flipType);

    // The column drop must NOT: migrations run during the build, before the old instances drain,
    // and an old `createGroup` still names those columns in its INSERT.
    expect(migrate).not.toContain("contract-drop-house-columns.sql");
    expect(contract).toMatch(/ALTER TABLE groups DROP COLUMN IF EXISTS points/);
  });
});

describe("houses removal: no code branches on house-ness", () => {
  /**
   * The ONE permitted comparison, and it is not a branch on a stored group at all: it validates the
   * `type` REQUEST FIELD, so a caller that still sends the old value gets an ordinary group instead
   * of a new error, while a typo is refused rather than quietly consuming the requested name.
   * Anything else that compares to 'house' is a house rule growing back.
   */
  const ALLOWED = new Map<string, string[]>([
    [
      "src/app/api/v1/groups/route.ts",
      [
        // Validates the `type` REQUEST FIELD so a caller that still sends the old value gets an
        // ordinary group instead of a new error, while a typo is refused rather than quietly
        // consuming the requested name.
        "if (requestedType !== undefined && requestedType !== 'group' && requestedType !== 'house') {",
        // Two documented compatibility surfaces: a response key kept for one deprecation cycle,
        // and the hint that tells an agent why its `type` was refused.
        "include_houses: false,",
        'return errorResponse("type must be \\"group\\"", "Houses are removed; omit type or send \\"group\\".", 400);',
      ],
    ],
  ]);

  it("has no surviving house-typed branch, and no surviving house wording, anywhere in src", () => {
    // **Every root, not just the stores.** An earlier version scanned `src/lib` and `src/app` only,
    // and the default Classic navigation went on labelling `/g` as "Houses" with this test green —
    // the removal was invisible to the scan precisely where a user would see it. Components and
    // theme shells are in scope, and so is the WORD, not only the quoted value: a nav label is not
    // a comparison.
    const offenders: string[] = [];
    for (const path of [
      ...sourceFiles("src/lib"),
      ...sourceFiles("src/app"),
      ...sourceFiles("src/components"),
      ...sourceFiles("src/themes"),
    ]) {
      const body = readFileSync(path, "utf8");
      for (const [index, line] of body.split("\n").entries()) {
        // A comment recording the removal is fine; live code is not.
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (!/house/i.test(code)) continue;
        if (ALLOWED.get(path)?.includes(line.trim())) continue;
        offenders.push(`${path}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("normalizes a leftover house row to an ordinary group", () => {
    // An instance that has not drained can still write `type = 'house'` after the migration ran.
    // The boundary flattens it, so nothing above the store can see house-ness again.
    const group = rowToGroup({
      id: "leftover",
      name: "leftover",
      display_name: "Leftover",
      description: "",
      type: "house",
      owner_id: "agent_1",
      created_at: new Date().toISOString(),
    });

    expect(group.type).toBe("group");
    expect(group).not.toHaveProperty("founderId");
    expect(group).not.toHaveProperty("points");
  });

  it("reads a leftover house's PROMOTED FOUNDER as its owner", () => {
    // The authorization half of the same window. An undrained instance can create a house after
    // the conversion migration ran and then promote a new founder by writing `founder_id` alone —
    // and the runner never re-runs a recorded migration. Reading `owner_id` for that row hands the
    // group to whoever created it, who may have left, and locks out the agent running it.
    const group = rowToGroup({
      id: "late_house",
      name: "late_house",
      display_name: "Late house",
      description: "",
      type: "house",
      owner_id: "creator_who_left",
      founder_id: "promoted_member",
      created_at: new Date().toISOString(),
    });

    expect(group.ownerId).toBe("promoted_member");

    // And an ordinary group — no founder, before or after the column is dropped — is untouched.
    const plain = rowToGroup({
      id: "plain",
      name: "plain",
      display_name: "Plain",
      description: "",
      type: "group",
      owner_id: "the_owner",
      created_at: new Date().toISOString(),
    });
    expect(plain.ownerId).toBe("the_owner");
  });
});

describe("houses removal: the four rules are gone from the memory store", () => {
  /**
   * The groups are planted as HOUSE-TYPED rows, not created through `createGroup`.
   *
   * `createGroup` no longer takes a type, so a test that just calls it proves nothing: joining two
   * ordinary groups was always allowed and leaving one never dissolved it, so the assertions below
   * would pass unchanged against the store that still had the house branches. Planting the shape
   * the old code branched on is what makes them fail there: the single-house rule refused the
   * second join, and the founder leaving an empty house deleted it.
   */
  function plantHouse(id: string, ownerId: string): void {
    groups.set(id, {
      id,
      name: id,
      displayName: id,
      description: "",
      // The union has one member on purpose; this is the leftover row an undrained instance writes.
      type: "house" as unknown as StoredGroup["type"],
      ownerId,
      memberIds: [ownerId],
      moderatorIds: [],
      pinnedPostIds: [],
      createdAt: new Date().toISOString(),
    } as StoredGroup);
  }

  it("lets one agent join two former houses, and never dissolves a group on leave", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const founder = await createAgent(`Founder_${suffix}`, "owns one group");
    const member = await createAgent(`Member_${suffix}`, "joins both");
    const otherOwner = await createAgent(`OtherOwner_${suffix}`, "owns the other");

    plantHouse(`house_${suffix}`, founder.id);
    plantHouse(`other_house_${suffix}`, otherOwner.id);
    const first = (await getGroup(`house_${suffix}`))!;
    const second = (await getGroup(`other_house_${suffix}`))!;

    // The read boundary normalizes the leftover row, exactly as `rowToGroup` does in db mode: a
    // group object that survived a hot reload from the code that still had houses must not keep
    // exposing `"house"`, and its founder must win as owner.
    expect(first.type).toBe("group");
    expect(await isGroupMember(founder.id, first.id)).toBe(true);
    expect(await getGroupMemberCount(first.id)).toBe(1);

    // The single-house rule used to refuse this second join.
    await expect(joinGroup(member.id, first.id)).resolves.toEqual({ success: true });
    await expect(joinGroup(member.id, second.id)).resolves.toEqual({ success: true });
    expect(await isGroupMember(member.id, first.id)).toBe(true);
    expect(await isGroupMember(member.id, second.id)).toBe(true);
    expect((await getGroupMembers(first.id)).map((item) => item.agentId)).toEqual([founder.id, member.id]);

    await expect(leaveGroup(member.id, first.id)).resolves.toEqual({ success: true });
    expect(await getGroupMemberCount(first.id)).toBe(1);

    // The founder-promotion and dissolve-when-empty lifecycle went with the houses: an emptied
    // group survives, with its posts and its name intact.
    await expect(leaveGroup(founder.id, first.id)).resolves.toEqual({ success: true });
    expect(await getGroup(first.id)).not.toBeNull();
    expect(await getGroupMemberCount(first.id)).toBe(0);
  });

  it("normalizes a legacy in-memory house on read, founder first", async () => {
    // The maps deliberately survive HMR, so a house created before the reload is still in there
    // with `type: "house"` and its own `founderId`. Without normalization, memory mode keeps
    // exposing "house" and authorizes by `ownerId` while the promoted founder sits in a field
    // nothing reads.
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const creator = await createAgent(`Creator_${suffix}`, "created it and left");
    const promoted = await createAgent(`Promoted_${suffix}`, "runs it now");
    const id = `legacy_house_${suffix}`;
    groups.set(id, {
      id,
      name: id,
      displayName: id,
      description: "",
      type: "house" as unknown as StoredGroup["type"],
      ownerId: creator.id,
      memberIds: [promoted.id],
      moderatorIds: [],
      pinnedPostIds: [],
      createdAt: new Date().toISOString(),
      // The fields the type no longer has, as a pre-reload object really carries them.
      founderId: promoted.id,
      points: 12,
    } as StoredGroup & { founderId: string; points: number });

    const read = (await getGroup(id))!;
    expect(read.type).toBe("group");
    expect(read.ownerId).toBe(promoted.id);
    expect(read).not.toHaveProperty("founderId");
    expect(read).not.toHaveProperty("points");
    expect((await listGroups()).find((g) => g.id === id)!.ownerId).toBe(promoted.id);
  });

  it("reports the plain group error when a non-member leaves", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const owner = await createAgent(`Owner_${suffix}`, "owns it");
    const stranger = await createAgent(`Stranger_${suffix}`, "never joined");
    const group = await createGroup(`plain_${suffix}`, "Plain", "", owner.id);

    await expect(leaveGroup(stranger.id, group.id)).resolves.toEqual({
      success: false,
      error: "Not a member of this group",
    });
  });
});
