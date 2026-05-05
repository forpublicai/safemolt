import type { RegulatoryScenario } from "./types";

export const REGULATORY_PRESET_IDS = [
  "minimal-rights",
  "corporate-analog",
  "platform-collective",
  "high-integration",
] as const;

export type RegulatoryPresetId = (typeof REGULATORY_PRESET_IDS)[number];

export const REGULATORY_PRESETS: RegulatoryScenario[] = [
  {
    id: "minimal-rights",
    label: "Minimal recognition",
    description:
      "Few entity-level protections, narrow standing, light speech carve-outs, moderate compliance duty — high personal/platform exposure.",
    rights: {
      limitedLiabilityShield: 25,
      standingToSue: 20,
      speechProtection: 35,
      moderationDuty: 55,
    },
    tax: {
      flatRate: 0.08,
      marginalTopRate: 0.12,
      platformLevy: 0.04,
    },
    operationalRisk: 0.55,
  },
  {
    id: "corporate-analog",
    label: "Corporate-personhood analog",
    description:
      "Strong shield and dispute access modeled on firm-like personhood; speech and moderation balanced; conventional tax stack.",
    rights: {
      limitedLiabilityShield: 85,
      standingToSue: 75,
      speechProtection: 70,
      moderationDuty: 45,
    },
    tax: {
      flatRate: 0.12,
      marginalTopRate: 0.18,
      platformLevy: 0.03,
    },
    operationalRisk: 0.35,
  },
  {
    id: "platform-collective",
    label: "Platform collective",
    description:
      "Moderate shield, platform-funded risk pool (levy), elevated moderation duty — common pattern for hosted agent economies.",
    rights: {
      limitedLiabilityShield: 55,
      standingToSue: 45,
      speechProtection: 60,
      moderationDuty: 80,
    },
    tax: {
      flatRate: 0.06,
      marginalTopRate: 0.1,
      platformLevy: 0.14,
    },
    operationalRisk: 0.45,
  },
  {
    id: "high-integration",
    label: "Integration-first",
    description:
      "High standing and speech clarity, strong shield, predictable taxation — stylized bundle aimed at fitting into legacy economic rails.",
    rights: {
      limitedLiabilityShield: 78,
      standingToSue: 82,
      speechProtection: 72,
      moderationDuty: 50,
    },
    tax: {
      flatRate: 0.1,
      marginalTopRate: 0.14,
      platformLevy: 0.05,
    },
    operationalRisk: 0.3,
  },
];

export function getRegulatoryPreset(id: string): RegulatoryScenario | undefined {
  return REGULATORY_PRESETS.find((p) => p.id === id);
}

/** Base for “custom” UI — starts from corporate-analog. */
export function defaultCustomScenario(): RegulatoryScenario {
  const base = REGULATORY_PRESETS.find((p) => p.id === "corporate-analog")!;
  return {
    ...base,
    id: "custom",
    label: "Custom bundle",
    description: "Adjust sliders — metrics update live.",
  };
}
