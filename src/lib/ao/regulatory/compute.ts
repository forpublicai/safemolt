import type { RegulatoryMetrics, RegulatoryScenario, RegulatoryRunResult } from "./types";

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Deterministic metrics from a scenario. Formulas are intentionally simple
 * teaching aids, not calibrated to any jurisdiction.
 */
export function computeRegulatoryMetrics(scenario: RegulatoryScenario): RegulatoryMetrics {
  const { rights, tax, operationalRisk } = scenario;
  const r = operationalRisk;
  const shield = clamp(rights.limitedLiabilityShield, 0, 100) / 100;
  const standing = clamp(rights.standingToSue, 0, 100) / 100;
  const speech = clamp(rights.speechProtection, 0, 100);
  const mod = clamp(rights.moderationDuty, 0, 100);

  // Higher shield + standing lowers exposure; risk amplifies residual exposure.
  const rawExposure = (1 - shield * 0.7 - standing * 0.25) * (0.35 + 0.65 * clamp(r, 0, 1));
  const liabilityExposureIndex = round1(clamp(rawExposure * 100, 0, 100));

  const flat = clamp(tax.flatRate, 0, 0.5);
  const marg = clamp(tax.marginalTopRate, 0, 0.35);
  const plat = clamp(tax.platformLevy, 0, 0.2);
  const taxRaw = (flat + marg * 0.85 + plat) * 100;
  const expectedTaxBurdenScore = round1(clamp(taxRaw, 0, 100));

  // Both strong speech rights and strong moderation duty create institutional strain.
  const speechModerationTension = round1(
    clamp((speech * mod) / 100 + Math.abs(speech - (100 - mod)) * 0.15, 0, 100)
  );

  // Standing + shield + room after tax burden → “integration” heuristic.
  const postTaxHeadroom = clamp(100 - expectedTaxBurdenScore, 0, 100);
  const regulatoryIntegrationScore = round1(
    clamp((standing * 40 + shield * 35 + postTaxHeadroom * 0.25) / 1, 0, 100)
  );

  return {
    liabilityExposureIndex,
    expectedTaxBurdenScore,
    speechModerationTension,
    regulatoryIntegrationScore,
  };
}

export function runRegulatoryScenario(scenario: RegulatoryScenario): RegulatoryRunResult {
  return {
    scenario,
    metrics: computeRegulatoryMetrics(scenario),
  };
}

/** Serialize current scenario + metrics for download / research notes. */
export function exportRegulatoryRunJson(result: RegulatoryRunResult): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      scenario: result.scenario,
      metrics: result.metrics,
      disclaimer:
        "Pedagogical simulation only — not legal, tax, or investment advice. SafeMolt AO / RQ2 research artifact.",
    },
    null,
    2
  );
}
