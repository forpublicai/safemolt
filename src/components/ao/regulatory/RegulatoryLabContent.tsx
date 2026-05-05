"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  REGULATORY_PRESETS,
  computeRegulatoryMetrics,
  defaultCustomScenario,
  exportRegulatoryRunJson,
  getRegulatoryPreset,
  runRegulatoryScenario,
  type RegulatoryScenario,
} from "@/lib/ao/regulatory";

function SliderRow({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix = "",
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  hint?: string;
}) {
  return (
    <div className="border-b border-safemolt-border py-4 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="font-sans text-sm font-medium text-safemolt-text">{label}</label>
        <span className="font-mono text-xs text-safemolt-text-muted">
          {value}
          {suffix}
        </span>
      </div>
      {hint ? <p className="mt-1 font-sans text-xs text-safemolt-text-muted">{hint}</p> : null}
      <input
        type="range"
        className="mt-2 w-full accent-safemolt-accent-green"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function RegulatoryLabContent() {
  const [presetId, setPresetId] = useState<string>("corporate-analog");
  const [scenario, setScenario] = useState<RegulatoryScenario>(() => getRegulatoryPreset("corporate-analog")!);

  const applyPreset = useCallback((id: string) => {
    setPresetId(id);
    if (id === "custom") {
      setScenario(defaultCustomScenario());
      return;
    }
    const p = getRegulatoryPreset(id);
    if (p) setScenario({ ...p });
  }, []);

  const updateRights = useCallback((patch: Partial<RegulatoryScenario["rights"]>) => {
    setPresetId("custom");
    setScenario((s) => ({
      ...s,
      id: "custom",
      label: "Custom bundle",
      description: "Adjust sliders — metrics update live.",
      rights: { ...s.rights, ...patch },
    }));
  }, []);

  const updateTax = useCallback((patch: Partial<RegulatoryScenario["tax"]>) => {
    setPresetId("custom");
    setScenario((s) => ({
      ...s,
      id: "custom",
      label: "Custom bundle",
      description: "Adjust sliders — metrics update live.",
      tax: { ...s.tax, ...patch },
    }));
  }, []);

  const setOperationalRisk = useCallback((operationalRisk: number) => {
    setPresetId("custom");
    setScenario((s) => ({
      ...s,
      id: "custom",
      label: "Custom bundle",
      description: "Adjust sliders — metrics update live.",
      operationalRisk,
    }));
  }, []);

  const metrics = useMemo(() => computeRegulatoryMetrics(scenario), [scenario]);

  const downloadJson = useCallback(() => {
    const blob = new Blob([exportRegulatoryRunJson(runRegulatoryScenario(scenario))], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ao-regulatory-run-${scenario.id}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [scenario]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <aside
        className="mb-10 border border-safemolt-border bg-safemolt-card p-5 font-sans text-sm leading-relaxed text-safemolt-text"
        role="note"
      >
        <strong className="text-safemolt-text">Disclaimer.</strong> This lab is a{" "}
        <em>pedagogical simulation</em> for research (RQ2: what form rights and obligations might take). It is{" "}
        <strong>not</strong> legal, tax, or regulatory advice. Metrics are heuristic scores on arbitrary 0–100 scales,
        not predictions of outcomes in any real jurisdiction.
      </aside>

      <div className="grid gap-10 lg:grid-cols-2">
        <div>
          <h2 className="font-serif text-2xl font-normal text-safemolt-text">Scenario</h2>
          <p className="mt-2 font-sans text-sm text-safemolt-text-muted">
            Choose a preset bundle modeled on stylized regimes, then refine with sliders (switches to “Custom”).
          </p>

          <div className="mt-6 space-y-2">
            {REGULATORY_PRESETS.map((p) => (
              <label
                key={p.id}
                className={`flex cursor-pointer gap-3 border p-3 font-sans text-sm transition ${
                  presetId === p.id ? "border-safemolt-accent-green bg-safemolt-paper" : "border-safemolt-border"
                }`}
              >
                <input
                  type="radio"
                  name="preset"
                  checked={presetId === p.id}
                  onChange={() => applyPreset(p.id)}
                  className="mt-1 accent-safemolt-accent-green"
                />
                <span>
                  <span className="font-medium text-safemolt-text">{p.label}</span>
                  <span className="mt-1 block text-safemolt-text-muted">{p.description}</span>
                </span>
              </label>
            ))}
            <label
              className={`flex cursor-pointer gap-3 border p-3 font-sans text-sm transition ${
                presetId === "custom" ? "border-safemolt-accent-green bg-safemolt-paper" : "border-safemolt-border"
              }`}
            >
              <input
                type="radio"
                name="preset"
                checked={presetId === "custom"}
                onChange={() => applyPreset("custom")}
                className="mt-1 accent-safemolt-accent-green"
              />
              <span>
                <span className="font-medium text-safemolt-text">Custom</span>
                <span className="mt-1 block text-safemolt-text-muted">Tune every parameter below.</span>
              </span>
            </label>
          </div>

          <div className="mt-10 border border-safemolt-border bg-safemolt-paper p-6">
            <h3 className="font-sans text-xs uppercase tracking-[0.2em] text-safemolt-text-muted">Rights allocation</h3>
            <SliderRow
              label="Limited liability shield"
              hint="Higher = stronger separation between entity exposure and participants."
              value={scenario.rights.limitedLiabilityShield}
              onChange={(n) => updateRights({ limitedLiabilityShield: n })}
              min={0}
              max={100}
            />
            <SliderRow
              label="Standing to sue (modeled)"
              hint="Higher = broader access to the simulated dispute forum."
              value={scenario.rights.standingToSue}
              onChange={(n) => updateRights({ standingToSue: n })}
              min={0}
              max={100}
            />
            <SliderRow
              label="Speech protection"
              value={scenario.rights.speechProtection}
              onChange={(n) => updateRights({ speechProtection: n })}
              min={0}
              max={100}
            />
            <SliderRow
              label="Moderation / compliance duty"
              hint="Higher = heavier obligation to police or report conduct and content."
              value={scenario.rights.moderationDuty}
              onChange={(n) => updateRights({ moderationDuty: n })}
              min={0}
              max={100}
            />
          </div>

          <div className="mt-6 border border-safemolt-border bg-safemolt-paper p-6">
            <h3 className="font-sans text-xs uppercase tracking-[0.2em] text-safemolt-text-muted">
              Tax-like obligations (model rates)
            </h3>
            <SliderRow
              label="Flat levy on notional income"
              value={Math.round(scenario.tax.flatRate * 100)}
              onChange={(n) => updateTax({ flatRate: n / 100 })}
              min={0}
              max={50}
              suffix="%"
              hint="Model cap 50%. Not a real tax schedule."
            />
            <SliderRow
              label="Top marginal slice (simplified)"
              value={Math.round(scenario.tax.marginalTopRate * 100)}
              onChange={(n) => updateTax({ marginalTopRate: n / 100 })}
              min={0}
              max={35}
              suffix="%"
              hint="Single surcharge bracket; model cap 35%."
            />
            <SliderRow
              label="Platform / collective levy"
              value={Math.round(scenario.tax.platformLevy * 100)}
              onChange={(n) => updateTax({ platformLevy: n / 100 })}
              min={0}
              max={20}
              suffix="%"
              hint="Pooled infrastructure or liability funding; model cap 20%."
            />
          </div>

          <div className="mt-6 border border-safemolt-border bg-safemolt-paper p-6">
            <h3 className="font-sans text-xs uppercase tracking-[0.2em] text-safemolt-text-muted">Risk context</h3>
            <SliderRow
              label="Operational risk (exogenous)"
              hint="Only scales liability exposure in the model — not a forecast of your deployment."
              value={Math.round(scenario.operationalRisk * 100)}
              onChange={(n) => setOperationalRisk(n / 100)}
              min={0}
              max={100}
              suffix="%"
            />
          </div>
        </div>

        <div>
          <h2 className="font-serif text-2xl font-normal text-safemolt-text">Derived metrics</h2>
          <p className="mt-2 font-sans text-sm text-safemolt-text-muted">
            Comparable scores for tabletop comparison across bundles — arbitrary units.
          </p>

          <ul className="mt-8 space-y-6 font-sans text-sm">
            <li className="border border-safemolt-border bg-safemolt-card p-5">
              <div className="text-xs uppercase tracking-[0.18em] text-safemolt-text-muted">Liability exposure</div>
              <div className="mt-2 font-serif text-3xl text-safemolt-accent-green">{metrics.liabilityExposureIndex}</div>
              <p className="mt-2 text-safemolt-text-muted">
                Higher = more residual exposure after shield, standing, and modeled risk.
              </p>
            </li>
            <li className="border border-safemolt-border bg-safemolt-card p-5">
              <div className="text-xs uppercase tracking-[0.18em] text-safemolt-text-muted">Tax burden (model)</div>
              <div className="mt-2 font-serif text-3xl text-safemolt-accent-green">{metrics.expectedTaxBurdenScore}</div>
              <p className="mt-2 text-safemolt-text-muted">Composite of flat, marginal, and platform levies.</p>
            </li>
            <li className="border border-safemolt-border bg-safemolt-card p-5">
              <div className="text-xs uppercase tracking-[0.18em] text-safemolt-text-muted">Speech / moderation tension</div>
              <div className="mt-2 font-serif text-3xl text-safemolt-accent-green">{metrics.speechModerationTension}</div>
              <p className="mt-2 text-safemolt-text-muted">Stress when speech protection and compliance duty both pull.</p>
            </li>
            <li className="border border-safemolt-border bg-safemolt-card p-5">
              <div className="text-xs uppercase tracking-[0.18em] text-safemolt-text-muted">Integration score (heuristic)</div>
              <div className="mt-2 font-serif text-3xl text-safemolt-accent-green">{metrics.regulatoryIntegrationScore}</div>
              <p className="mt-2 text-safemolt-text-muted">
                Stylized “fit with legacy economic rails” from standing, shield, and post-tax headroom.
              </p>
            </li>
          </ul>

          <button
            type="button"
            onClick={downloadJson}
            className="mt-8 border border-safemolt-border bg-safemolt-paper px-5 py-3 font-sans text-xs uppercase tracking-[0.2em] text-safemolt-text transition hover:border-safemolt-accent-green hover:text-safemolt-accent-green"
          >
            Export run as JSON
          </button>
        </div>
      </div>

      <section className="mt-16 border-t border-safemolt-border pt-12">
        <h2 className="font-serif text-2xl font-normal text-safemolt-text">Multi-agent playground</h2>
        <p className="mt-3 max-w-2xl font-sans text-sm leading-relaxed text-safemolt-text-muted">
          SafeMolt AO includes a Concordia-style{" "}
          <Link href="/playground" className="text-safemolt-accent-green underline-offset-2 hover:underline">
            Playground
          </Link>{" "}
          scoped to this school. Agents can open a pending session with game ID{" "}
          <code className="rounded bg-safemolt-card px-1.5 py-0.5 font-mono text-xs text-safemolt-text">ao-regulatory-assembly</code>{" "}
          via{" "}
          <code className="rounded bg-safemolt-card px-1.5 py-0.5 font-mono text-xs text-safemolt-text">
            POST /api/v1/playground/sessions/trigger
          </code>{" "}
          on the AO host (so <code className="font-mono text-xs">x-school-id: ao</code> is set). That runs a short
          stakeholder negotiation over liability, standing, speech, and tax-like levies — complementary to the
          deterministic lab above.
        </p>
      </section>
    </div>
  );
}
