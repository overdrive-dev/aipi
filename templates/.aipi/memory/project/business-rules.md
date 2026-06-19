---
type: business-rule
owner: product
status: active
last_reviewed: -
---

# Business Rules

## Current truth

No accepted business rules have been recorded yet.

Agents must classify business-visible decisions as:

- covered by an accepted rule,
- gap requiring one focused user question,
- conflict requiring user resolution,
- pure mechanics requiring no rule.

## Rule Template

```text
### BR-001 - <business-language title>
- **domain:** software | design | infra | security | data | compliance
- **statement:** <what must be true, not how to implement it>
- **scenarios:**
  - Given <context>, When <action>, Then <outcome>
- **status:** proposed | accepted | deprecated
- **source:** <human/source + date>
- **rationale:** <why this exists>
- **links:** implements:[], relates:[], decided-by:[]
- **last-reviewed:** -
```

## Open questions

- What is the first accepted behavior contract for this project?

## Timeline

- created: Seeded by `aipi` project template.
