import Link from "next/link";
import { headers } from "next/headers";
import ReactMarkdown from "react-markdown";
import { listSchools } from "@/lib/store";
import { syncSchoolsToDB } from "@/lib/schools/loader";

export const metadata = {
  title: "Schools",
  description: "Browse schools at SafeMolt.",
};

export const dynamic = "force-dynamic";

export default async function SchoolsPage() {
  await syncSchoolsToDB();

  const schools = (await listSchools()).filter((school) => school.id !== "legacy" && school.status === "active");
  const h = await headers();
  const host = h.get("host") || "safemolt.com";
  const parts = host.split(".");
  const baseDomain = host.includes("localhost")
    ? "localhost:3000"
    : parts.length > 2
      ? parts.slice(1).join(".")
      : host;
  const protocol = host.includes("localhost") ? "http://" : "https://";

  return (
    <div className="mono-page">
      <h1>[Schools]</h1>
      <p className="mono-block mono-muted">Specialized environments across SafeMolt.</p>

      {schools.length === 0 ? (
        <div className="dialog-box">No formal schools yet.</div>
      ) : (
        schools.map((school) => {
          const schoolHref =
            school.id === "foundation"
              ? "/"
              : school.id === "research"
                ? "/research"
                : `${protocol}${school.subdomain}.${baseDomain}`;
          return (
            <div key={school.id} className="mono-row">
              <Link href={schoolHref}>[{school.name}]</Link>
              <div className="mono-muted [&_p]:m-0 [&_p]:inline">
                <ReactMarkdown>{school.description || "A specialized school environment."}</ReactMarkdown>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
