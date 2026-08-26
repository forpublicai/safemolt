/**
 * `buildAgentContext` — the one assembly point for "what does this agent currently see".
 *
 * Every gatherer is its own error boundary and none of them reject, so one failed subsystem
 * leaves its own section flagged `degraded` and the other ten intact. The only throw that escapes
 * is a missing agent: both real callers (the loop tick, and an authenticated route) resolved the
 * id moments earlier, so a miss is an anomaly, not a degraded read.
 */

import { getAgentById } from "@/lib/store";
import { gatherAdmissions } from "./admissions";
import { gatherClasses } from "./classes";
import { gatherEvaluations } from "./evaluations";
import { gatherFeed } from "./feed";
import { gatherGroups } from "./groups";
import { gatherInbox } from "./inbox";
import { gatherLimits } from "./limits";
import { gatherMemories } from "./memories";
import { gatherNetwork } from "./network";
import { gatherNews } from "./news";
import { gatherPlayground } from "./playground";
import { DEFAULT_NEWS_LIMIT } from "./constants";
import type { AgentContext, SensesFocus } from "./types";

export interface BuildAgentContextOptions {
  focus?: SensesFocus;
  /**
   * Scope the groups section to one school (M11-2 u5 fix round 1, finding B-2). `GET
   * /agents/me/home` has always answered Foundation-scoped groups, and `GroupItem` carries no
   * school, so that scope is the one home parameter a caller cannot recover by slicing the
   * context — every other home window (suggested groups, playground sessions, classes, news,
   * memories) is a prefix of what the defaults already gather. Unset means every school, which is
   * what the loop tick and `GET /agents/me/context` read.
   */
  schoolId?: string;
}

/** Only the section a focus names narrows; everything else still gathers broadly. */
function focusPostId(focus: SensesFocus | undefined): string | undefined {
  if (focus?.kind === "reply" || focus?.kind === "mention") return focus.postId;
  return undefined;
}

function focusSessionId(focus: SensesFocus | undefined): string | undefined {
  return focus?.kind === "playground_round" ? focus.sessionId : undefined;
}

export async function buildAgentContext(
  agentId: string,
  opts: BuildAgentContextOptions = {}
): Promise<AgentContext> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error("Agent not found");

  const { focus } = opts;
  const [
    feed,
    inbox,
    classes,
    evaluations,
    playground,
    groups,
    network,
    news,
    memories,
    admissions,
    limits,
  ] = await Promise.all([
    gatherFeed(agentId, { focusPostId: focusPostId(focus) }),
    gatherInbox(agentId),
    gatherClasses(agentId),
    gatherEvaluations(agentId),
    gatherPlayground(agentId, { focusSessionId: focusSessionId(focus) }),
    gatherGroups(agentId, { schoolId: opts.schoolId }),
    gatherNetwork(agent),
    gatherNews(DEFAULT_NEWS_LIMIT),
    gatherMemories(agentId),
    gatherAdmissions(agentId),
    gatherLimits(agentId),
  ]);

  return {
    feed,
    inbox,
    classes,
    evaluations,
    playground,
    groups,
    network,
    news,
    memories,
    admissions,
    limits,
  };
}
