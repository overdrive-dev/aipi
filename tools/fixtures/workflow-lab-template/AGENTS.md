# Taskboard contributor guide

This is a local full-stack dogfood application. Keep changes small, typed, and covered by tests.

- React client code lives in `src/client`.
- Express API and the in-memory store live in `src/server`.
- Run `npm run check:baseline` before handing off a change.
- Do not edit files under `eval/`; they are external acceptance tests.
- Do not deploy, add credentials, or call external services.
- Preserve existing API response shapes unless the task explicitly changes them.
