# aipi Business Rules Protocol

The business-rules ledger is the decision substrate for `aipi`. BDD is the
shared language between the client and the agent system.

## Autonomy Law

| Situation | Behavior |
|---|---|
| Covered by rule | Decide autonomously and cite the rule. |
| Gap | Ask one focused business question. The answer becomes a draft rule. |
| Conflict | Ask which rule wins. Record the resolution as a rule. |
| Pure mechanics | Decide autonomously. No rule required. |

## Rule Shape

```text
BR-<id>
  domain: software | design | infra | security | data | compliance
  statement: one business-language sentence describing what must hold
  scenarios: one or more Given / When / Then scenarios
  status: proposed | accepted | deprecated
  source: human, issue, document, or evidence source plus date
  rationale: why this rule exists
  links:
    implements: [symbol | file | test]
    relates: [BR-<id>]
    decided-by: [ADR-<id>]
  last-reviewed: commit SHA or -
```

## Ledgers

- Business rules own WHAT the system must do.
- ADRs own HOW/WHY technical choices were made.
- Knowledge owns reusable findings and gotchas.

## Agent Rules

1. Retrieve only the relevant rule slice.
2. Cite a rule when it affects behavior.
3. Never invent a vacuous rule to satisfy a gate.
4. Propose draft rules through the orchestrator; agents do not write the
   authoritative ledger directly.
5. If no rule is needed, explain why the choice is pure mechanics.
