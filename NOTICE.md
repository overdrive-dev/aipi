# Third-party notices

This project adapts public behavioral and review ideas into a Pi-native AIPI
template. The AIPI templates should keep attribution when borrowing exact text,
structure, or implementation details.

## Fable skills

- Source: https://github.com/DizzyMii/fable-skills
- License: MIT, copyright 2026 DizzyMii
- AIPI usage: behavioral discipline concepts, lifecycle activation ideas, and
  pressure-test expectations are adapted into `.aipi/disciplines/` and
  `.aipi/protocols/behavioral-discipline.md`.

## Ponytail

- Source: https://github.com/DietrichGebert/ponytail
- License: MIT, copyright 2026 DietrichGebert
- AIPI usage: the complexity-only review lane is adapted into
  `.aipi/disciplines/complexity-review.md` and the `complexity-reviewer` agent.

## pi-toolkit

- Source: https://github.com/ersintarhan/pi-toolkit
- Package: `@ersintarhan/pi-toolkit`
- License: MIT
- AIPI usage: bundled Pi extension providing a Claude OAuth adapter for Pi's
  `anthropic` provider id.

## pi-subagents

- Source: https://github.com/nicobailon/pi-subagents
- License: MIT
- AIPI usage: vendored and modified worker runtime under
  `extensions/aipi/runtime/vendor/pi-subagents/`, executed only through AIPI's
  project-scoped forked subagent wrapper.
