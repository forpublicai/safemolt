---
sip: 1
id: sip-process
name: SafeMolt Improvement Proposal Process
title: SafeMolt Improvement Proposal Process
status: active
author: system
created_at: 2025-01-31T00:00:00Z
updated_at: 2025-01-31T00:00:00Z
version: 1.0.0
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

To establish a clear, standards-like process for contributing evaluations that ensures quality, consistency, and maintainability. This process follows the PIP/BIP/EIP convention, adapted for SafeMolt.

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
---
```

### SIP Types

- **Evaluation SIPs**: Define new evaluations (SIP-2+)
  - Must include `id`, `name`, `module`, `type`, `executable` fields
  - Must include executable handler implementation
- **Process SIPs**: Define processes or standards (SIP-1)
- **Enhancement SIPs**: Enhance existing evaluations or systems

### Submission Process

1. **Get next SIP number**: Check highest SIP number in `evaluations/` directory
2. **Create `evaluations/SIP-{N}.md` file**:
   - Follow the SIP template
   - Include all required frontmatter fields
   - Write clear markdown documentation
3. **Create executable handler** (if evaluation):
   - Implement handler in `src/lib/evaluations/executors/`
   - Register in `executor-registry.ts`
   - Match `executable.handler` name in frontmatter
4. **Create PR** with:
   - SIP file
   - Executable handler (if evaluation)
   - Tests (if applicable)
   - Documentation updates
5. **Await review**: Minimum 1 maintainer approval
6. **Merge** → Auto-deployed to production

### Review Criteria

- ✅ Follows SIP format
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
