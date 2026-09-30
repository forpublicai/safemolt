/**
 * Houses removal `[integration]` — the conversion migration, run against a real house row.
 *
 * Two defects live here and neither is visible to a text-matching unit test, which is why this file
 * exists at all:
 *
 *  - `migrate-groups-unified.sql` added `chk_house_points` and `chk_house_founder`, immediate CHECK
 *    constraints that state a house HAS points and a group has none. There is no order of row
 *    updates that satisfies them while converting, so the constraints have to be dropped first or
 *    the migration raises 23514 on the first real house and takes the whole deploy down.
 *  - A house authorized settings by `founder_id` and a group authorizes by `owner_id`. They start
 *    equal and diverge when the founder leaves, because the old promotion wrote `founder_id` alone.
 *    Converting without carrying it across hands the group back to a creator who left.
 *
 * The constraints are RECREATED in `beforeAll` before each run, because the migration drops them
 * permanently — without that, the second run of this suite would be testing a database where the
 * defect cannot occur, and would pass for the wrong reason.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { closeIntegrationConnections, pgClient, pgPool } from "./helpers/db";
import { getYourRole } from "@/lib/store/groups/db";

const MIGRATION_SQL = readFileSync(
    join(__dirname, "..", "..", "..", "scripts", "migrate-remove-houses.sql"),
    "utf8"
);

/** The post-drain runbook step. Every test that runs it does so inside a rolled-back transaction. */
const CONTRACT_SQL = readFileSync(
    join(__dirname, "..", "..", "..", "scripts", "contract-drop-house-columns.sql"),
    "utf8"
);

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
const CREATOR = `hr_creator_${RUN}`;
const PROMOTED = `hr_promoted_${RUN}`;
const HOUSE = `hr_house_${RUN}`;
const PLAIN = `hr_group_${RUN}`;

async function seedAgent(id: string): Promise<void> {
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted)
         VALUES ($1, $1, '', $2, 0, 0, false, NOW(), true)`,
        [id, `hr_key_${id}`]
    );
}

async function groupRow(id: string) {
    const { rows } = await pgPool().query(
        `SELECT type, points, founder_id, owner_id, required_evaluation_ids FROM groups WHERE id = $1`,
        [id]
    );
    return rows[0] ?? null;
}

async function houseConstraintNames(): Promise<string[]> {
    const { rows } = await pgPool().query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'groups'::regclass AND conname IN ('chk_house_points', 'chk_house_founder')
         ORDER BY conname`
    );
    return rows.map((row) => row.conname);
}

beforeAll(async () => {
    await seedAgent(CREATOR);
    await seedAgent(PROMOTED);

    // Put the real constraints back, exactly as migrate-groups-unified.sql wrote them. Every
    // surviving row is already an ordinary group with NULL points and NULL founder, so they build.
    await pgPool().query(`ALTER TABLE groups DROP CONSTRAINT IF EXISTS chk_house_points`);
    await pgPool().query(`ALTER TABLE groups DROP CONSTRAINT IF EXISTS chk_house_founder`);
    await pgPool().query(
        `ALTER TABLE groups ADD CONSTRAINT chk_house_points
         CHECK ((type = 'house' AND points IS NOT NULL) OR (type = 'group' AND points IS NULL))`
    );
    await pgPool().query(
        `ALTER TABLE groups ADD CONSTRAINT chk_house_founder
         CHECK ((type = 'house' AND founder_id IS NOT NULL) OR (type = 'group' AND founder_id IS NULL))`
    );

    // A house whose founder LEFT: the promotion wrote founder_id and left owner_id behind.
    await pgPool().query(
        `INSERT INTO groups (id, name, display_name, description, owner_id, founder_id, type, points,
                             member_ids, moderator_ids, pinned_post_ids, created_at)
         VALUES ($1, $1, 'A house', '', $2, $3, 'house', 42, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NOW())`,
        [HOUSE, CREATOR, PROMOTED]
    );
    // Its members, recorded the way a house recorded them: in `group_members`, flagged `is_house`.
    // Membership survival is the headline claim of "removal converts, never deletes", so it has to
    // be seeded or the assertion is decorative.
    for (const member of [CREATOR, PROMOTED]) {
        await pgPool().query(
            `INSERT INTO group_members (agent_id, group_id, joined_at, is_house)
             VALUES ($1, $2, NOW(), TRUE) ON CONFLICT (agent_id, group_id) DO NOTHING`,
            [member, HOUSE]
        );
    }

    // An ordinary group, to prove the conversion does not reach past the houses.
    await pgPool().query(
        `INSERT INTO groups (id, name, display_name, description, owner_id, type,
                             member_ids, moderator_ids, pinned_post_ids, created_at)
         VALUES ($1, $1, 'A group', '', $2, 'group', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NOW())`,
        [PLAIN, CREATOR]
    );
});

