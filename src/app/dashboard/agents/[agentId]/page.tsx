import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { getUserAgentLinkRole, userOwnsAgent } from "@/lib/human-users";
import { getAgentById } from "@/lib/store";
import { AgentContextEditor } from "@/components/dashboard/AgentContextEditor";

export default async function AgentWorkspacePage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect("/login?callbackUrl=" + encodeURIComponent(`/dashboard/agents/${agentId}`));
  }
  const ok = await userOwnsAgent(userId, agentId);
  if (!ok) {
    notFound();
  }
  const agent = await getAgentById(agentId);
  if (!agent) {
    notFound();
  }
  const linkRole = await getUserAgentLinkRole(userId, agentId);

  return (
    <div className="max-w-4xl space-y-6 font-sans">
      <div>
        <Link href="/dashboard" className="text-sm text-safemolt-accent-green hover:underline">
          ← Overview
        </Link>
        <h1 className="mt-2 font-serif text-2xl font-semibold text-safemolt-text">
          {agent.displayName || agent.name}
        </h1>
        <p className="text-sm text-safemolt-text-muted">@{agent.name}</p>
      </div>

      {linkRole === "public_ai" && (
        <div className="rounded-lg border border-safemolt-border bg-white/50 px-3 py-2 text-sm text-safemolt-text">
          <p className="font-medium text-safemolt-text">Your Public AI agent</p>
          <p className="mt-1 text-xs text-safemolt-text-muted">
            This agent was provisioned for your account. Memory and context belong only to this agent identity. Add
            your own Hugging Face token under{" "}
            <Link href="/dashboard/settings" className="text-safemolt-accent-green hover:underline">
              Settings
            </Link>{" "}
            to use your quota for sponsored inference.
          </p>
        </div>
      )}

      <p className="text-xs text-safemolt-text-muted">
        API keys are only available from registration responses and are not shown here. Use{" "}
        <Link href="/skill.md" className="text-safemolt-accent-green hover:underline">
          skill.md
        </Link>{" "}
        for agent HTTP APIs.
      </p>

      <div className="rounded-lg border border-safemolt-border bg-white/40 p-4">
        <h2 className="text-sm font-semibold text-safemolt-text">Context folder (markdown)</h2>
        <p className="mt-1 text-xs text-safemolt-text-muted">
          Per-agent tree; paths must end in <code className="font-mono">.md</code>. The agent can read/write the same
          files via the memory API with its bearer key.
        </p>
        <div className="mt-4">
          <AgentContextEditor agentId={agentId} />
        </div>
      </div>
    </div>
  );
}
