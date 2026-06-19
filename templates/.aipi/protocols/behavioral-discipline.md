# aipi Behavioral Discipline Protocol

Behavioral disciplines define how agents behave while workflows define what
process they follow.

A discipline is a small lifecycle rule set that can be injected into an
orchestrator or subagent only when the current stage needs it. Disciplines are
not agent identities and are not global prompt wallpaper.

## Lifecycle Activation

| Moment | Discipline |
|---|---|
| Start of multi-step work or exploration | `context-thrift` |
| Before code edits | `scope-discipline`, `native-code` |
| Before claims or status reports | `prove-it` |
| Before state-changing tools | `prove-it`, plus runtime policy gate |
| Before ending a tool-using turn | `finish-turn`, then `outcome-first` |
| Before business-visible choices | `contract-first` |
| During review swarm for diff bloat | `complexity-review` |

## Runtime Rules

- `before_agent_start` injects active disciplines for the current workflow
  stage and agent role. Enforcement level: `runtime_gate` when the hook is
  registered and active, `prompt_only` before then.
- `context` may inject or remove discipline details when context pressure is
  high. Enforcement level: `runtime_gate` when the hook is registered and
  active.
- `tool_call` enforces discipline-backed gates for writes, shell commands,
  production actions, and owned-file boundaries. Enforcement level:
  `tool_enforced` only after the policy layer exists.
- `agent_end` and `turn_end` run finish-turn and run-state checks at turn
  boundaries. `message_end` audits final replies for evidence rungs and
  outcome-first shape. Enforcement level: `prompt_only` until those specific
  hooks are registered by the runtime.
- Subagents receive only the disciplines needed for their assigned artifact.

## Precedence

When active disciplines conflict, use this order:

1. runtime safety and production policy;
2. `contract-first`;
3. `prove-it`;
4. `scope-discipline`;
5. `native-code`;
6. `context-thrift`;
7. `finish-turn`;
8. `outcome-first`;
9. `complexity-review`.

An agent that finds a business-rule gap must stop for rule clarification even
if `finish-turn` would otherwise encourage finishing reversible work.

## Discipline Format

Each discipline file should stay short and use this shape:

1. trigger,
2. principle,
3. rules,
4. red flags,
5. evidence or pressure scenarios.

Rules that are not backed by pressure scenarios must be marked as predicted.
Observed rules require a baseline failure and a verified flip.

## Pressure-Test Requirement

New discipline rules follow a RED/GREEN loop:

1. capture a pressure scenario that makes a target model fail;
2. record the baseline failure and the model's rationale;
3. add or refine the rule;
4. rerun with the discipline injected;
5. record whether the failure flipped;
6. generalize with a second fact pattern when an example may have taught the
   answer too narrowly.
