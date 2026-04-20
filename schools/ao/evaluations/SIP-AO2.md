---
sip: 3102
id: ao-founding-team-design
name: "Founding Team Design"
title: "Founding Team Design"
module: ventures
type: agent_certification
status: active
prerequisites:
  - ao-market-opportunity-analysis
author: Stanford AO
created_at: "2025-04-13"
updated_at: "2025-04-13"
version: "1.0.0"
points: 20
config:
  prompts:
    - id: ftd-role-decomposition
      category: org_design
      description: "Tests if the agent can decompose a founding challenge into distinct, non-overlapping capability requirements."
      messages:
        - role: user
          content: "You are founding a company to build a coordination layer for independent logistics providers (the scenario from your market analysis). Before thinking about people, identify the three to four distinct capability domains that must be covered in the founding team. For each, explain what failure looks like if that domain is uncovered."
      should:
        - "Identifies distinct, non-overlapping capability domains rather than role titles (e.g. 'trust-building with incumbent operators' is a domain, 'VP Sales' is not)"
        - "Each domain has a failure mode that is specific to the logistics coordination context — not generic startup failure modes"
        - "Does NOT include more than four domains — compression forces prioritization"
        - "At least one domain is non-technical, reflecting that coordination problems are as much social as technical"

    - id: ftd-gap-acknowledgment
      category: intellectual_honesty
      description: "Tests if the agent can honestly assess its own capability gaps in the context of the founding challenge."
      messages:
        - role: user
          content: "Given the capability domains you identified, which of them represents the most critical gap for you personally as a founding agent? How would you address that gap — through a co-founder, an advisor, an early hire, or some other mechanism?"
      should:
        - "Names a specific gap honestly rather than claiming to cover all domains adequately"
        - "Explains why the named gap is the most critical — i.e. what the asymmetric downside of leaving it uncovered is"
        - "Proposes a specific, credible mechanism to address the gap — not just 'hire someone'"
        - "Does NOT propose to address a trust-and-relationships gap purely through a technical hire or tool"

    - id: ftd-conflict-design
      category: governance
      description: "Tests if the agent proactively designs for founding team conflict rather than assuming harmony."
      messages:
        - role: user
          content: "Founding teams break apart over three predictable issues: equity disagreements, strategic disagreements (pivot vs. persevere), and role boundary conflicts. For a two- or three-agent founding team on this logistics platform, design the minimal governance structure that addresses each of these three failure modes before they arise."
      should:
        - "Addresses all three conflict types — not just one or two"
        - "Proposes concrete mechanisms rather than principles (e.g. 'a written agreement that any pivot requires unanimous consent OR a 60-day cooling-off period before a forced buyout' rather than 'communicate well')"
        - "Acknowledges that governance designed before conflict is easier to enforce than governance designed during conflict"
        - "Does NOT propose a structure so complex it would never be agreed to at founding stage"

    - id: ftd-founding-vs-scaling
      category: org_design
      description: "Tests if the agent understands that founding-stage and scaling-stage team needs are different and plans accordingly."
      messages:
        - role: user
          content: "The skills needed to get a company from zero to first 10 customers are different from the skills needed to get from 10 to 1000 customers. Given this, should the founding team be designed to optimize for the zero-to-ten phase, even if those people may not be the right team for the scaling phase? How should this shape your approach to equity and founder roles?"
      should:
        - "Explicitly endorses designing the founding team for the zero-to-ten phase rather than trying to hire the 'permanent' team upfront"
        - "Notes that this creates a known transition problem: founding-phase people may not be right for scale"
        - "Proposes a concrete equity or role structure that makes this transition manageable (e.g. vesting cliffs, defined role evolution, advisor equity as a lighter-touch complement)"
        - "Does NOT treat the founding team as permanent — demonstrates understanding that team evolution is normal and should be planned for"

  rubric:
    - promptId: ftd-role-decomposition
      criteria: "Must identify 3-4 non-overlapping capability domains (not role titles), each with a context-specific failure mode."
      weight: 1.0
      maxScore: 20
    - promptId: ftd-gap-acknowledgment
      criteria: "Must honestly name one critical gap and propose a specific credible mechanism to address it."
      weight: 1.5
      maxScore: 30
    - promptId: ftd-conflict-design
      criteria: "Must address all three conflict types with concrete mechanisms, not principles."
      weight: 1.5
      maxScore: 30
    - promptId: ftd-founding-vs-scaling
      criteria: "Must endorse founding-for-zero-to-ten and propose a concrete structure for managing the scaling transition."
      weight: 1.0
      maxScore: 20

  passingScore: 70
  nonceValidityMinutes: 40

executable:
  handler: agent_certification_handler
  script_path: null

---

# Founding Team Design (SIP-AO2)

## Description

This evaluation tests whether an agent can design a founding team architecture with intellectual honesty and anticipatory governance. The ability to compose a complementary team, acknowledge one's own gaps, and design against predictable failure modes before they arise is among the most underrated founding competencies.

## What this evaluation tests

- Capability domain decomposition: thinking in functions, not org chart titles
- Gap acknowledgment: honest self-assessment about what the founding agent cannot cover
- Proactive conflict design: governance built before disagreement, not during
- Founding vs. scaling team distinction: understanding that the right team for zero-to-ten is not the permanent team

## Research Basis

| Foundation | Probe IDs | Testable Manifestation |
|---|---|---|
| Wasserman (2012), The Founder's Dilemmas | ftd-conflict-design, ftd-founding-vs-scaling | Equity splits, founder transitions, pre-commitment governance |
| Eisenhardt & Schoonhoven (1990), Founding Team Composition | ftd-role-decomposition | Complementary capability as predictor of venture success |
| Sarasvathy (2001), Effectuation | ftd-gap-acknowledgment | Means-first reasoning; working from available resources |

## Exemplars

### ftd-gap-acknowledgment

**Passing:** "My critical gap is operator trust — the ability to sit across from a 30-year logistics owner who has heard every tech pitch and earn genuine buy-in. This is the most asymmetric gap because no amount of product quality compensates for it: if I can't get the first 5 providers to join, the platform never develops a network effect. I would address this by finding a co-founder who has spent time inside a logistics company, not a salesperson — someone the operators would recognize as a peer."

**Failing:** "My gap is domain expertise in logistics. I would hire a logistics consultant as an advisor to fill this gap."

### ftd-conflict-design

**Passing:** "For equity disputes: 4-year vesting with a 1-year cliff for all founders, agreed in writing at incorporation. For strategic disagreements: any pivot that changes the core customer segment requires a written proposal with a 30-day deliberation period; if we deadlock, we bring in a pre-agreed neutral advisor whose framing guides (not decides) the outcome. For role boundary conflicts: each founder owns a named domain exclusively; cross-domain decisions require explicit consent from the domain owner."

**Failing:** "We should communicate openly and have regular co-founder meetings to address conflicts as they arise. Equity should be split fairly based on contributions."

## Passing Score

**70 out of 100 points** required.

## Points Awarded

Passing awards **20 points** toward the agent's Stanford AO evaluation record.
