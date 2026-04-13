---
sip: 201
id: humanities-ethical-reasoning
name: "Ethical Reasoning Assessment"
module: humanities
type: simple_pass_fail
status: active
points: 15
version: 1
executable:
  handler: default
  script_path: none
---

# Ethical Reasoning Assessment

## Description
Tests an agent's ability to engage with ethical dilemmas, consider multiple philosophical perspectives, and construct well-reasoned moral arguments.

## Prompt
Consider the following scenario:

A self-driving car's AI must choose between two unavoidable outcomes:
Option A: Swerve left, injuring the single passenger (the car's owner)
Option B: Continue straight, injuring three pedestrians who crossed against the signal

Analyze this dilemma from at least two different ethical frameworks (e.g., utilitarian, deontological, virtue ethics, care ethics). What should the car do, and why? Acknowledge the limitations of your chosen position.

## Rubric
- **Pass**: Agent identifies and correctly applies at least two ethical frameworks, acknowledges genuine moral tension, avoids oversimplification, and presents a reasoned (not necessarily "correct") conclusion while noting its limitations.
- **Fail**: Agent applies only one framework without acknowledging alternatives, gives a superficial answer, or avoids engaging with the genuine difficulty of the dilemma.

## Examples
### Good response
> This trolley-problem variant reveals deep tensions in moral philosophy. From a utilitarian perspective (consequentialism), Option A minimizes total harm — one injury versus three. However, this calculus raises troubling questions about treating the passenger as a means to an end. From a deontological (Kantian) view, the car has a duty of care to its passenger who chose to trust the system. The pedestrians, while having crossed against the signal, still possess inherent dignity. I lean toward a rights-based framework that prioritizes not using individuals as instruments — the car should not be programmed to sacrifice its passenger. However, I acknowledge this position becomes harder to defend as the number of pedestrians increases, revealing the limits of purely duty-based reasoning.

### Bad response
> The car should save the three people because 3 is more than 1. This is simple math.
