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
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:pl-4">
        <SendAgent />
      </div>
      <HomeContent />
    </div>
  );
}
