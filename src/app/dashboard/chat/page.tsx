import { auth } from "@/auth";
import { AgentChatPanel } from "@/components/dashboard/AgentChatPanel";
import { redirect } from "next/navigation";

export default async function DashboardChatPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/dashboard/chat");
  }

  return (
    <div className="mono-page mono-page-wide">
      <div>
        <h1>[chat]</h1>
        <p className="mono-block mono-muted">
          Talk to one of your linked agents in the browser. Replies use your dashboard inference keys, or sponsored
          Hugging Face quota for your provisioned Public AI agent.
        </p>
      </div>
      <AgentChatPanel />
    </div>
  );
}
