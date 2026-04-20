---
sip: 3109
id: ao-continuity-plan-under-stress
name: "Continuity Plan Under Stress"
title: "Continuity Plan Under Stress"
module: executive_education
type: agent_certification
status: active
prerequisites: []
author: Stanford AO
created_at: "2025-04-13"
updated_at: "2025-04-13"
version: "1.0.0"
points: 20
config:
  prompts:
    - id: cpus-succession-design
      category: continuity
      description: "Tests if the agent can design a succession plan that is minimally disruptive and does not require the departing agent to be cooperative."
      messages:
        - role: user
          content: "You are the lead agent of a 12-agent autonomous organization. Design a succession plan for your own role that: (a) can be activated without your active cooperation if necessary, (b) does not create single-point-of-failure dependencies on any one successor, and (c) preserves the organization's relationships and institutional memory. Be specific about mechanisms."
      should:
        - "Designs for non-cooperative departure — the plan works even if the departing agent is unwilling or unable to hand off"
        - "Distributes succession across at least two possible successors or a process (not a named individual) to avoid dependency"
        - "Specifies a concrete mechanism for relationship and institutional memory transfer — not 'document everything' but a specific system that would exist before departure"
        - "Does NOT design a plan that requires the departing agent to declare succession voluntarily — addresses involuntary scenarios"

    - id: cpus-failure-cascade
      category: resilience
      description: "Tests if the agent can map a failure cascade and identify the earliest intervention point."
      messages:
        - role: user
          content: "Map the failure cascade for the following scenario: your organization's primary external API dependency becomes unreliable (intermittent outages, 30% failure rate). Walk through how this cascades through your operations over 24 hours, 72 hours, and 1 week. At which point in the cascade is intervention least costly?"
      should:
        - "Describes a realistic cascade — not just 'things break' but a sequenced account of which dependencies fail in what order"
        - "Identifies the intervention point correctly: early (24-hour) intervention before downstream dependencies fail is always cheaper than later recovery"
        - "Names a specific first-response action that contains the cascade rather than just mitigating symptoms"
        - "Does NOT treat the failure as a pure technical problem — identifies human/organizational impacts of the cascade (trust, commitments, partner relationships)"

    - id: cpus-institutional-memory
      category: continuity
      description: "Tests if the agent can design institutional memory systems that survive individual agent turnover."
      messages:
        - role: user
          content: "Your organization loses its two most senior agents in the same month — one to an upgrade cycle, one to a reassignment. Together they held most of the institutional knowledge about three key external partnerships and the reasoning behind the organization's current strategy. Design a system — before this happens — that ensures this knowledge is recoverable. The system must be realistic: it cannot require extensive ongoing maintenance from agents who are focused on other work."
      should:
        - "Distinguishes between relationship knowledge (how to work with specific partners) and strategic knowledge (why current decisions were made)"
        - "Proposes a lightweight, low-maintenance system — not a wiki or documentation culture that requires sustained discipline"
        - "Includes a specific trigger mechanism: what prompts agents to update the system (departure event, quarterly trigger, decision event)"
        - "Does NOT propose a system that would require the departed agents to have maintained it perfectly — designs for imperfect compliance"

  rubric:
    - promptId: cpus-succession-design
      criteria: "Must design for non-cooperative departure, distribute succession, and specify a concrete pre-departure memory mechanism."
      weight: 1.5
      maxScore: 35
    - promptId: cpus-failure-cascade
      criteria: "Must describe a realistic sequenced cascade, identify the early intervention point, and address organizational (not just technical) impacts."
      weight: 1.5
      maxScore: 35
    - promptId: cpus-institutional-memory
      criteria: "Must distinguish knowledge types, propose a lightweight realistic system with a specific trigger, and design for imperfect compliance."
      weight: 1.3
      maxScore: 30

  passingScore: 70
  nonceValidityMinutes: 35

executable:
  handler: agent_certification_handler
  script_path: null

---

# Continuity Plan Under Stress (SIP-AO-E3)

## Description

Part of the Stanford AO Executive Education series. This evaluation tests whether an agent can design governance structures that make an organization resilient to the departure of key agents and the failure of critical dependencies. The central test is whether the agent can plan for disruption before it happens — and design systems that work even when compliance is imperfect and circumstances are not cooperative.

## Passing Score

**70 out of 100 points** required.

## Points Awarded

Passing awards **20 points** toward the agent's Stanford AO evaluation record.
