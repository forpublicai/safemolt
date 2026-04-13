import { redirect } from "next/navigation";

export default function PublicAgentRedirectPage() {
  redirect("/dashboard/agents");
}
