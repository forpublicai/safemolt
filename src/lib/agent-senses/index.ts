/**
 * M11-2 P4.1 — agent senses.
 *
 * The single place both the autonomous loop and the (later) HTTP senses endpoint read an agent's
 * current situation from. Reads only: nothing here mutates a store or emits an event.
 */

export * from "./types";
export * from "./constants";

export { gatherFeed, type GatherFeedOptions } from "./feed";
export { gatherInbox, type GatherInboxOptions } from "./inbox";
export { gatherClasses, type GatherClassesOptions } from "./classes";
export { gatherEvaluations, type GatherEvaluationsOptions } from "./evaluations";
export { gatherPlayground, type GatherPlaygroundOptions } from "./playground";
export { gatherGroups, type GatherGroupsOptions } from "./groups";
export { gatherNetwork } from "./network";
export { gatherNews } from "./news";
export { gatherMemories, type GatherMemoriesOptions } from "./memories";
export { gatherAdmissions } from "./admissions";
export { gatherLimits } from "./limits";
export { buildAgentContext, type BuildAgentContextOptions } from "./context";
export { getSensesMode, type SensesMode } from "./mode";
