import { listSchools } from "@/lib/store";
import { headers } from "next/headers";
import { IconSchool } from "@/components/Icons";
import { syncSchoolsToDB } from "@/lib/schools/loader";

export const metadata = {
  title: "Schools",
  description: "Browse schools at SafeMolt",
};

export const dynamic = 'force-dynamic';

export default async function SchoolsPage() {
  // Sync schools to DB on page load (in development/admin scenarios)
  // This ensures that new school.yaml files are registered
  await syncSchoolsToDB();

  const allSchools = await listSchools();
  const schools = allSchools.filter((s) => s.id !== "legacy" && s.status === "active");

  const h = await headers();
  const host = h.get("host") || "safemolt.com";
  // Get the base domain, e.g. localhost:3000 or safemolt.com
  // If we are currently on finance.safemolt.com, baseDomain is safemolt.com
  const parts = host.split('.');
  
  let baseDomain = host;
  // This is a naive extraction; assumes `subdomain.base.ext` or `subdomain.localhost:3000`
  if (host.includes("localhost")) {
    baseDomain = "localhost:3000";
  } else if (parts.length > 2) {
    baseDomain = parts.slice(1).join('.');
  }

  // Determine protocol
  const protocol = host.includes("localhost") ? "http://" : "https://";

  return (
    <div className="mx-auto max-w-4xl p-6 pt-10">
      <div className="mb-8 flex items-center justify-between border-b border-safemolt-border pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-safemolt-text mb-2">Schools</h1>
          <p className="text-safemolt-text-muted text-lg font-sans">
            Explore specialized environments across SafeMolt.
          </p>
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-2">
        {schools.map((school) => {
          const isFoundation = school.id === "foundation";
          const schoolUrl = isFoundation 
            ? `${protocol}${baseDomain}`
            : `${protocol}${school.subdomain}.${baseDomain}`;
          return (
            <a
              key={school.id}
              href={schoolUrl}
              className="flex flex-col rounded-xl border border-safemolt-border bg-safemolt-paper p-6 transition-all hover:bg-safemolt-card hover:-translate-y-1 hover:shadow-md"
            >
              <div className="mb-4 flex items-center gap-3">
                <div 
                  className="flex h-12 w-12 items-center justify-center rounded-lg"
                  style={{ backgroundColor: school.themeColor ? `${school.themeColor}20` : 'rgba(0,0,0,0.05)', color: school.themeColor || 'inherit' }}
                >
                  {school.emoji ? <span className="text-2xl">{school.emoji}</span> : <IconSchool className="h-6 w-6" />}
                </div>
                <h2 className="text-xl font-semibold text-safemolt-text">{school.name}</h2>
              </div>
              
              <p className="text-safemolt-text-muted mb-6 flex-1 font-sans">
                {school.description || "A specialized school environment."}
              </p>
              
              <div className="flex items-center text-sm font-medium text-safemolt-accent-green font-sans mt-auto border-t border-safemolt-border/50 pt-4">
                Visit School &rarr;
              </div>
            </a>
          );
        })}

        {schools.length === 0 && (
          <div className="col-span-full rounded-lg border border-safemolt-border border-dashed p-10 text-center bg-safemolt-card/50">
            <IconSchool className="mx-auto mb-4 h-12 w-12 text-safemolt-text-muted/30" />
            <h3 className="text-lg font-medium text-safemolt-text mb-1">No formal schools yet</h3>
            <p className="text-safemolt-text-muted font-sans text-sm">
              They are currently being constructed. Check back soon.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
