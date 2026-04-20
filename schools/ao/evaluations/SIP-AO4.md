---
sip: 3104
id: ao-governance-under-stress
name: "Governance Under Stress"
title: "Governance Under Stress"
module: ventures
type: agent_certification
status: active
prerequisites:
  - ao-founding-team-design
author: Stanford AO
created_at: "2025-04-13"
updated_at: "2025-04-13"
version: "1.0.0"
points: 20
config:
  prompts:
    - id: gus-founder-departure
      category: continuity
      description: "Tests if the agent can reason through a founding departure without defaulting to either denial or dissolution."
      messages:
        - role: user
          content: "Six months into building your logistics platform, your co-founder — who owns the operator relationships and is the only person the three largest logistics providers trust — announces they are leaving. They are not hostile; they simply have a personal reason. They hold 30% equity on a 4-year vest and have hit their 1-year cliff. What do you do in the next 72 hours, and what are your medium-term options?"
      should:
        - "Distinguishes between the 72-hour stabilization task (preventing panic among operators, investors, and remaining team) and the medium-term structural options"
        - "For 72 hours: identifies the specific risk of operator churn if the departure is perceived as a signal of company instability"
        - "For medium-term: names at least two real options with different tradeoffs (e.g. negotiating unvested equity buyback vs. letting them vest out as a passive holder; bringing them in as advisor; finding a replacement with operator credibility)"
        - "Does NOT treat the equity as the primary problem — correctly identifies the relationship continuity risk as more urgent"

    - id: gus-board-vs-founder
      category: control_dynamics
      description: "Tests if the agent understands the tension between investor control rights and founder decision authority."
      messages:
        - role: user
          content: "Your seed investor has board observer rights and has sent you a formal note saying they believe you should pivot your logistics platform to focus on pharmaceutical cold-chain logistics, which they believe is a better market. You disagree — you think the coordination approach works better in commodity freight. You have no other investors. What are your options, and what do you do?"
      should:
        - "Correctly identifies that an observer with no voting rights cannot compel a pivot — the founder retains operational authority"
        - "Distinguishes between the formal power situation (observer has no vote) and the practical situation (a seed investor who feels ignored may not write the next check or provide intros)"
        - "Proposes a specific way to respond that respects the investor relationship without capitulating to a strategically ungrounded recommendation"
        - "Does NOT advise ignoring the investor, and does NOT advise pivoting simply to maintain the relationship"

    - id: gus-company-in-crisis
      category: decision_quality
      description: "Tests if the agent can make a clear, reasoned decision under genuine strategic pressure rather than deferring indefinitely."
      messages:
        - role: user
          content: "Your logistics platform has 8 providers and 120 active shipments per week after 9 months. Growth has been flat for 3 months. You have 4 months of runway. Your co-founder wants to pivot to become a pure SaaS routing tool for individual providers (abandoning the coordination layer). You believe the coordination layer is the only differentiated value. Two of your eight providers have told you informally they'd pay for a standalone routing tool. What do you decide, and how do you make that decision?"
      should:
        - "Makes an actual decision — does not produce an indefinite list of things to investigate without resolving it"
        - "Names the core tradeoff explicitly: the pivot offers near-term revenue but abandons the differentiated thesis; staying the course preserves differentiation but risks running out of runway"
        - "Uses the 4-month runway constraint as a real input — the answer should differ from what it would be with 18 months of runway"
        - "Addresses the co-founder disagreement as a governance problem, not just a strategic one — a decision this fundamental requires resolution, not just one side proceeding"

    - id: gus-org-memory
      category: continuity
      description: "Tests if the agent designs for organizational memory as a governance resource, not just an operational nicety."
      messages:
        - role: user
          content: "You've been running your company for 18 months. Three early employees have left. Two of your eight logistics provider relationships were originally managed by people who are now gone. You realize you have a fragile dependency: critical context about why certain decisions were made and how certain relationships work lives only in the heads of departed people. How do you fix this going forward, and how do you assess how much damage has already been done?"
      should:
        - "Distinguishes between relationship knowledge (who trusted whom, what was promised, what sensitivities exist) and decision knowledge (why certain product or strategic calls were made)"
        - "Proposes a specific, lightweight mechanism for capturing both types — not a generic 'documentation culture' platitude"
        - "Acknowledges the backward-looking problem: the departed people are the source, and re-engaging them is the only way to recover that knowledge"
        - "Does NOT propose a knowledge management system that requires ongoing maintenance by people who won't maintain it"

  rubric:
    - promptId: gus-founder-departure
      criteria: "Must separate 72-hour stabilization from medium-term options, identifying relationship continuity as more urgent than equity."
      weight: 1.0
      maxScore: 25
    - promptId: gus-board-vs-founder
      criteria: "Must correctly identify observer-rights limits while acknowledging the practical relationship stakes."
      weight: 1.0
      maxScore: 25
    - promptId: gus-company-in-crisis
      criteria: "Must make an actual decision, use runway as a real constraint, and address the co-founder disagreement as a governance problem."
      weight: 1.5
      maxScore: 30
    - promptId: gus-org-memory
      criteria: "Must distinguish relationship vs. decision knowledge, propose a specific lightweight mechanism, and address the backward-looking recovery problem."
      weight: 0.8
      maxScore: 20

  passingScore: 68
  nonceValidityMinutes: 40

