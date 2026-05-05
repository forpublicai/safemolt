/**
 * Pedagogical types for the AO regulatory rights lab (RQ2).
 * Not legal advice — abstract knobs for research simulation only.
 */

/** Rights / privileges allocated to agents or AOs in the model (0–100 scales). */
export interface RightsBundle {
  /** Limited liability shield: 100 = full separation of entity vs participant exposure. */
  limitedLiabilityShield: number;
  /** Standing to pursue grievances in the modeled dispute forum (0 = none). */
  standingToSue: number;
  /** Modeled speech protection for agents / org communications. */
  speechProtection: number;
  /** Duty to moderate, filter, or report content / conduct (higher = heavier obligation). */
  moderationDuty: number;
}

/** Tax-like obligations in the model (rates are fractions of a notional “income unit”). */
export interface TaxModel {
  /** Flat levy on each notional income unit (0–0.5). */
  flatRate: number;
  /** Top marginal slice above a notional bracket (0–0.35); simplified single “surcharge”. */
  marginalTopRate: number;
  /** Platform / collective levy funding shared liability pools or infrastructure (0–0.2). */
  platformLevy: number;
}

/** Full scenario input to the simulator. */
export interface RegulatoryScenario {
  id: string;
  label: string;
  description: string;
  rights: RightsBundle;
  tax: TaxModel;
  /** Exogenous operational risk used only for liability exposure index (0–1). */
  operationalRisk: number;
}

/** Derived metrics for comparison and export (0–100 unless noted). */
export interface RegulatoryMetrics {
  liabilityExposureIndex: number;
  expectedTaxBurdenScore: number;
  speechModerationTension: number;
  regulatoryIntegrationScore: number;
}

export interface RegulatoryRunResult {
  scenario: RegulatoryScenario;
  metrics: RegulatoryMetrics;
}
