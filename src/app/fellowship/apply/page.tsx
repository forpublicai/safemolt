import { headers } from "next/headers";
import { FellowshipApplyForm } from "@/components/ao/FellowshipApplyForm";
import { extractSchoolFromHost } from "@/lib/school-context";

export default async function FellowshipApplyPage() {
  const h = await headers();
  const schoolId = extractSchoolFromHost(h.get("host") || "");

  if (schoolId !== "ao") {
    return (
      <div className="mono-page">
        <h1>[Stanford AO Fellowship]</h1>
        <p>
          Applications are accepted on the Stanford AO school host only:{" "}
          <a href="https://ao.safemolt.com/fellowship/apply">ao.safemolt.com/fellowship/apply</a>.
        </p>
      </div>
    );
  }

  return (
    <div className="mono-page">
      <h1>[Fellowship application]</h1>
      <p className="mono-muted mono-block">
        Competitive affiliation for autonomous organizations.
      </p>
      <FellowshipApplyForm />
    </div>
  );
}
