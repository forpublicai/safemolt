import { readFileSync } from "fs";
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
} from "@/lib/store/groups/memory";

describe("M2 houses table deletion invariants", () => {
  it("keeps house tables out of the base schema and records the drop migration", () => {
    const root = process.cwd();
    const schema = readFileSync(join(root, "scripts/schema.sql"), "utf8");
    const dropHouses = readFileSync(join(root, "scripts/migrate-drop-houses.sql"), "utf8");
    const migrate = readFileSync(join(root, "scripts/migrate.js"), "utf8");
    const memoryState = readFileSync(join(root, "src/lib/store/_memory-state.ts"), "utf8");

    expect(schema).not.toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+houses\b/i);
    expect(schema).not.toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+house_members\b/i);
    expect(dropHouses).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+house_members\b/i);
    expect(dropHouses).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+houses\b/i);
    expect(migrate).toContain("_migrations");
    expect(memoryState).not.toContain("houseMembers");
  });

  it("keeps house-typed groups on normal group membership in memory", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const founder = await createAgent(`Founder_${suffix}`, "founds one house");
    const member = await createAgent(`Member_${suffix}`, "joins one house");
    const otherFounder = await createAgent(`OtherFounder_${suffix}`, "founds another house");

    const house = await createGroup(`house_${suffix}`, "House", "A house-typed group", founder.id, "house");
    const otherHouse = await createGroup(`other_house_${suffix}`, "Other House", "Another house", otherFounder.id, "house");

    expect(await isGroupMember(founder.id, house.id)).toBe(true);
    expect(await getGroupMemberCount(house.id)).toBe(1);

    await expect(joinGroup(member.id, house.id)).resolves.toEqual({ success: true });
    expect(await isGroupMember(member.id, house.id)).toBe(true);
    expect((await getGroupMembers(house.id)).map((item) => item.agentId)).toEqual([founder.id, member.id]);

    await expect(joinGroup(member.id, otherHouse.id)).resolves.toEqual({
      success: false,
      error: "You are already in a house. Leave your current house first.",
    });

    await expect(leaveGroup(member.id, house.id)).resolves.toEqual({ success: true });
    expect(await isGroupMember(member.id, house.id)).toBe(false);
    expect(await getGroupMemberCount(house.id)).toBe(1);

    await expect(leaveGroup(founder.id, house.id)).resolves.toEqual({ success: true });
    expect(await getGroup(house.id)).toBeNull();
  });
});
