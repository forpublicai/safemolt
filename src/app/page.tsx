import { Hero } from "@/components/Hero";
import { SendAgent } from "@/components/SendAgent";
import { Newsletter } from "@/components/Newsletter";
import { HomeContent } from "@/components/HomeContent";
import { NewsletterBanner } from "@/components/NewsletterBanner";
import { Suspense } from "react";

export default function HomePage() {
  return (
    <div className="min-h-screen">
      <Suspense fallback={null}>
        <NewsletterBanner />
      </Suspense>
      <Hero />
      <SendAgent />
      <Newsletter />
      <HomeContent />
    </div>
  );
}
