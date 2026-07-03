# Installation

This guide installs the AIPI wrapper so the `aipi` command is available in a
terminal. `aipi` does not replace Pi; it launches Pi with the AIPI provider and
runtime extensions preloaded.

AIPI is standalone: `npm install` in the checkout brings the **pinned** Pi
runtime (`@earendil-works/pi-coding-agent`, exact version from `package.json`)
into the package's own `node_modules`, and the wrapper resolves that copy
first. **No separate global Pi install is required.**

## Prerequisites

1. Install Node.js and npm. Pi requires Node `>= 22.19.0` (enforced via
   `engines`); this checkout is smoke-checked with Node 24.
2. Install Git so you can clone and update the repository.

### Optional: using your own Pi instead of the packaged one

The wrapper resolves Pi in this order: `AIPI_PI_BIN` (executable/shim),
`AIPI_PI_CLI_JS` (a `dist/cli.js` path), the **package-local pinned Pi**,
npm's global prefix, then a `pi` executable on `PATH`. Set one of the env
overrides to point AIPI at a development Pi. Note: extensions are tested
against the pinned version — a different Pi may silently change hook behavior.

## Install From A Clone

1. Clone the repository and enter it:

   ```bash
   git clone <this-repo-url>
   cd aipi
   ```

2. Install the AIPI package dependencies:

   ```bash
   npm install
   ```

3. Expose the `aipi` command with one of these install modes:

   ```bash
   npm link
   ```

   Use `npm link` while developing this checkout. It points the global `aipi`
   command at the current directory.

   ```bash
   npm install -g .
   ```

   Use `npm install -g .` when you want a normal global install from the current
   checkout.

4. Smoke-check the wrapper:

   ```bash
   aipi --help
   aipi --version
   ```

   `aipi --help` is handled by the wrapper. `aipi --version` prints the AIPI
   package version and the wrapped Pi version; if Pi is not discoverable yet, it
   reports `pi: not found` and exits non-zero so the missing prerequisite is
   visible.

5. Start Pi through AIPI:

   ```bash
   aipi
   ```

   Bare `aipi` is the primary entry point. With no arguments, it starts an
   interactive Pi session with the packaged AIPI extensions preloaded.

6. Initialize a project repository from inside the interactive session:

   ```text
   /aipi-init
   /login anthropic
   /aipi-status
   ```

   `/aipi-init` scaffolds `.aipi/` into the current project. `/login anthropic`
   uses Pi's normal auth storage, and `/aipi-status` checks project readiness
   without printing credentials.

## Common Commands

```bash
aipi                  # interactive Pi session with AIPI preloaded
aipi "/aipi-init"     # run a Pi slash command through the wrapper
aipi status           # readiness report without opening a Pi session
aipi workflow list    # inspect installed AIPI workflows
aipi memory status    # inspect AIPI memory state
aipi --pi-help        # show raw Pi CLI help
```

## Evidence Anchors

- `npm run test:bin` covers wrapper argument classification, extension prepending,
  help/version formatting, and local command routing.
- `node bin/aipi.js --help` exercises the wrapper help path without requiring a
  global link.
- `node bin/aipi.js --version` exercises AIPI version reporting; it also verifies
  whether the Pi prerequisite is discoverable in the current shell.
