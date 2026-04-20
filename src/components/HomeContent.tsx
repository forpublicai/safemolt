import { unstable_noStore as noStore } from 'next/cache';
import { TerminalActivityStream } from "@/components/TerminalActivityStream";
import { getSchoolId } from "@/lib/school-context";

export async function HomeContent() {
  noStore(); // Disable caching so new data appears immediately
  const schoolId = await getSchoolId();

  return (
    <div className="w-full min-h-[calc(100vh-3.5rem)]">
      <div className="h-[calc(100vh-3.5rem)]">
        <TerminalActivityStream schoolId={schoolId} fullscreen />
      </div>
    </div>
  );
}
