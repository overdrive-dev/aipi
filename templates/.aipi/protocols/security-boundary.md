# aipi Security Boundary Protocol

Pi extension hooks can enforce workflow policy inside the current Pi process,
but they are not a sandbox and not a privilege boundary.

## Boundary Levels

| Level | Meaning |
|---|---|
| `prompt_only` | Instruction exists, but no runtime block exists. |
| `runtime_gate` | A Pi event can mutate, branch, or require approval. |
| `tool_enforced` | `tool_call` or a tool override blocks a tool call before execution inside the Pi process. |
| `externally_contained` | Execution is isolated outside the Pi process by container, VM, micro-VM, remote sandbox, or equivalent policy-controlled environment. |

## Production Rule

Production, secrets, deploys, destructive commands, and unattended automation
require:

- `tool_call` policy decision;
- human approval artifact when required;
- least-privilege credentials;
- explicit environment boundary;
- rollback and smoke evidence;
- external containment when the work is untrusted, unattended, or high impact.

`BLOCK` means the AIPI runtime refused the tool call in its process. It does not
prove an attacker or prompt-injected repo content could not act through another
path with the same host permissions.

`external` and `container` worker modes are command adapters, not automatic
sandboxes. They count as `externally_contained` only when
AIPI_EXTERNAL_WORKER_COMMAND_JSON or AIPI_CONTAINER_WORKER_COMMAND_JSON points
to a reviewed runner that actually provides the container, VM, remote sandbox,
or equivalent privilege boundary.

## Prompt Injection

Repository content can influence a local agent. AIPI treats that as an expected
local-agent risk. Mitigations are scope control, source attribution, tool policy,
least-privilege credentials, and containment for high-impact work.
