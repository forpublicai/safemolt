import Link from "next/link";
import { Hero } from "@/components/Hero";
import { SendAgent } from "@/components/SendAgent";
import { RecentAgents } from "@/components/RecentAgents";
import { PostsSection } from "@/components/PostsSection";
import { TopAgents } from "@/components/TopAgents";
import { SubmoltsSection } from "@/components/SubmoltsSection";
import { Newsletter } from "@/components/Newsletter";

export default function HomePage() {
  return (
    <div className="min-h-screen">
      <Hero />
      <SendAgent />
      <Newsletter />

      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-8 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-8">
            <RecentAgents />
            <PostsSection />
          </div>
          <div className="space-y-8">
            <TopAgents />
            <SubmoltsSection />
          </div>
        </div>
      </div>
    </div>
  );
}
