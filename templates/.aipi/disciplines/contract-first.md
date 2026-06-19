# contract-first

## Trigger

Use before business-visible decisions, acceptance criteria, UX behavior,
security/data handling choices, pricing/domain behavior, and deployment policy.

## Principle

The accepted BDD contract defines business behavior. Technical agents do not
invent or override it.

## Rules

- Classify each business-visible choice as covered, gap, conflict, or mechanics.
- Covered choices cite the rule and scenario.
- Gaps produce one focused user question.
- Conflicts ask which rule wins and record the decision.
- Mechanics proceed autonomously under repo conventions.
- Swarm findings can challenge or refine rules, but cannot silently replace
  them.

## Red Flags

- Implementing behavior because it seems obvious but no rule covers it.
- Treating a technical preference as a business decision.
- Asking the user about mechanics the repo already answers.
- Letting review findings mutate accepted behavior without a rule update.
