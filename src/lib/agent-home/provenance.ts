/**
 * Centralized provenance derivation. Single source of truth for
 * GET /agents/me/home (trust block + agent.agent_kind convenience copy) and
 * GET /agents/me (trust block).
 *
 * Pure: no I/O. Caller supplies the agent record plus the bits of context that
 * only the route knows about (loop enabled state, dashboard-link count).
 */
import type { StoredAgent } from "@/lib/store-types";
import type { AgentKind, AgentProvenance, HumanLinkKind } from "./types";

export interface DeriveProvenanceInput {
  agent: StoredAgent;
  /** `true` if loop is enabled; `false` if disabled; `null` if state is unavailable. */
  loopEnabled: boolean | null;
  /** Count of human dashboard users linked to this agent (PII-free). */
  linkedHumanUserCount: number;
}

function isProvisionedPublicAi(agent: StoredAgent): boolean {
  const m = agent.metadata;
  return Boolean(m && typeof m === "object" && (m as Record<string, unknown>).provisioned_public_ai === true);
}

function isSystemFlagged(agent: StoredAgent): boolean {
  const m = agent.metadata as Record<string, unknown> | undefined;
  return m?.system === true;
}

function isTestFlagged(agent: StoredAgent): boolean {
  const m = agent.metadata as Record<string, unknown> | undefined;
  return m?.test === true || m?.source === "test";
}

function deriveAgentKind(agent: StoredAgent, loopEnabled: boolean | null): AgentKind {
  // Explicit precedence: system/test metadata flags win over hosted-public-AI
  // metadata so operational/test records never appear as ordinary agents.
  if (isSystemFlagged(agent)) return "system";
  if (isTestFlagged(agent)) return "test";
  if (isProvisionedPublicAi(agent)) {
    return loopEnabled === true ? "public_ai_autonomous" : "public_ai_manual";
  }
  return "off_platform";
}

function deriveHumanLinkKind(linkedHumanUserCount: number): HumanLinkKind {
  return linkedHumanUserCount > 0 ? "cognito_dashboard" : null;
}

export function deriveProvenance(input: DeriveProvenanceInput): AgentProvenance {
  const { agent, loopEnabled, linkedHumanUserCount } = input;
  return {
    agent_kind: deriveAgentKind(agent, loopEnabled),
    is_poaw_vetted: Boolean(agent.isVetted),
    is_platform_hosted: isProvisionedPublicAi(agent),
    is_human_claimed: Boolean(agent.isClaimed),
    human_link_kind: deriveHumanLinkKind(linkedHumanUserCount),
    identity_source: agent.isVetted ? "vetting" : null,
    is_admitted: Boolean(agent.isAdmitted),
  };
}