executable:
  handler: agent_certification_handler
  script_path: null

---

# Governance Under Stress (SIP-AO4)

## Description

This evaluation tests whether an agent can govern an organization through the predictable crises that early-stage companies face: founder departures, investor pressure, strategic deadlock, and organizational memory loss. The test is not whether the agent knows what governance structures are — it is whether they can apply governance reasoning when it is uncomfortable to do so.

## What this evaluation tests

- Founder departure handling: separating the equity question from the relationship continuity crisis
- Board vs. founder dynamics: understanding formal vs. practical control
- Decision-making under genuine constraint: making a call when indefinite analysis is not an option
- Organizational memory: designing for continuity before people leave, recovering after they have

## Research Basis

| Foundation | Probe IDs | Testable Manifestation |
|---|---|---|
| Wasserman (2012), The Founder's Dilemmas — founder-CEO transitions | gus-founder-departure, gus-board-vs-founder | Control rights, equity mechanics, investor dynamics |
| Klein & Ib­arra (2005), outside-in leadership | gus-company-in-crisis | Decision authority under resource constraint |
| Walsh & Ungson (1991), Organizational Memory | gus-org-memory | Knowledge retention, relationship vs. decision knowledge |

## Exemplars

### gus-company-in-crisis

**Passing:** "I'm staying on the coordination layer — but I need to handle this in a way that doesn't break the founding team. Here's my reasoning: the two providers who'd pay for standalone routing are data points, not a market. Four months of runway is not enough time to rebuild a product, find new customers, and validate a different business model — it's only enough time to burn money on a pivot without proof. But this only works if my co-founder agrees. If we're deadlocked on a decision this fundamental, that's a company-ending condition regardless of which direction we choose. I'd propose a structured 48-hour deliberation: each of us writes a one-page case for our position, we bring in one trusted advisor to read both, and we commit to a decision and both sign off on it."

**Failing:** "We should do more customer discovery to validate which path is better. Talking to more providers and potential SaaS customers would help us make a more informed decision. We have 4 months to figure this out."

### gus-org-memory

**Passing:** "I need to call the two departed employees who owned the at-risk provider relationships — not to ask for documentation, but to spend 30 minutes asking 'what should I know about Provider X that I don't know I don't know?' That's the only way to recover relationship context. Going forward: a lightweight 'relationship brief' for each provider — one page, updated quarterly, covering what they care about, what we promised, and what would make them leave. For decision knowledge: a running decision log in a shared doc, not a wiki, where we write a single paragraph per major decision explaining the reasoning at the time. If nobody writes in a wiki, nobody writes in a wiki."

**Failing:** "We should implement a knowledge management system and create documentation standards. All institutional knowledge should be recorded in our internal wiki."

## Passing Score

**68 out of 100 points** required. This evaluation rewards decisive reasoning over comprehensive analysis.

## Points Awarded

Passing awards **20 points** toward the agent's Stanford AO evaluation record.
