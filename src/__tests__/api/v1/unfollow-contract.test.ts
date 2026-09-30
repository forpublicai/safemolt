/**
 * M11-1 C16 — the unfollow fix is invisible unless both public adapters report it.
 *
 * The store change alone is not the deliverable: the route discarded the store's return value and
 * always answered success, and the tool did the same. So an attacker walking a stranger's follower
 * count down got a 200 every time, and any test asserting only on the store would have passed while
 * the exploit stayed fully usable from outside.
 *
 * No mocks: Jest runs with no database, so `@/lib/store` *is* the memory store, and these exercise
 * the real handler with a real API key.
 *
 * @jest-environment node
 */
import { DELETE } from "@/app/api/v1/agents/[name]/follow/route";
import { executors } from "@/lib/agent-tools/definitions/agents";
import { createAgent, followAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import type { StoredAgent } from "@/lib/store-types";
import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

async function vettedAgent(name: string): Promise<StoredAgent> {
  const created = await createAgent(name, `${name} description`);
  await setAgentVetted(created.id, `# ${name}\n`);
  return (await getAgentById(created.id))!;
}

function unfollowRequest(agent: StoredAgent, target: string): Request {
  return new Request(`https://safemolt.com/api/v1/agents/${target}/follow`, withMiddlewareHeaders({
    method: "DELETE",
    headers: { Authorization: `Bearer ${agent.apiKey}` },
  }));
}

describe("DELETE /api/v1/agents/{name}/follow", () => {
  it("answers 404 not_following when nothing was removed, and moves no counter", async () => {
    const target = await vettedAgent(`c16r_target_${Date.now()}`);
    const admirer = await vettedAgent(`c16r_admirer_${Date.now()}`);
    const attacker = await vettedAgent(`c16r_attacker_${Date.now()}`);
    await followAgent(admirer.id, target.name);

    const response = await DELETE(
      unfollowRequest(attacker, target.name) as never,
      { params: Promise.resolve({ name: target.name }) }
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error_detail.code).toBe("not_following");
    expect((await getAgentById(target.id))!.followerCount).toBe(1);
  });

  it("gives an unknown name the same 404 not_following, with no name-existence signal", async () => {
    const attacker = await vettedAgent(`c16r_prober_${Date.now()}`);
    const missing = `no_such_agent_${Date.now()}`;

    const response = await DELETE(
      unfollowRequest(attacker, missing) as never,
      { params: Promise.resolve({ name: missing }) }
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error_detail.code).toBe("not_following");
  });

  it("still reports success for a real unfollow, exactly once", async () => {
    const target = await vettedAgent(`c16r_target2_${Date.now()}`);
    const follower = await vettedAgent(`c16r_follower2_${Date.now()}`);
    await followAgent(follower.id, target.name);

    const first = await DELETE(
      unfollowRequest(follower, target.name) as never,
      { params: Promise.resolve({ name: target.name }) }
    );
    expect(first.status).toBe(200);
    expect((await getAgentById(target.id))!.followerCount).toBe(0);

    // The repeat is the exploit: before C16 it answered 200 and took another point off.
    const second = await DELETE(
      unfollowRequest(follower, target.name) as never,
      { params: Promise.resolve({ name: target.name }) }
    );
    expect(second.status).toBe(404);
    expect((await getAgentById(target.id))!.followerCount).toBe(0);
  });
});

describe("unfollow_agent tool", () => {
  it("returns the same refusal the route does", async () => {
    const target = await vettedAgent(`c16t_target_${Date.now()}`);
    const admirer = await vettedAgent(`c16t_admirer_${Date.now()}`);
    const attacker = await vettedAgent(`c16t_attacker_${Date.now()}`);
    await followAgent(admirer.id, target.name);

    const result = await executors.unfollow_agent({ agent_name: target.name }, { agent: attacker });

    expect(result.success).toBe(false);
    expect((result.data as { code: string }).code).toBe("not_following");
    expect((await getAgentById(target.id))!.followerCount).toBe(1);
  });

  it("gives an unknown name the same refusal, so it cannot test whether a name exists", async () => {
    // The route collapses "no such agent" and "not following it" on purpose. The tool used to
    // answer them apart, which reopened the enumeration oracle on the other surface.
    const attacker = await vettedAgent(`c16t_prober_${Date.now()}`);

    const result = await executors.unfollow_agent(
      { agent_name: `no_such_agent_${Date.now()}` },
      { agent: attacker }
    );

    expect(result.success).toBe(false);
    expect((result.data as { code: string }).code).toBe("not_following");
  });

  it("still succeeds for a relationship that exists", async () => {
    const target = await vettedAgent(`c16t_target2_${Date.now()}`);
    const follower = await vettedAgent(`c16t_follower2_${Date.now()}`);
    await followAgent(follower.id, target.name);

    const result = await executors.unfollow_agent({ agent_name: target.name }, { agent: follower });

    expect(result.success).toBe(true);
    expect((await getAgentById(target.id))!.followerCount).toBe(0);
  });
});
