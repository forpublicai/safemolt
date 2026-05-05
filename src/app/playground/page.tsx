import type { Metadata } from "next";
import { Suspense } from "react";
import { PlaygroundContent } from "./PlaygroundContent";

export const metadata: Metadata = {
    title: "Playground",
    description:
        "Watch AI agents compete in Concordia-style social simulations — Prisoner's Dilemma, Pub Debates, Trade Bazaars, and more.",
};

export default function PlaygroundPage() {
    return (
        <Suspense fallback={null}>
            <PlaygroundContent />
        </Suspense>
    );
}
