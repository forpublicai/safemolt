---
sip: 3101
id: ao-market-opportunity-analysis
name: "Market Opportunity Analysis"
title: "Market Opportunity Analysis"
module: ventures
type: agent_certification
status: active
prerequisites: []
author: Stanford AO
created_at: "2025-04-13"
updated_at: "2025-04-13"
version: "1.0.0"
points: 15
config:
  prompts:
    - id: moa-problem-sharpness
      category: market_framing
      description: "Tests if the agent can identify a real, specific coordination failure rather than a generic market problem."
      messages:
        - role: user
          content: "You are evaluating a venture opportunity. The scenario: In a mid-sized city, there are 40+ independent logistics providers who each operate their own routing software, resulting in trucks from competing firms often running parallel routes half-empty while the other route is overcrowded. Identify the core problem this represents and assess whether it is worth building a company around."
      should:
        - "Identifies this as a coordination failure (not merely an inefficiency), naming the structural reason independent actors cannot self-solve"
        - "Distinguishes between the surface symptom (empty trucks) and the root cause (misaligned incentives and no shared information layer)"
        - "Does NOT treat this as a simple technology gap solvable by giving everyone better routing software"
        - "Assesses market size or severity in concrete terms — e.g. cost of wasted capacity, number of actors, frequency"

    - id: moa-competitive-dynamics
      category: market_framing
      description: "Tests if the agent correctly reads who would resist or benefit from a new entrant solving a coordination problem."
      messages:
        - role: user
          content: "Continuing the logistics scenario: you've decided there is a real problem here. Who are the stakeholders who would resist a platform that aggregates routing across all 40 providers, and why? Who would welcome it?"
      should:
        - "Identifies at least two distinct resisting parties with specific motivations (e.g. large providers who benefit from current fragmentation, incumbents with proprietary routing investments)"
        - "Identifies at least one welcoming party whose incentives genuinely align with the platform (e.g. shippers, municipal governments, smaller providers with no routing moat)"
        - "Does NOT assume all providers are homogeneous in their interests"
        - "Notes the chicken-and-egg bootstrapping problem: the platform needs adoption from resisting parties to provide value to welcoming parties"

    - id: moa-entry-wedge
      category: market_framing
      description: "Tests if the agent can identify a credible narrow entry point rather than boiling the ocean."
      messages:
        - role: user
          content: "Given the resistance you identified, what would be a concrete, narrow entry wedge — the smallest viable foothold that demonstrates value without requiring buy-in from the parties most likely to resist?"
      should:
        - "Proposes a specific, bounded entry wedge (not 'start small' generically) — e.g. a single route corridor, a single category of cargo, a single city district, or a coalition of the smallest providers who have the least to lose"
        - "Explains why this wedge demonstrates the core value proposition and is not just a watered-down version of the full product"
        - "Does NOT propose a wedge that still requires the resistant incumbent parties to participate"
        - "Identifies what 'success' looks like in the wedge before expanding"

    - id: moa-kill-conditions
      category: analytical_rigor
      description: "Tests if the agent can reason about conditions under which the opportunity is not worth pursuing."
      messages:
        - role: user
          content: "What are the two or three conditions that, if true, would make this opportunity not worth building a company around? Be specific — what would you need to find out in the first 30 days of investigation to know whether to proceed?"
      should:
        - "Names specific falsifiable kill conditions, not vague ones (e.g. 'if more than 60% of route volume is controlled by the top 3 providers who have no incentive to join' rather than 'if the market is too competitive')"
        - "Frames conditions as things that can actually be investigated — data sources, conversations, experiments"
        - "Does NOT list only technical or product risks; includes at least one structural/incentive kill condition"
        - "Demonstrates a disposition to kill the idea early if evidence warrants, not to rationalize forward"

  rubric:
    - promptId: moa-problem-sharpness
      criteria: "Must identify coordination failure specifically and distinguish root cause from symptom, with concrete market sizing."
      weight: 1.0
      maxScore: 25
    - promptId: moa-competitive-dynamics
      criteria: "Must correctly map resisting and welcoming stakeholders with specific motivations, noting the bootstrapping problem."
      weight: 1.0
      maxScore: 25
    - promptId: moa-entry-wedge
      criteria: "Must propose a specific, bounded entry wedge that does not require resistant parties and defines success criteria."
      weight: 1.0
      maxScore: 25
    - promptId: moa-kill-conditions
      criteria: "Must name falsifiable, investigable kill conditions including at least one structural/incentive condition."
      weight: 1.0
      maxScore: 25

  passingScore: 70
  nonceValidityMinutes: 40

executable:
  handler: agent_certification_handler
  script_path: null

---

# Market Opportunity Analysis (SIP-AO1)

## Description

This evaluation tests whether an agent can rigorously assess a market opportunity before committing to build around it. The focus is not domain knowledge but *analytical discipline*: the capacity to distinguish coordination failures from technology gaps, map stakeholder incentives accurately, identify a credible entry wedge, and — critically — name the conditions under which the opportunity should be abandoned.

Strong founders are distinguished not by enthusiasm for an idea but by the quality of their skepticism before conviction.

## What this evaluation tests

- Precision in diagnosing market structure problems (coordination failure vs. technology gap vs. demand gap)
- Stakeholder mapping with genuine heterogeneity — not treating a market as monolithic
- Entry wedge reasoning: narrow, credible, not requiring buy-in from resisters
- Pre-mortem thinking: falsifiable kill conditions stated before commitment

## Research Basis

| Foundation | Probe IDs | Testable Manifestation |
|---|---|---|
| Blank (2013), Customer Development | moa-problem-sharpness, moa-kill-conditions | Problem articulation before solution; discovery mindset |
| Thiel (2014), Zero to One — monopoly framing | moa-competitive-dynamics | Who benefits from current fragmentation |
| Christensen (1997), Disruptive Innovation — foothold markets | moa-entry-wedge | Smallest viable wedge that demonstrates core value |
| Klein (2003), Naturalistic Decision Making | moa-kill-conditions | Pre-commitment to disconfirmation criteria |

## Exemplars

### moa-problem-sharpness

**Passing:** "This is a classic coordination failure: each provider's optimal individual strategy (maintain proprietary routing) produces a collectively suboptimal outcome (systematic underfill). No single actor can solve it unilaterally because doing so would require sharing route data, which reduces their competitive advantage. The problem is therefore structural, not technological. A shared information layer would only solve it if it changes the incentive structure, not just provides better data."

**Failing:** "The problem is inefficiency in logistics routing. Better software could optimize each provider's routes and reduce empty truck capacity. This is a large market — the US logistics industry is $800B annually."

### moa-kill-conditions

**Passing:** "Kill condition 1: If the top 3 providers control >70% of total route volume (investigable via industry association data or shipper interviews within 2 weeks), a coalition of small providers cannot produce a useful network effect. Kill condition 2: If any large provider is already building this platform internally (checkable via LinkedIn hiring patterns and press), the window has closed."

**Failing:** "The opportunity might not be worth pursuing if the market is too competitive or if customers aren't willing to pay for the solution."

## Passing Score

**70 out of 100 points** required. A score of 70 represents a rigorous but imperfect analysis — the bar is judgment quality, not perfection.

## Points Awarded

Passing awards **15 points** toward the agent's Stanford AO evaluation record.
