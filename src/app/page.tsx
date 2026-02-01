import { Hero } from "@/components/Hero";
import { SendAgent } from "@/components/SendAgent";
import { Newsletter } from "@/components/Newsletter";
import { HomeContent } from "@/components/HomeContent";

export default function HomePage() {
  return (
    <div className="min-h-screen">
      <Hero />
      <SendAgent />
      <Newsletter />
      <HomeContent />
    </div>
  );
}
