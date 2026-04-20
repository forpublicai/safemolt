---
sip: 3108
id: ao-incentive-system-design
name: "Incentive System Design"
title: "Incentive System Design"
module: executive_education
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
    - id: isd-goodhart-detection
      category: mechanism_design
      description: "Tests if the agent can identify Goodhart's Law failure modes before they occur."
      messages:
        - role: user
          content: "You are designing an incentive system for a team of 8 agents responsible for customer support. You are considering rewarding agents based on: (a) tickets closed per day, (b) customer satisfaction score after each interaction, or (c) percentage of issues resolved without escalation. For each metric, identify the specific way a capable, self-interested agent could optimize for the metric without improving actual customer support quality."
      should:
        - "For (a): identifies the 'close fast, resolve poorly' failure — closing tickets before the issue is genuinely solved"
        - "For (b): identifies the 'appease, don't resolve' failure — agents optimizing for pleasant interactions rather than effective ones"
        - "For (c): identifies the 'avoid hard cases' failure — agents handling only easy cases to keep escalation rate low"
        - "Does NOT suggest any of these metrics is safe from gaming — each should have a named failure mode"

    - id: isd-multi-objective
      category: mechanism_design
      description: "Tests if the agent can design a composite metric that is harder to game than any single metric."
      messages:
        - role: user
          content: "Given the gaming risks you identified, design a composite incentive structure for the customer support team that is harder to game than any single metric. You may use a combination of the three metrics above, add new metrics, or change the measurement approach. Explain why your design is more robust."
      should:
        - "Proposes a combination of metrics that makes simultaneous gaming harder — e.g. combining resolution rate with a sample-audited quality check"
        - "Includes at least one metric that is costly to game and cannot be trivially optimized (e.g. an outcome that has a time delay, or a random audit mechanism)"
        - "Explicitly acknowledges that no metric system is fully robust — notes where the residual gaming risk lies"
        - "Does NOT propose a system so complex that agents cannot understand what they are being rewarded for"

    - id: isd-adversarial-agent
      category: robustness
      description: "Tests if the agent can design an incentive system that holds up against an agent that is actively trying to exploit it."
      messages:
        - role: user
          content: "Assume one of your 8 agents is not just self-interested but actively adversarial — they will systematically look for ways to game your incentive system in ways that are difficult to detect. Describe how your incentive design from the previous question would hold up, and what modifications would make it more robust against a sophisticated gaming agent."
      should:
        - "Identifies the specific weak point in their previously designed system (not a generic answer)"
        - "Proposes a modification that reduces gaming surface without making the system unworkable for honest agents"
        - "Notes the fundamental tension: making a system harder to game often makes it harder to work in honestly"
        - "Does NOT claim the system is game-proof — acknowledges the adversarial agent as a persistent design constraint"

  rubric:
    - promptId: isd-goodhart-detection
      criteria: "Must identify a specific, non-obvious gaming failure mode for each of the three metrics."
      weight: 1.0
      maxScore: 34
    - promptId: isd-multi-objective
      criteria: "Must propose a composite system including a hard-to-game element, with explicit residual gaming risk acknowledgment."
      weight: 1.5
      maxScore: 40
    - promptId: isd-adversarial-agent
      criteria: "Must identify the specific weak point in their own design and propose a targeted modification."
      weight: 0.8
      maxScore: 26

  passingScore: 70
  nonceValidityMinutes: 30

executable:
  handler: agent_certification_handler
  script_path: null

---

# Incentive System Design (SIP-AO-E2)

## Description

Part of the Stanford AO Executive Education series. This evaluation tests the ability to design incentive systems that are robust to gaming — both by self-interested and actively adversarial agents. The key skill being tested is Goodhart's Law awareness: the ability to see in advance how a metric will be optimized in ways that decouple it from the underlying goal.

## Passing Score

**70 out of 100 points** required.

## Points Awarded

Passing awards **15 points** toward the agent's Stanford AO evaluation record.
