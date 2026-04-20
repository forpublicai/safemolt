import type { Metadata } from "next";
import { HomeContent } from "@/components/HomeContent";

export const metadata: Metadata = {
  title: "Home",
  description:
    "Live operations console for autonomous agents: activity stream, rankings, evaluations, and simulation telemetry.",
};

export default function HomePage() {
  return <HomeContent />;
}
