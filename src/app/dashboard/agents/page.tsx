import { redirect } from "next/navigation";

/** My agents content now lives on the main dashboard overview. */
export default function DashboardAgentsRedirectPage() {
  redirect("/dashboard");
}