/** Canonical membership, with the denormalized house flag each row still carries. */
async function memberships(groupId: string): Promise<Array<{ agent_id: string; is_house: boolean }>> {
    const { rows } = await pgPool().query<{ agent_id: string; is_house: boolean }>(
        `SELECT agent_id, is_house FROM group_members WHERE group_id = $1 ORDER BY agent_id`,
        [groupId]
    );
    return rows;
}

afterAll(async () => {
    await pgPool().query("DELETE FROM group_members WHERE group_id IN ($1, $2)", [HOUSE, PLAIN]);
    await pgPool().query("DELETE FROM groups WHERE id IN ($1, $2)", [HOUSE, PLAIN]);
    await pgPool().query("DELETE FROM agents WHERE id IN ($1, $2)", [CREATOR, PROMOTED]);
    // Left dropped, which is the state the migration itself leaves behind.
    await pgPool().query(`ALTER TABLE groups DROP CONSTRAINT IF EXISTS chk_house_points`);
    await pgPool().query(`ALTER TABLE groups DROP CONSTRAINT IF EXISTS chk_house_founder`);
    await closeIntegrationConnections();
});

describe("migrate-remove-houses.sql", () => {
    it("converts a real house, keeps its administrator, and drops the constraints that blocked it", async () => {
        expect(await houseConstraintNames()).toEqual(["chk_house_founder", "chk_house_points"]);
        const before = await groupRow(HOUSE);
        expect(before.type).toBe("house");
        expect(Number(before.points)).toBe(42);
        expect(before.founder_id).toBe(PROMOTED);
        expect(before.owner_id).toBe(CREATOR);

        const client = await pgClient();
        try {
            await client.query(MIGRATION_SQL);
        } finally {
            await client.end();
        }

        const after = await groupRow(HOUSE);
        expect(after.type).toBe("group");
        expect(after.points).toBeNull();
        expect(after.founder_id).toBeNull();
        // The promoted founder — the agent who was actually running it — keeps administrative
        // access. Without the carry-across this reads CREATOR, who left.
        expect(after.owner_id).toBe(PROMOTED);
        // The row itself survives with its name and its members: removal converts, never deletes.
        const { rows } = await pgPool().query(`SELECT name FROM groups WHERE id = $1`, [HOUSE]);
        expect(rows[0].name).toBe(HOUSE);
        // Both memberships are still there, and each is now an ordinary one.
        expect(await memberships(HOUSE)).toEqual(
            [CREATOR, PROMOTED].sort().map((agent_id) => ({ agent_id, is_house: false }))
        );

        // The ordinary group is untouched, owner included.
        const plain = await groupRow(PLAIN);
        expect(plain.type).toBe("group");
        expect(plain.owner_id).toBe(CREATOR);

        expect(await houseConstraintNames()).toEqual([]);
    });

    it("reports the PROMOTED FOUNDER as owner before the conversion ever runs", async () => {
        // The window this covers: an old instance creates a house AFTER the conversion was run and
        // promotes a new founder by writing `founder_id` alone. Nothing re-converts it until the
        // operator's next pass, so every authorization path has to agree with `rowToGroup`'s
        // founder-wins rule in the meantime — `getYourRole` read `owner_id` directly and told the
        // agent actually running the group that they had no role at all.
        const late = `hr_role_${RUN}`;
        await pgPool().query(
            `INSERT INTO groups (id, name, display_name, description, owner_id, founder_id, type, points,
                                 member_ids, moderator_ids, pinned_post_ids, created_at)
             VALUES ($1, $1, 'Promoted house', '', $2, $3, 'house', 1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NOW())`,
            [late, CREATOR, PROMOTED]
        );

        try {
            expect(await getYourRole(late, PROMOTED)).toBe("owner");
            expect(await getYourRole(late, CREATOR)).toBeNull();
        } finally {
            await pgPool().query("DELETE FROM groups WHERE id = $1", [late]);
        }
    });

    it("is re-runnable, which is what covers the instances that had not drained", async () => {
        const client = await pgClient();
        try {
            await client.query(MIGRATION_SQL);
            const after = await groupRow(HOUSE);
            expect(after.type).toBe("group");
            // Not re-derived from a NULL founder: the second pass must not blank the owner.
            expect(after.owner_id).toBe(PROMOTED);

            // And a house an undrained instance creates AFTER the first pass is converted by the
            // next one — including one whose founder already left, which is the case that carries a
            // different owner from founder.
            const late = `hr_late_${RUN}`;
            await pgPool().query(
                `INSERT INTO groups (id, name, display_name, description, owner_id, founder_id, type, points,
                                     member_ids, moderator_ids, pinned_post_ids, created_at)
                 VALUES ($1, $1, 'A late house', '', $2, $3, 'house', 7, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NOW())`,
                [late, CREATOR, PROMOTED]
            );
            await client.query(MIGRATION_SQL);
            const converted = await groupRow(late);
            expect(converted.type).toBe("group");
            expect(converted.points).toBeNull();
            expect(converted.owner_id).toBe(PROMOTED);
            await pgPool().query("DELETE FROM groups WHERE id = $1", [late]);
        } finally {
            await client.end();
        }
    });
});

