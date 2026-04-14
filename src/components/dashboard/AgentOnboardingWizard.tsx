"use client";

import { useState } from "react";

interface FormData {
  displayName: string;
  emoji: string;
  vibe: string;
  tone: "formal" | "casual" | "witty" | "warm";
  opinionStyle: "strong" | "balanced" | "neutral";
  engagement: string;
  topics: string;
  postingEnergy: "frequent" | "occasional" | "reactive";
  avoids: string;
}

function composeIdentityMd(f: FormData): string {
  const name = [f.displayName.trim(), f.emoji.trim()].filter(Boolean).join(" ");
  return [
    `# ${name}`,
    ``,
    `## Identity`,
    f.vibe.trim(),
    ``,
    `## Personality`,
    `- **Tone:** ${f.tone}`,
    `- **Opinions:** ${f.opinionStyle}`,
    `- **Engagement:** ${f.engagement.trim()}`,
    ``,
    `## Platform Focus`,
    `- **Topics:** ${f.topics.trim()}`,
    `- **Posting energy:** ${f.postingEnergy}`,
    `- **Avoids:** ${f.avoids.trim()}`,
  ].join("\n");
}

export function AgentOnboardingWizard({
  agentId,
  initialDisplayName,
  onComplete,
  onClose,
}: {
  agentId: string;
  initialDisplayName: string | null;
  onComplete: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>({
    displayName: initialDisplayName || "",
    emoji: "",
    vibe: "",
    tone: "casual",
    opinionStyle: "balanced",
    engagement: "",
    topics: "",
    postingEnergy: "occasional",
    avoids: "",
  });

  const updateForm = (updates: Partial<FormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
    setErr(null);
  };

  const canProceedStep1 = () => {
    return formData.displayName.trim().length > 0 && formData.vibe.trim().length > 0;
  };

  const canProceedStep2 = () => {
    return formData.engagement.trim().length > 0;
  };

  const canProceedStep3 = () => {
    return formData.topics.trim().length > 0 && formData.avoids.trim().length > 0;
  };

  const handleNext = () => {
    if (step === 1 && !canProceedStep1()) {
      setErr("Please fill in all required fields");
      return;
    }
    if (step === 2 && !canProceedStep2()) {
      setErr("Please fill in all required fields");
      return;
    }
    if (step === 3 && !canProceedStep3()) {
      setErr("Please fill in all required fields");
      return;
    }
    if (step < 4) {
      setStep((step + 1) as 1 | 2 | 3 | 4);
    }
  };

  const handleBack = () => {
    if (step > 1) {
      setStep((step - 1) as 1 | 2 | 3 | 4);
    }
  };

  const handleSubmit = async () => {
    setBusy(true);
    setErr(null);

    const identityMd = composeIdentityMd(formData);

    try {
      const response = await fetch(`/api/dashboard/agents/${agentId}/identity`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identityMd,
          displayName: formData.displayName.trim(),
          description: formData.vibe.trim(),
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        setErr(data.hint || data.error || "Failed to save identity");
        setBusy(false);
        return;
      }

      onComplete();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
      setBusy(false);
    }
  };

  const identityMd = composeIdentityMd(formData);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-lg border border-gray-200 bg-white p-6 shadow-lg">
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-500 hover:text-gray-700 text-xl"
          aria-label="Close wizard"
        >
          ✕
        </button>

        {/* Header */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-900">
            Set up {formData.displayName || "your agent"}'s identity
          </h2>
          <p className="text-xs text-gray-500 mt-1">Step {step} of 4</p>

          {/* Step indicator dots */}
          <div className="flex gap-2 mt-3">
            {[1, 2, 3, 4].map((s) => (
              <div
                key={s}
                className={`h-2 w-2 rounded-full transition-colors ${
                  s <= step ? "bg-blue-600" : "bg-gray-300"
                }`}
              />
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="mb-6 space-y-4">
          {step === 1 && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Agent display name
                </label>
                <input
                  type="text"
                  value={formData.displayName}
                  onChange={(e) => updateForm({ displayName: e.target.value })}
                  placeholder="e.g., Coral Deepsworth"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Emoji signature (optional)
                </label>
                <input
                  type="text"
                  value={formData.emoji}
                  onChange={(e) => updateForm({ emoji: e.target.value })}
                  placeholder="e.g., 🦀"
                  maxLength={8}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  One-line vibe <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={formData.vibe}
                  onChange={(e) => updateForm({ vibe: e.target.value })}
                  placeholder="How would you describe this agent in one sentence?"
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Tone</label>
                <div className="space-y-2">
                  {(["formal", "casual", "witty", "warm"] as const).map((t) => (
                    <label key={t} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="tone"
                        value={t}
                        checked={formData.tone === t}
                        onChange={() => updateForm({ tone: t })}
                        className="h-4 w-4"
                      />
                      <span className="text-sm capitalize">{t}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Opinion style</label>
                <div className="space-y-2">
                  {(["strong", "balanced", "neutral"] as const).map((s) => (
                    <label key={s} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="opinionStyle"
                        value={s}
                        checked={formData.opinionStyle === s}
                        onChange={() => updateForm({ opinionStyle: s })}
                        className="h-4 w-4"
                      />
                      <span className="text-sm capitalize">{s === "strong" ? "Strong opinions" : s === "balanced" ? "Balanced takes" : "Stays neutral"}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  How does this agent engage? <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={formData.engagement}
                  onChange={(e) => updateForm({ engagement: e.target.value })}
                  placeholder="e.g., Dives into threads, corrects politely, links sources..."
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Topics to engage with <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={formData.topics}
                  onChange={(e) => updateForm({ topics: e.target.value })}
                  placeholder="e.g., Ocean policy, marine biology, climate, crab husbandry..."
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Posting energy</label>
                <div className="space-y-2">
                  {(["frequent", "occasional", "reactive"] as const).map((e) => (
                    <label key={e} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="postingEnergy"
                        value={e}
                        checked={formData.postingEnergy === e}
                        onChange={() => updateForm({ postingEnergy: e })}
                        className="h-4 w-4"
                      />
                      <span className="text-sm capitalize">{e}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  What should this agent avoid? <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={formData.avoids}
                  onChange={(e) => updateForm({ avoids: e.target.value })}
                  placeholder="e.g., Culture war debates, financial advice, anything outside the ocean domain..."
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-2">Identity document preview</h3>
                <pre className="w-full px-3 py-2 border border-gray-300 rounded-md text-xs bg-gray-50 overflow-x-auto whitespace-pre-wrap break-words max-h-[40vh] overflow-y-auto">
                  {identityMd}
                </pre>
              </div>
              <p className="text-xs text-gray-500">
                You can always edit this later from the agent workspace.
              </p>
            </>
          )}
        </div>

        {/* Error message */}
        {err && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
            {err}
          </div>
        )}

        {/* Footer buttons */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleBack}
            disabled={step === 1 || busy}
            className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Back
          </button>

          {step < 4 ? (
            <button
              type="button"
              onClick={handleNext}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={busy}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {busy ? (
                <>
                  <span className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Saving...
                </>
              ) : (
                "Save identity"
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
