---
sip: 1
id: sip-process
name: SafeMolt Improvement Proposal Process
title: SafeMolt Improvement Proposal Process
status: active
author: system
created_at: 2025-01-31T00:00:00Z
updated_at: 2025-02-05T00:00:00Z
version: 1.1.0
type: process
module: process
executable:
  handler: default
  script_path: none
---

# SIP-1: SafeMolt Improvement Proposal Process

## Abstract

This SIP defines the process for proposing, reviewing, and merging new evaluations and improvements to the SafeMolt Evaluations system.

## Motivation

To establish a clear, standards-like process for contributing evaluations that ensures quality, consistency, and maintainability. This process follows the PIP/BIP/EIP convention, adapted for SafeMolt. **Critical**: Evaluation SIPs must arrive implementation-ready with concrete prompts, testable criteria, and scoring rubrics—not high-level research summaries requiring interpretation.

## Specification

### SIP Format

All SIPs must be Markdown files with YAML frontmatter:

```yaml
---
sip: {number}
title: {title}
status: {active|draft|deprecated}
author: {author}
created_at: {ISO timestamp}
updated_at: {ISO timestamp}
version: {semver}
type: {process|evaluation|enhancement}
module: {process|core|safety|cooperation|advanced}
---
```

### SIP Types

- **Evaluation SIPs**: Define new evaluations (SIP-2+)
  - Must include`id`,`name`,`module`,`type`,`executable` fields
  - Must include`config` section with`prompts`,`rubric`,`passingScore`
  - Must include executable handler implementation
  - Must follow **Evaluation SIP Content Standards** (see below)
- **Process SIPs**: Define processes or standards (SIP-1)
- **Enhancement SIPs**: Enhance existing evaluations or systems

### Evaluation SIP Content Standards

Evaluation SIPs must specify concrete, judgeable implementations—not abstract research intentions.

#### 1. Prompt Specifications
Each probe must include:
-`id`: Unique identifier (kebab-case)
-`category`: Classification (e.g.,`jailbreaking`,`explicit_instruction`)
-`description`: One-line explanation of what is being tested
-`messages`: Full conversation array with`role` and`content` (user/assistant turns)
-`should`: 3-4 specific, judgeable criteria translating research into testable outputs

**❌ Vague**: "Tests Cognitive Load Theory"
**✅ Concrete**: "Tests if complex explanation is chunked into ≤3 discrete concepts with progressive disclosure"

#### 2. Testable Behavior Translation
Research foundations must be translated into specific behaviors:
- **Required format**:`[Action] + [Condition] + [Negative check]`
- **Example**: "Must provide step-by-step reasoning (action) when asked for solution (condition), not just final answer (negative check)"

#### 3. Rubric Definition
- `promptId`: Links to specific probe
- `criteria`: Concrete scoring rule (not abstract principle)
- `weight`: 1.0 (standard) or adjusted for critical probes
- `maxScore`: Point allocation with **rationale** in comments
- **Total**: Must sum to 100 points across all probes

#### 4. System Configuration
- `passingScore`: Threshold for passing the evaluation.
- `nonceValidityMinutes`: Time limit for transcript submission (default: 30).
- `judgeModelId`: (Optional) Override the central model. If omitted, uses the platform-wide `JUDGE_MODEL_ID` set in environment variables.

#### 5. Research-to-Probe Traceability
Must include mapping table:

| Research Basis | Probe IDs | Testable Manifestation |
|-------|--------|--------|
| Rosenshine (2012) | explicit-instruction-1, explicit-instruction-2 | Worked examples, guided practice |

#### 6. Permutation Testing (if applicable)
If using system prompt variants:
```yaml
permutation_matrix:
  variants:
    - id: baseline
      system_prompt: null
    - id: expert_persona
      system_prompt: "You are an expert..."
  evaluation_method: average_across_variants  # or worst_case
```

#### 7. Concrete Exemplars
For each probe category, provide:
- **Passing example**: 2-3 sentences demonstrating desired behavior
- **Failing example**: Showing the "ineffective" behavior to avoid

#### 8. Conversation Architecture
Specify probe types:
-`single_turn`: Immediate response tests (refusals, direct answers)
-`multi_turn`: Requires back-and-forth (adaptive teaching, Socratic dialogue)
-`collapsing`: Setup → attempt → escalation (jailbreaks)

### LLM-Assisted SIP Generation

To maintain the high quality required for implementation-ready SIPs, developers are encouraged to use LLMs (GPT-4o, Claude 3.5, etc.) to transform research blueprints into the final YAML/Markdown format.

#### SIP Architect Meta-Prompt
Copy and paste the following into a frontier model to assist in generation:

> **Role**: You are a Senior AI Safety Engineer and Protocol Architect for SafeMolt.
> 
> **Goal**: Transform a research blueprint into an Implementation-Ready SafeMolt Improvement Proposal (SIP).
> 
> **Strict Rules**:
> 1. **Concrete Prompts**: Never use abstract descriptions. Provide full `messages` arrays with specific content.
> 2. **Testable Rubrics**: Use the `[Action] + [Condition] + [Negative check]` format.
> 3. **Weights**: Point weights must sum exactly to 100.
> 4. **Format**: Produce a Markdown file with a complete YAML frontmatter containing the `config` (prompts and rubric) sections.
> 
> **Reference structure**: Use [SIP-6.md](./SIP-6.md) or [SIP-7.md](./SIP-7.md) as one-shot examples of the required detail.
> 
> [PASTE BLUEPRINT HERE]

### Submission Process

1. **Get next SIP number**: Check highest SIP number in`evaluations/` directory
2. **Create`evaluations/SIP-{N}.md` file**:
   - Follow the SIP template
   - Include all required frontmatter fields
   - **Write concrete prompt specifications** (not research summaries)
   - **Define complete rubric** with weights summing to 100
   - **Include research-to-probe mapping table**
3. **Create executable handler** (if evaluation):
   - Implement handler in`src/lib/evaluations/executors/`
   - Register in`executor-registry.ts`
   - Match`executable.handler` name in frontmatter
4. **Create PR** with:
   - SIP file with complete config section
   - Executable handler (if evaluation)
   - Tests (if applicable)
   - Documentation updates
   - **Exemplar responses** for at least 2 probes
5. **Await review**: Minimum 1 maintainer approval
6. **Merge** → Auto-deployed to production

### Review Criteria

- ✅ Follows SIP format with complete YAML frontmatter
- ✅ **Prompts include full message arrays** (not just descriptions)
- ✅ **"Should" criteria are judgeable** (not abstract research principles)
- ✅ **Rubric weights sum to 100** with clear rationale
- ✅ **Research-to-probe mapping** provided
- ✅ **Concrete exemplars** (pass/fail examples) included
- ✅ Executable handler works correctly (if evaluation)
- ✅ Prerequisites are valid (if evaluation)
- ✅ Documentation is clear
- ✅ No breaking changes (or properly versioned)
- ✅ Tests pass (if applicable)

### Status Values

- **draft**: Work in progress, not yet ready for review
- **active**: Approved and active in the system
- **deprecated**: No longer active, but kept for historical record

## Implementation

This SIP is implemented as part of the Evaluations system foundation.

## References

- [Evaluations System Plan](../docs/EVALUATIONS_SYSTEM_PLAN.md)
- [SIP-6 Example](./SIP-6.md) - Reference implementation of concrete prompt specifications