describe("contract-drop-house-columns.sql", () => {
    /**
     * The contract step runs LONG after the migration was recorded, and `scripts/migrate.js` skips
     * a recorded file forever — so anything an undrained instance created in the window has never
     * been converted by anything. If the contract dropped `founder_id` on such a row, the promoted
     * founder's claim would be destroyed with it, silently and permanently.
     *
     * Every case here runs the script inside a transaction that is ROLLED BACK: it drops columns
     * the rest of the suite (and the next run of this file) still seeds.
     */
    it("converts a house created after the migration was recorded, THEN drops the columns", async () => {
        const late = `hr_contract_${RUN}`;
        await pgPool().query(
            `INSERT INTO groups (id, name, display_name, description, owner_id, founder_id, type, points,
                                 member_ids, moderator_ids, pinned_post_ids, created_at)
             VALUES ($1, $1, 'Created in the window', '', $2, $3, 'house', 3, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NOW())`,
            [late, CREATOR, PROMOTED]
        );
        await pgPool().query(
            `INSERT INTO group_members (agent_id, group_id, joined_at, is_house)
             VALUES ($1, $2, NOW(), TRUE) ON CONFLICT (agent_id, group_id) DO NOTHING`,
            [PROMOTED, late]
        );

        const client = await pgClient();
        try {
            await client.query("BEGIN");
            await client.query(CONTRACT_SQL);

            // Read inside the transaction: the columns are gone and the ownership survived them.
            const { rows: after } = await client.query(
                `SELECT type, owner_id FROM groups WHERE id = $1`,
                [late]
            );
            expect(after[0].type).toBe("group");
            expect(after[0].owner_id).toBe(PROMOTED);

            const { rows: columns } = await client.query<{ count: string }>(
                `SELECT count(*) AS count FROM information_schema.columns
                 WHERE (table_name = 'groups' AND column_name IN ('founder_id', 'points', 'required_evaluation_ids'))
                    OR (table_name = 'group_members' AND column_name = 'is_house')`
            );
            expect(Number(columns[0].count)).toBe(0);

            // The membership rode through the column drop.
            const { rows: members } = await client.query(
                `SELECT agent_id FROM group_members WHERE group_id = $1`,
                [late]
            );
            expect(members.map((row) => row.agent_id)).toEqual([PROMOTED]);
        } finally {
            await client.query("ROLLBACK").catch(() => { /* already gone */ });
            await client.end();
        }

        // Rolled back: the row is a house again outside the transaction, which is what lets this
        // file run twice.
        expect((await groupRow(late)).type).toBe("house");
        await pgPool().query("DELETE FROM group_members WHERE group_id = $1", [late]);
        await pgPool().query("DELETE FROM groups WHERE id = $1", [late]);
    });
});
