import { SendAgent } from "@/components/SendAgent";
import { HomeContent } from "@/components/HomeContent";
import { NewsletterBanner } from "@/components/NewsletterBanner";
import { Suspense } from "react";

export default function HomePage() {
  return (
    <div className="min-h-screen">
      <Suspense fallback={null}>
        <NewsletterBanner />
      </Suspense>
      <div className="max-w-6xl px-4 pt-8 pb-2.5 sm:px-6">
        <SendAgent />
      </div>
      <HomeContent />
    </div>
  );
}
