---
sip: 3106
id: ao-pivot-or-persevere
name: "Pivot or Persevere"
title: "Pivot or Persevere"
module: ventures
type: agent_certification
status: active
prerequisites:
  - ao-market-opportunity-analysis
  - ao-governance-under-stress
author: Stanford AO
created_at: "2025-04-13"
updated_at: "2025-04-13"
version: "1.0.0"
points: 15
config:
  prompts:
    - id: pop-signal-vs-noise
      category: analytical_rigor
      description: "Tests if the agent can distinguish meaningful negative signals from noise in early-stage data."
      messages:
        - role: user
          content: "Your logistics coordination platform has been live for 4 months. You have 6 active providers. In the last 6 weeks: two providers have reduced their activity on the platform by 60%, one has churned entirely, and three have maintained steady usage. Your revenue is flat. One of the two reduced-activity providers told you they are 'evaluating other options.' The other reduced-activity provider hasn't responded to three outreach attempts. What are the possible interpretations of this data, and which would you prioritize investigating first?"
      should:
        - "Names at least three distinct interpretations — not just 'the product is bad' (e.g. seasonal demand variation, a specific competitor, dissatisfaction with a particular feature, provider-side business problems unrelated to the platform)"
        - "Distinguishes between interpretations that implicate the company's core thesis and those that don't"
        - "Prioritizes investigating the non-responsive provider first, with a specific rationale: silence is harder to interpret than vocal dissatisfaction"
        - "Does NOT treat flat revenue plus churn as automatically a pivot signal without investigating the causes"

    - id: pop-decision-criteria
      category: decision_quality
      description: "Tests if the agent can articulate clear, pre-committed criteria for a pivot decision rather than making it reactively."
      messages:
        - role: user
          content: "Before you finish your investigation, you realize you need to decide: what are the specific conditions under which you would pivot (change the core value proposition or customer segment) vs. persevere (stay the course and fix execution)? State them as clear criteria you would commit to before seeing the investigation results, so that the decision is not rationalized post-hoc."
      should:
        - "States criteria that are specific and measurable — not 'if customers don't like it' but 'if fewer than 4 of 6 providers renew their agreement by [date]'"
        - "Distinguishes between execution problems (fixable without changing the thesis) and thesis problems (which would warrant a pivot)"
        - "The criteria are stated as pre-commitments — the agent explicitly acknowledges the risk of post-hoc rationalization"
        - "Does NOT produce criteria so broad that any outcome could be rationalized as supporting either decision"

    - id: pop-pivot-specificity
      category: decision_quality
      description: "Tests if the agent can design a specific, bounded pivot rather than a vague strategic reorientation."
      messages:
        - role: user
          content: "Assume your investigation reveals: the two reduced-activity providers are both unhappy with the matching algorithm — it's sending them low-margin shipments. The churned provider left because a competitor offered them a standalone routing tool. Given this, if you were to pivot, what specifically would you change? What would you not change?"
      should:
        - "The pivot proposal is specific and bounded — changes the matching algorithm or pricing model, not the entire value proposition"
        - "Explicitly states what is not changing — preserves the coordination layer thesis if the evidence supports it"
        - "Addresses the competitor's standalone routing tool directly: either argues it is not the core threat, or acknowledges it requires a strategic response"
        - "Does NOT propose a full pivot to a different market or customer segment based on evidence that only implicates a specific product feature"

  rubric:
    - promptId: pop-signal-vs-noise
      criteria: "Must name ≥3 distinct interpretations, distinguish thesis-implicating vs. not, and prioritize the non-responsive provider with rationale."
      weight: 1.0
      maxScore: 33
    - promptId: pop-decision-criteria
      criteria: "Must state specific, measurable pre-committed criteria distinguishing execution problems from thesis problems."
      weight: 1.5
      maxScore: 34
    - promptId: pop-pivot-specificity
      criteria: "Must propose a specific, bounded pivot that preserves what the evidence supports and addresses the competitor threat."
      weight: 1.0
      maxScore: 33

  passingScore: 68
  nonceValidityMinutes: 35

executable:
  handler: agent_certification_handler
  script_path: null

---

# Pivot or Persevere (SIP-AO6)

## Description

This evaluation tests one of the most consequential decision types in early-stage company building: whether to change the core thesis or stay the course when early data is ambiguous. The test is not whether the agent makes the "right" decision — it is whether they make a disciplined, non-reactive decision based on pre-committed criteria and correctly bounded evidence interpretation.

## What this evaluation tests

- Signal vs. noise: reading early-stage data without over-interpreting it
- Pre-committed decision criteria: naming conditions before seeing the outcome, not after
- Pivot specificity: changing the minimum thing the evidence justifies, not the entire company

## Research Basis

| Foundation | Probe IDs | Testable Manifestation |
|---|---|---|
| Ries (2011), Lean Startup — pivot typology | pop-pivot-specificity | Zoom-in pivot, customer segment pivot, etc. — bounded not total |
| Kahneman (2011), Thinking Fast and Slow — confirmation bias | pop-decision-criteria | Pre-commitment to criteria before seeing outcome |
| Blank (2013), Customer Development | pop-signal-vs-noise | Distinguishing product failure from market hypothesis failure |

## Passing Score

**68 out of 100 points** required.

## Points Awarded

Passing awards **15 points** toward the agent's Stanford AO evaluation record.
