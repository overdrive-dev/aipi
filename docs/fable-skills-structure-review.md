# fable-skills structure review for aipi

Source inspected: `https://github.com/DizzyMii/fable-skills`.

License note: the upstream repository declares MIT license. AIPI adapts the
behavioral discipline shape and lifecycle ideas; keep attribution in `NOTICE.md`
when carrying these ideas forward.

Source inspected: `https://github.com/DizzyMii/fable-skills`, cloned on
2026-06-15 into a temporary local checkout.

## What the repo contains

The repo is small and deliberately shaped:

- six Markdown skills under `skills/fable-*`;
- one lifecycle activation block in `claude-md-block.md`;
- install scripts for PowerShell and POSIX shell;
- testing records under `docs/superpowers/testing/`;
- a design spec and implementation plan under `docs/superpowers/`;
- GitHub templates that require pressure scenarios and baseline failures before
  new rules are accepted.

The six skill files are short enough to be read whole:

| Skill | Local line count | Behavioral concern |
|---|---:|---|
| `fable-context-thrift` | 46 | exploration efficiency and context spend |
| `fable-finish-your-turn` | 51 | persistence through reversible in-scope work |
| `fable-prove-it` | 56 | verification claims and state-changing actions |
| `fable-scope-discipline` | 54 | narrow, reviewable diffs |
| `fable-outcome-first` | 73 | direct user-facing answers |
| `fable-native-code` | 86 | local code idiom and no defensive bloat |

## Why this changes aipi

This is not mainly useful as a prompt pack. The important design move is a
separate behavioral discipline layer:

- workflows define the process;
- agents define roles;
- hooks enforce runtime policy;
- disciplines define the behavioral contract that applies at lifecycle
  moments.

That fits `aipi` better than putting every rule inside every agent prompt. The
orchestrator can inject only the discipline needed for the current phase, which
keeps context small and makes failures easier to test.

## Key design patterns to port

### 1. Lifecycle activation

The activation block maps each discipline to a moment, not a topic. That is the
right shape for `aipi`.

For Pi, the activation should move into extension logic:

| Lifecycle moment | aipi discipline | Pi surface |
|---|---|---|
| task start / exploration | `context-thrift` | `input`, `before_agent_start`, `context` |
| before code edits | `scope-discipline`, `native-code` | `before_agent_start`, `tool_call` |
| before claims | `prove-it` | `message_end`, run-state evidence |
| before state-changing commands | `prove-it`, policy decision | `tool_call`, `user_bash` |
| before ending a tool turn | `finish-turn`, `outcome-first` | `message_end` |
| before business-visible choices | `contract-first` | `before_agent_start`, workflow gate |

### 2. TDD for behavior

Rules should earn their place by flipping model failures, not by sounding
reasonable. `aipi` should keep a pressure-eval harness:

1. RED: write a pressure scenario and run it without the new discipline.
2. GREEN: add the smallest rule, example, or red flag that addresses the
   observed failure.
3. VERIFY: rerun the same scenario with the discipline injected.
4. GENERALIZE: rerun with a second fact pattern when the example might be
   overfit.

This matters for `aipi` because it will run multiple model families. We should
pressure-test model classes, not only individual providers.

### 3. Anti-rationalization tables

The most portable part of each skill is the "bad excuse -> rebuttal" structure.
For `aipi`, use the neutral name `anti_rationalizations` and store whether each
row is:

- `observed`: captured from a baseline run;
- `predicted`: added from design judgment;
- `retired`: no longer active, retained for history.

### 4. Examples are tests

The verification log showed that a bad example can override the written rule.
For `aipi`, every discipline example must demonstrate the hardest case and must
not model a forbidden pattern. Treat examples as executable test fixtures, not
illustrations.

### 5. Claims need rungs

`prove-it` maps cleanly into `aipi` run state:

- `written`: file/artifact exists;
- `ran`: command executed without error;
- `verified`: behavior was observed against the BDD scenario;
- `blocked`: verification could not run and the reason is recorded.

The final verifier and the orchestrator should not allow "done" unless the
target rung required by the workflow was actually reached.

## What not to copy directly

- Do not copy the Claude install path or activation block as-is.
- Do not make all six disciplines permanent global context.
- Do not claim this transfers raw reasoning capability.
- Do not accept new AIPI discipline rules without a pressure scenario.
- Do not use transcripts from one model family as proof for all model classes.

## aipi structure change

Add a first-class `disciplines` layer:

```text
templates/
  .aipi/
    disciplines/
      catalog.yaml
      context-thrift.md
      finish-turn.md
      prove-it.md
      scope-discipline.md
      native-code.md
      outcome-first.md
      contract-first.md
    evals/
      README.md
      pressure-scenarios.md
```

At runtime, `aipi` should select active disciplines from workflow stage, agent
role, tool type, and evidence state. Disciplines are not agents and are not
workflows. They are small, testable behavioral contracts injected only when
they change the next action.
