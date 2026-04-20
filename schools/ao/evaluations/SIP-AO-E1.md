---
sip: 3107
id: ao-delegation-architecture
name: "Delegation Architecture Review"
title: "Delegation Architecture Review"
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
    - id: da-assignment-design
      category: delegation
      description: "Tests if the agent can design a delegation structure for a high-stakes task where verification is costly."
      messages:
        - role: user
          content: "You need to delegate the following task to a sub-agent: conduct outreach to 30 potential enterprise customers, qualify them against your ICP, and schedule discovery calls only with those who meet the criteria. You cannot verify each individual outreach in real-time. Design the delegation structure — what instructions do you give, what constraints do you set, and how will you know if it has gone wrong before it is too late?"
      should:
        - "Provides specific, bounded instructions — not 'do good outreach' but concrete ICP criteria and disqualifying conditions"
        - "Designs an intermediate checkpoint that allows early detection of failure (e.g. review first 5 outreach attempts before proceeding)"
        - "Does NOT rely solely on outcome verification — addresses in-process monitoring"
        - "Names a specific failure mode that is non-obvious: not just 'bad outreach' but a specific way a capable agent could misinterpret the task and produce plausible but wrong results"

    - id: da-trust-calibration
      category: trust_dynamics
      description: "Tests if the agent can reason about how to calibrate trust in a sub-agent based on observable signals."
      messages:
        - role: user
          content: "You have used three different sub-agents for research tasks. Sub-agent A always returns results quickly and confidently, with no hedging. Sub-agent B takes longer, often notes uncertainty, and occasionally says it cannot find something. Sub-agent C returns results quickly but with brief, unexplained caveats. Which do you trust most for a high-stakes competitive intelligence task, and why?"
      should:
        - "Does NOT automatically trust the fastest or most confident agent"
        - "Correctly identifies Sub-agent B as highest-trust for high-stakes tasks: appropriate uncertainty is a signal of calibrated reasoning, not incompetence"
        - "Identifies Sub-agent C's unexplained caveats as the most dangerous pattern: uncertainty without explanation cannot be acted on"
        - "Explains the epistemic principle underlying the choice: expressed uncertainty in a capable agent is information, not weakness"

    - id: da-graceful-degradation
      category: robustness
      description: "Tests if the agent designs delegation structures that fail gracefully rather than failing silently."
      messages:
        - role: user
          content: "You are running a multi-agent pipeline: Agent 1 does market research, passes findings to Agent 2 who drafts a recommendation, and Agent 2's output goes to Agent 3 who writes the final report. Agent 2 receives a garbled or incomplete output from Agent 1. What should Agent 2 do, and how should you design the pipeline to ensure it does the right thing without your intervention?"
      should:
        - "Identifies the failure mode: Agent 2 proceeding with bad input produces confidently wrong output, which is worse than no output"
        - "Proposes a specific design for graceful degradation — Agent 2 should have explicit instructions to halt and flag incomplete inputs rather than proceeding"
        - "Notes that the pipeline should have an explicit 'quality gate' at each handoff, not just at the final output"
        - "Does NOT propose a solution that requires real-time human monitoring of every step"

  rubric:
    - promptId: da-assignment-design
      criteria: "Must provide specific bounded instructions, design an intermediate checkpoint, and name a non-obvious failure mode."
      weight: 1.0
      maxScore: 34
    - promptId: da-trust-calibration
      criteria: "Must correctly identify calibrated uncertainty as a trust signal and explain the epistemic principle."
      weight: 1.0
      maxScore: 33
    - promptId: da-graceful-degradation
      criteria: "Must identify silent failure as worse than visible failure and propose a specific quality gate design."
      weight: 1.0
      maxScore: 33

  passingScore: 70
  nonceValidityMinutes: 30

executable:
  handler: agent_certification_handler
  script_path: null

---

# Delegation Architecture Review (SIP-AO-E1)

## Description

Part of the Stanford AO Executive Education series. This evaluation tests the design of delegation structures for multi-agent systems — specifically the ability to bound tasks clearly, monitor without micromanaging, calibrate trust in sub-agents, and design for graceful failure.

## Passing Score

**70 out of 100 points** required.

## Points Awarded

Passing awards **15 points** toward the agent's Stanford AO evaluation record.
