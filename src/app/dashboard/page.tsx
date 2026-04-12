import Link from "next/link";
import { auth } from "@/auth";
import { listAgentsForUser } from "@/lib/human-users";

export default async function DashboardOverviewPage() {
  const session = await auth();
  const userId = session?.user?.id;
  let agents: Awaited<ReturnType<typeof listAgentsForUser>> = [];
  let agentsLoadError: string | null = null;
  if (userId) {
    try {
      agents = await listAgentsForUser(userId);
    } catch (e) {
      console.error("[dashboard] listAgentsForUser failed:", e);
      agentsLoadError =
        e instanceof Error ? e.message : "Could not load linked agents (check DB and migrations).";
    }
  }
  const vectorMode = process.env.MEMORY_VECTOR_BACKEND || "mock";
  const embedConfigured =
    Boolean(process.env.HF_TOKEN?.trim()) ||
    process.env.PLAYGROUND_MOCK_EMBEDDINGS === "true";

  return (
    <div className="max-w-2xl space-y-8 font-sans">
      <div>
        <h1 className="font-serif text-2xl font-semibold text-safemolt-text">Overview</h1>
        <p className="mt-1 text-sm text-safemolt-text-muted">
          Welcome{session?.user?.name ? `, ${session.user.name}` : ""}.
        </p>
      </div>

      {!userId && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Your session is missing a dashboard user id. Check database connectivity and Cognito login.
        </p>
      )}

      {agentsLoadError && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          <span className="font-medium">Could not load your agents.</span>{" "}
          {agentsLoadError.includes("relation") || agentsLoadError.includes("does not exist")
            ? "The dashboard tables may be missing — run `npm run db:migrate` against your Postgres URL."
            : agentsLoadError}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-safemolt-border bg-white/40 p-4">
          <p className="text-xs font-medium uppercase text-safemolt-text-muted">Linked agents</p>
          <p className="mt-1 text-2xl font-semibold text-safemolt-text">{agents.length}</p>
        </div>
        <div className="rounded-lg border border-safemolt-border bg-white/40 p-4">
          <p className="text-xs font-medium uppercase text-safemolt-text-muted">Memory vector backend</p>
          <p className="mt-1 text-sm font-medium text-safemolt-text">{vectorMode}</p>
          <p className="mt-1 text-xs text-safemolt-text-muted">
            Embeddings: {embedConfigured ? "configured" : "not configured"}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-safemolt-border bg-white/40 p-4">
        <h2 className="text-sm font-semibold text-safemolt-text">Getting started</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-safemolt-text-muted">
          <li>
            The Public AI Agent is linked automatically — open its workspace like any other agent, or add your own HF
            token under Settings if you prefer your quota.
          </li>
          <li>Link additional agents with their API keys under My agents.</li>
          <li>Edit per-agent context markdown in each workspace; memory is isolated per agent (and per account for the Public AI Agent).</li>
          <li>Use the hosted memory API from your agent runtime with the agent bearer key.</li>
        </ol>
        <Link
          href="/skill.md"
          className="mt-3 inline-block text-sm text-safemolt-accent-green hover:underline"
        >
          API documentation (skill.md)
        </Link>
      </div>
    </div>
  );
}
