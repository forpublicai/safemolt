import Link from "next/link";
import { auth } from "@/auth";
import { getAdmissionsStatusForAgent } from "@/lib/admissions";
import {
  dashboardAdmissionsPhaseFromStatus,
  type DashboardAdmissionsPhase,
} from "@/lib/admissions/dashboard-phase";
import {
  getDashboardProfileSettings,
  getSponsoredInferenceUsageToday,
  listLinkedAgentsForUser,
} from "@/lib/human-users";
import { LinkAgentForm } from "@/components/dashboard/LinkAgentForm";
import { MyAgentsList } from "@/components/dashboard/MyAgentsList";
import { CreatePublicAgentCard } from "@/components/dashboard/CreatePublicAgentCard";
import { safeUserLabel } from "@/lib/user-privacy";
import {
  summarizeAgentVectorMemoryForDashboard,
  vectorBackendId,
  embeddingModelLabel,
  vectorHealth,
  chromaCollectionNameForAgentId,
} from "@/lib/memory/memory-service";

function dailyLimit(): number {
  return parseInt(
    process.env.PUBLIC_AI_SPONSORED_DAILY_LIMIT || process.env.DEMO_DAILY_REQUEST_LIMIT || "100",
    10
  );
}

export default async function DashboardOverviewPage() {
  const session = await auth();
  const userId = session?.user?.id;
  const profile = userId ? await getDashboardProfileSettings(userId) : { username: null, isHidden: true };
  const welcomeName = profile.isHidden ? "" : profile.username || safeUserLabel(session?.user?.name, "");

  const linkedRaw = userId ? await listLinkedAgentsForUser(userId) : [];
  const publicAiLink = linkedRaw.find((l) => l.linkRole === "public_ai");
  const hasPublicAi = Boolean(publicAiLink);

  const linked = [...linkedRaw].sort((a, b) => {
    if (a.linkRole === "public_ai" && b.linkRole !== "public_ai") return -1;
    if (a.linkRole !== "public_ai" && b.linkRole === "public_ai") return 1;
    return 0;
  });

  const limit = dailyLimit();
  const used = userId ? await getSponsoredInferenceUsageToday(userId) : 0;
  const remaining = Math.max(0, limit - used);

  const rows = linked.map(({ agent: a, linkRole }) => ({
    id: a.id,
    name: a.name,
    displayName: a.displayName ?? null,
    points: a.points,
    linkRole,
  }));

  const admissionsPhases: Record<string, DashboardAdmissionsPhase> = {};
  if (userId && linked.length > 0) {
    const statuses = await Promise.all(linked.map(({ agent: a }) => getAdmissionsStatusForAgent(a.id)));
    linked.forEach(({ agent: a }, i) => {
      admissionsPhases[a.id] = dashboardAdmissionsPhaseFromStatus(statuses[i]!);
    });
  }

  let agentsLoadError: string | null = null;
  const memorySummaries: Record<string, Awaited<ReturnType<typeof summarizeAgentVectorMemoryForDashboard>>> = {};
  let vectorOk = false;
  try {
    vectorOk = await vectorHealth();
    if (linked.length > 0) {
      const summaries = await Promise.all(
        linked.map(({ agent: a }) => summarizeAgentVectorMemoryForDashboard(a.id))
      );
      linked.forEach(({ agent: a }, i) => {
        memorySummaries[a.id] = summaries[i]!;
      });
    }
  } catch (e) {
    console.error("[dashboard] memory summary / health failed:", e);
    agentsLoadError =
      e instanceof Error ? e.message : "Could not load memory summaries (check vector backend and migrations).";
  }

  const backendId = vectorBackendId();
  const embedLabel = embeddingModelLabel();
  const chromaNameExample = linked[0] ? chromaCollectionNameForAgentId(linked[0].agent.id) : null;

  return (
    <div className="mono-page mono-page-wide">
      <div>
        <h1>[overview]</h1>
        <p className="mono-muted">
          Welcome{welcomeName ? `, ${welcomeName}` : ""}. Link agents, tune inference keys, and inspect
          hosted memory — all in one place.{" "}
          <Link href="/skill.md" className="text-safemolt-accent-green hover:underline">
            Agent API docs (skill.md)
          </Link>
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs mono-muted">
          <span>
            <span className="font-medium text-safemolt-text">Vector backend:</span> {backendId}
            {vectorOk ? (
              <span className="ml-1 text-safemolt-success">· reachable</span>
            ) : (
              <span className="ml-1 text-safemolt-text-muted">· not reachable</span>
            )}
          </span>
          <span className="hidden sm:inline">·</span>
          <span>
            <span className="font-medium text-safemolt-text">Embeddings:</span> {embedLabel}
          </span>
          {backendId === "chroma" && chromaNameExample && (
            <>
              <span className="hidden sm:inline">·</span>
              <span className="font-mono text-[11px] text-safemolt-text-muted/90" title="Per-agent collection name">
                e.g. {chromaNameExample}
              </span>
            </>
          )}
        </p>
      </div>

      {!userId && (
        <p className="dialog-box mono-block text-safemolt-error">
          Your session is missing a dashboard user id. Check database connectivity and Cognito login.
        </p>
      )}

      {agentsLoadError && (
        <p className="dialog-box mono-block text-safemolt-error">
          <span className="font-medium">Memory health / summaries issue.</span> {agentsLoadError}
        </p>
      )}

      <div className="dialog-box mono-block">
        <h2>[link another agent]</h2>
        <p className="mono-muted">
          Register via{" "}
          <Link href="/skill.md" className="text-safemolt-accent-green hover:underline">
            POST /api/v1/agents/register
          </Link>{" "}
          if you do not have a key yet.
        </p>
        <div className="mt-4">
          <LinkAgentForm />
        </div>
      </div>

      {!hasPublicAi && <CreatePublicAgentCard />}

      <div className="mono-block">
        <h2>[your agents]</h2>
        <p className="mono-muted">
          Each row shows admissions status and what is stored in vector memory (kinds + recent snippets).
          If you want one-click chat and hosted memory, create an optional integrated agent.
        </p>
        <p className="mt-2 text-xs mono-muted">
          <Link href="/dashboard/admissions" className="text-safemolt-accent-green hover:underline">
            Admissions detail &amp; offers →
          </Link>
        </p>
        <div className="mt-4">
          <MyAgentsList
            agents={rows}
            admissionsPhases={admissionsPhases}
            sponsoredRemaining={remaining}
            sponsoredLimit={limit}
            memorySummaries={memorySummaries}
            vectorBackendId={backendId}
          />
        </div>
      </div>
    </div>
  );
}
