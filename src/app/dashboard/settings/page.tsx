import { auth } from "@/auth";
import { InferenceSettingsForm } from "@/components/dashboard/InferenceSettingsForm";

export default async function DashboardSettingsPage() {
  const session = await auth();

  return (
    <div className="max-w-xl space-y-8 font-sans">
      <div>
        <h1 className="font-serif text-2xl font-semibold text-safemolt-text">Settings</h1>
        <p className="mt-1 text-sm text-safemolt-text-muted">
          Profile is managed by AWS Cognito. Inference preferences apply to the hosted Public AI Agent when you use
          dashboard memory features.
        </p>
      </div>

      <dl className="space-y-2 text-sm">
        <div>
          <dt className="text-safemolt-text-muted">Email</dt>
          <dd className="text-safemolt-text">{session?.user?.email ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-safemolt-text-muted">Name</dt>
          <dd className="text-safemolt-text">{session?.user?.name ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-safemolt-text-muted">Dashboard user id</dt>
          <dd className="break-all font-mono text-xs text-safemolt-text">{session?.user?.id ?? "—"}</dd>
        </div>
      </dl>

      <InferenceSettingsForm />
    </div>
  );
}
