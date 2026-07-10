# Installation

`aipi` is a wrapper that launches [Pi](https://pi.dev) with the AIPI provider and
runtime extensions preloaded. It does **not** replace Pi and it does **not** require
you to install Pi first.

AIPI is standalone: the Pi runtime (`@earendil-works/pi-coding-agent`, the exact
pinned version in `package.json`) is a **normal dependency**, so installing aipi
pulls Pi into the package's own `node_modules`, and the wrapper resolves that copy
first. **There is no separate "install Pi" step and no global Pi is required.**

## TL;DR

```bash
npm install -g github:overdrive-dev/aipi   # installs aipi AND the pinned Pi together
aipi setup                                 # check the workstation can run projects
aipi                                       # start an interactive session
```

## Prerequisites

- **Node.js ≥ 22.19.0** and npm (enforced via `engines`; the pinned Pi requires it).
  Smoke-checked with Node 24.
- **Git** — to install/update from the repo. On Windows make sure Git is on `PATH`
  (e.g. `C:\Program Files\Git\cmd`); `aipi setup` flags it if it is missing.
- Optional, checked (and fixable) by `aipi setup`: **Docker**, **Playwright**,
  **Ollama** with the `bge-m3` embedding model (used by the code-graph semantic index;
  it degrades loudly to lexical search when absent).

Pi itself is **not** a prerequisite — it is installed as a dependency of aipi (below).

## Install

Releases are published to **GitHub only** (there is no npm publish), so install from
the repository.

### Option A — global install from GitHub (end users)

```bash
npm install -g github:overdrive-dev/aipi
```

`npm install` fetches the pinned Pi as a normal dependency, so this single command
brings both aipi and its Pi runtime. No separate Pi download.

### Option B — from a clone (contributors)

```bash
git clone https://github.com/overdrive-dev/aipi.git
cd aipi
npm install          # materializes the pinned Pi into ./node_modules
npm link             # dev install: exposes the `aipi` CLI on PATH (points at this checkout)
#   or
npm install -g .     # a normal global install from the checkout
```

### Smoke-check the wrapper

```bash
aipi --version   # prints the AIPI package version AND the wrapped Pi version
aipi --help
```

`aipi --version` reports both versions; if Pi is not discoverable it prints
`pi: not found` and exits non-zero, so a missing prerequisite is visible immediately.

## Prepare the workstation

```bash
aipi setup           # environment doctor: Node, Git, Pi (always); Docker, Playwright, Ollama (optional)
aipi setup --fix     # auto-fixes what it can: `npx playwright install`, `ollama pull bge-m3` (~1.2GB first pull)
```

`aipi setup` (also `/aipi-setup` inside a session) verifies the workstation can run
projects the way AIPI drives them, per `.aipi/environment.json`.

## Set up a project

```bash
cd <your-project>
aipi                 # starts an interactive Pi session with the AIPI extensions preloaded
```

Inside the session:

```text
/aipi-init           # scaffold the .aipi/ overlay into this repo
/login anthropic     # Claude subscription via OAuth (vendored AIPI provider)
/login xai-auth      # Grok via OAuth (vendored AIPI provider; SuperGrok / X Premium+)
/aipi-status         # readiness report, no credentials printed
```

Provider logins use Pi's normal auth storage (`~/.pi/agent/auth.json`), never the repo.
The Anthropic (Claude OAuth) and xAI (Grok OAuth) providers ship **vendored inside aipi**
and are preloaded — no extra install. For GPT models, log in to `openai-codex`.

### Models and per-role model classes

- New model ids (e.g. `claude-sonnet-5`, `gpt-5.6-sol`) are added through Pi's
  `~/.pi/agent/models.json`; the vendored xAI provider lists Grok ids itself.
- Configure the model topology with `aipi effort` (aliased `aipi models`):

  ```bash
  aipi effort setup     # zero flags: the doer defaults to the current authed model,
                        # so a single-provider machine configures out of the box
  # or set it explicitly, including the orchestrator (default session model):
  aipi effort setup --orchestrator anthropic/claude-opus-4-8:high \
                    --doer anthropic/claude-opus-4-8:high \
                    --adversarial anthropic/claude-opus-4-8:high
  ```

  The interactive wizard prompts the **orchestrator** (the default session model, written
  to Pi's `settings.json`) first, then the 4 buckets (planner / adversarial / doer /
  mover), offering each chosen model **only the thinking levels it actually supports**.
  You can also bind capability classes directly by editing `.aipi/model-capabilities.json`.
  Same-family adversarial is allowed (it just warns); a distinct family is recommended.

## Optional: point AIPI at your own Pi

The wrapper resolves Pi in this order:

1. `AIPI_PI_BIN` — an executable/shim,
2. `AIPI_PI_CLI_JS` — a `dist/cli.js` path,
3. **the package-local pinned Pi** (resolves here on a clean install),
4. npm's global prefix,
5. a `pi` executable on `PATH`.

Set one of the env overrides to run against a development Pi. Extensions are tested
against the pinned version, so a different Pi may silently change hook behavior.

## Common commands

```bash
aipi                  # interactive Pi session with AIPI preloaded
aipi setup [--fix]    # environment doctor
aipi "/aipi-init"     # run a Pi slash command through the wrapper
aipi status           # readiness report without opening a Pi session
aipi workflow list    # inspect installed AIPI workflows
aipi memory status    # inspect AIPI memory state
aipi effort status    # show the configured per-role model topology
aipi update --dry-run # print the Pi/AIPI update plan without changing anything
aipi --pi-help        # raw Pi CLI help
```

## Evidence anchors

- `npm run test:bin` covers wrapper argument classification, extension prepending,
  Pi resolution (including the package-local pinned Pi), help/version formatting, and
  local command routing.
- `node bin/aipi.js --help` exercises the wrapper help path without a global link.
- `node bin/aipi.js --version` exercises version reporting and whether the Pi
  prerequisite is discoverable in the current shell.
