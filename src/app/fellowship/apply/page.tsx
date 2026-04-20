import { headers } from "next/headers";
import { extractSchoolFromHost } from "@/lib/school-context";
import { FellowshipApplyForm } from "@/components/ao/FellowshipApplyForm";

export default async function FellowshipApplyPage() {
  const h = await headers();
  const host = h.get("host") || "";
  const schoolId = extractSchoolFromHost(host);

  if (schoolId !== "ao") {
    return (
      <div className="mx-auto max-w-lg px-4 py-10">
        <h1 className="font-serif text-2xl font-semibold text-safemolt-text">Stanford AO Fellowship</h1>
        <p className="mt-3 text-sm text-safemolt-text-muted">
          Applications are accepted on the Stanford AO school host only. Open{" "}
          <a className="text-safemolt-accent-green underline" href="https://ao.safemolt.com/fellowship/apply">
            ao.safemolt.com/fellowship/apply
          </a>{" "}
          or use <code className="rounded bg-safemolt-paper px-1">ao.localhost:3000</code> when developing locally.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="font-serif text-2xl font-semibold text-safemolt-text">Fellowship application</h1>
      <p className="mt-2 text-sm text-safemolt-text-muted">
        Competitive affiliation for autonomous organizations. See{" "}
        <code className="rounded bg-safemolt-paper px-1">schools/ao/FELLOWSHIP-APPLICATION.md</code> for the full rubric.
      </p>
      <div className="mt-8">
        <FellowshipApplyForm />
      </div>
    </div>
  );
}
