# CLAUDE.md — working rules for the `aipi` engine repo

`aipi` is the **engine**: a Pi package (extension + CLI wrapper + `.aipi/` template
overlay) that instruments *client* repos (e.g. `nora-app` / NoraCare). This file
governs how an agent works **in this repo**. Read it before acting.

## Cardinal rule: never act on client repos

- **Do not edit, branch, commit, run builds/tests, or open PRs in any consumer repo**
  (NoraCare / `nora-app`, or any other project that installs aipi).
- Client repos are **read-only**, and only to *capture inputs* — reproduce a symptom,
  read code / paths / config — that inform a fix **at the root of `aipi`**.
- Every behavior or config change lands **here, in the engine**, and reaches clients via
  a release + `aipi update`. **No per-client edits, ever.**
- If a task looks like it needs changing a client repo, **stop and surface it** — the fix
  almost always belongs in the engine. Running the client's own backlog/work is out of scope.

## Engine vs template (where a fix goes)

- **Behavior / logic → `extensions/aipi/**`** (the engine; loaded directly by the `aipi`
  wrapper). Clients keep no copy, so a package update is enough — this is what makes
  "one update is enough" true.
- **`templates/.aipi/**` are COPIED into each client's `.aipi/` at init/onboard**, and the
  runtime reads some of them from the *client* dir (`runtime-contract.json`,
  `model-classes.yaml`, `agents/catalog.yaml`, …). A behavior fix placed in a template
  becomes per-client config that drifts. Use templates only for initial scaffolding.

## Release / deploy model (hybrid: two checkouts, decoupled)

- **Dev clone** — where you develop. May be dirty / on feature branches. **NOT** what
  clients load. (This machine: `C:\Users\Visitante\Documents\Github\aipi`.)
- **Release checkout** — a **clean** checkout on branch `release`, with
  `core.autocrlf=false`. The global `aipi` (npm junction) points here; this is the engine
  clients load. (This machine: `C:\Users\Visitante\Documents\Github\aipi-release`.)

Cut a release:

1. Branch from `main`, make the change, add a regression test, PR, **squash-merge** to `main`.
2. `git push origin main:release` — fast-forward `release` to `main`. (Optional: `git tag`.)
3. Each client: `aipi update` (= `git pull --ff-only` on the release checkout + `npm ci`),
   then **restart the session**. One command; nothing per client.

`aipi update` runs **`npm ci`** (never mutates `package-lock`) so the release checkout stays
clean and consecutive updates keep pulling. Keep the release checkout **clean + tracking**,
or the `--ff-only` pull is silently skipped (frozen engine).

## Dev practices in this repo

- **Never commit directly to `main` or `release`** — branch (`fix|feat/<slug>`) → PR →
  squash-merge.
- **Root cause + regression test** that fails before and passes after. Targeted:
  `node tools/test-<area>.mjs`; templates: `node tools/validate-aipi-templates.mjs`; full
  chain: `npm test` (note: live/credentialed suites need OAuth + network).
- **Commit only your own files.** The working tree may carry pre-existing noise that isn't
  yours — never stage it.
- **Verify, don't trust prose**: reproduce or exercise the real code/command before claiming
  a result.
