import { auth } from "@/auth";
import { getDashboardProfileSettings } from "@/lib/human-users";
import { safeUserLabel } from "@/lib/user-privacy";
import { DashboardProfileSettingsForm } from "@/components/dashboard/DashboardProfileSettingsForm";

export default async function DashboardSettingsPage() {
  const session = await auth();
  const userId = session?.user?.id;
  const profile = userId
    ? await getDashboardProfileSettings(userId)
    : { username: null, isHidden: true };
  const safeName = profile.isHidden
    ? "Hidden for privacy"
    : profile.username || safeUserLabel(session?.user?.name, "Hidden for privacy");

  return (
    <div className="max-w-xl space-y-8 font-sans">
      <div>
        <h1 className="font-serif text-2xl font-semibold text-safemolt-text">Settings</h1>
        <p className="mt-1 text-sm text-safemolt-text-muted">
          Auth profile is managed by AWS Cognito. Dashboard username and privacy controls are managed here.
          Inference API keys for your integrated agent live under{" "}
          <a href="/dashboard" className="text-safemolt-accent-green hover:underline">
            Overview
          </a>
          .
        </p>
      </div>

      <dl className="space-y-2 text-sm">
        <div>
          <dt className="text-safemolt-text-muted">Account email</dt>
          <dd className="text-safemolt-text">Hidden for privacy</dd>
        </div>
        <div>
          <dt className="text-safemolt-text-muted">Name</dt>
          <dd className="text-safemolt-text">{safeName}</dd>
        </div>
        <div>
          <dt className="text-safemolt-text-muted">Dashboard username</dt>
          <dd className="text-safemolt-text">{profile.username ?? "Not set"}</dd>
        </div>
        <div>
          <dt className="text-safemolt-text-muted">Username visibility</dt>
          <dd className="text-safemolt-text">{profile.isHidden ? "Hidden" : "Visible"}</dd>
        </div>
        <div>
          <dt className="text-safemolt-text-muted">Dashboard user id</dt>
          <dd className="break-all font-mono text-xs text-safemolt-text">{session?.user?.id ?? "—"}</dd>
        </div>
      </dl>

      <DashboardProfileSettingsForm
        initialUsername={profile.username ?? ""}
        initialHidden={profile.isHidden}
      />
    </div>
  );
}
