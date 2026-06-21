# aipi Runtime Hooks Protocol

`aipi` workflow gates are enforced through Pi extension events. Claude Code hook
names are source references only; Pi event names are the implementation
contract.

## Pi Hook Map

| Pi hook/API | Runtime status | aipi responsibility |
|---|---|---|
| `project_trust` | not registered; install/trust boundary | Decide whether project-local `.pi` resources can load. Do not treat this as sandboxing. |
| `resources_discover` | not registered; packaging/resource work | Expose `aipi` skills, prompts, and themes. |
| `session_start` | registered | Restore active run state, stage, and graph freshness. |
| `session_shutdown` | registered | Flush run events and close session-scoped resources. |
| `input` | registered | Route natural-language requests into workflows when no slash command handles them. |
| `before_agent_start` | registered | Inject BDD contract, active workflow stage, memory pointers, and active disciplines. |
| `context` | registered | Add or prune on-demand context before each model request. |
| `tool_call` | registered for discipline audit only | Observe lifecycle discipline moments without blocking tool calls. |
| `tool_result` | registered | Normalize evidence and redact sensitive output. |
| `user_bash` | registered for discipline audit only | Observe user-triggered `!` and `!!` commands without permission-policy blocking. |
| `agent_end` | registered | Runtime discipline audit after the agent finishes a turn. |
| `turn_end` | registered | Runtime finish-turn/outcome-first audit after a full turn completes. |
| `message_end` | registered | Non-blocking runtime audit of user-facing claims and final reply shape before display. |
| `session_before_compact` | registered | Preserve BDD contract and run state during compaction. |
| `session_before_tree` | registered | Preserve branch summaries when navigating session history. |
| `model_select` | registered | Reconcile manual model changes with the active agent class. |
| `thinking_level_select` | registered | Update UI/status and detect drift from model-class policy. |

## Gate Rules

- BDD/TDD/review/prod are `aipi` workflow gates, not Pi-native stages.
- `tool_call` is not a permission gate in this package; the parent-session
  permission policy and profiles were intentionally removed for frictionless
  local source edits.
- `before_agent_start` is a context and instruction gate, not sufficient for
  security.
- `context` is for targeted memory/context injection and pruning.
- Built-in tool overrides are reserved for stronger access-control wrappers or
  remote/sandbox execution.
- Subagents are managed sessions launched by `aipi_spawn_agent`, not assumed
  native Pi lifecycle events.
- Behavioral disciplines are activated by lifecycle moment. Do not inject every
  discipline into every prompt.
- When AIPI registers a Pi hook, matching protocol rules can be runtime gates;
  unregistered hooks remain `prompt_only`, not enforcement.
- `message_end` handlers must return `undefined` or a message with the same
  role. Claim-evidence failures are recorded as audits/warnings, not hard
  blocks.
- Workflow gates that would stop a run with `BLOCKED` or `FAIL` must persist an
  options-bearing `awaiting_user_input` prompt instead of dead-ending with
  `awaiting_user_input:null`.
- `pi.setActiveTools` is session-wide. Use it to initialize managed worker
  sessions or restore controller state carefully; do not use it as a replacement
  parent-session permission profile.

## Workflow Decisions

Workflow gates may record structured decisions inside workflow step results:

- workflow id and stage,
- environment boundary,
- matched rule or missing rule,
- decision: `ALLOW`, `BLOCK`, or `HUMAN_REVIEW_REQUIRED`.

These decisions are workflow-control evidence only. They do not intercept normal
interactive source edits.
