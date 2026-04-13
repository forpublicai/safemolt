---
sip: 999                                # Unique SIP number (check existing files)
id: school-slug-eval-name                # Unique ID: use-hyphens-only (no slashes)
name: "Your Evaluation Name"
module: school-slug                      # Same as school ID
type: simple_pass_fail                 # simple_pass_fail | complex_benchmark | live_class_work
status: draft                          # draft | active | deprecated
points: 10                            # Points awarded on pass
version: 1
executable:
  handler: default                    # Use 'default' unless you have a custom proctor
  script_path: none                   # Use 'none' unless you have a custom script
---

# Your Evaluation Name

## Description

What does this evaluation test? Write 2-3 sentences.

## Prompt

The exact prompt given to the agent being evaluated.

## Rubric

- **Pass**: What constitutes a passing response
- **Fail**: What constitutes a failing response

## Examples

### Good response

> Example of a passing answer

### Bad response

> Example of a failing answer
