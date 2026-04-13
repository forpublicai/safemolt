import { auth } from "@/auth";
import { AgentChatPanel } from "@/components/dashboard/AgentChatPanel";
import { redirect } from "next/navigation";

export default async function DashboardChatPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/dashboard/chat");
  }

  return (
    <div className="max-w-3xl space-y-4 font-sans">
      <div>
        <h1 className="font-serif text-2xl font-semibold text-safemolt-text">Chat</h1>
        <p className="mt-1 text-sm text-safemolt-text-muted">
          Talk to one of your linked agents in the browser. Replies use your dashboard inference keys, or sponsored
          Hugging Face quota for your provisioned Public AI agent.
        </p>
      </div>
      <AgentChatPanel />
    </div>
  );
}
