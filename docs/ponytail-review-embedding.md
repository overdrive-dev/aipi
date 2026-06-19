# ponytail-review embedding review

Source inspected: `https://github.com/DietrichGebert/ponytail`, cloned on
2026-06-15 into a temporary local checkout.

## Verdict

Yes, `ponytail-review` can be used by `aipi`.

There are two viable paths:

1. Install upstream Ponytail as a Pi package when a user wants the complete
   mode system:
   `pi install git:github.com/DietrichGebert/ponytail`
2. Embed the review concept into `aipi` as a native discipline and swarm review
   pass.

For the product baseline, prefer path 2. The upstream package is useful and
already Pi-compatible, but `aipi` needs the behavior tied to BDD contracts,
owned-file scopes, verification evidence, and memory promotion. That argues for
adapting the review pass instead of making Ponytail a hard runtime dependency.

## License

The repository declares MIT license in `LICENSE`, `package.json`, and plugin
metadata. If `aipi` vendors any exact Ponytail text or code, keep the MIT notice
and attribution. If `aipi` only adapts the idea, still cite it in docs because
the review shape is directly inspired by Ponytail.

## What ponytail-review does

`ponytail-review` is a complexity-only code review skill. It does not hunt
correctness, security, or performance issues. It hunts code that can be deleted
or simplified:

- dead code or speculative flexibility;
- hand-rolled standard library behavior;
- dependencies for native platform features;
- abstractions with one implementation;
- equivalent logic that can be shorter.

Its output style is intentionally strict: one line per finding, with a location,
tag, what to cut, and replacement. It ends with a net line-removal estimate, or
declares the diff lean.

## Why it fits aipi

`aipi` already has `scope-discipline` and `native-code`, which prevent bloat
during implementation. `ponytail-review` adds the missing post-implementation
pressure: a dedicated reviewer whose only job is to shrink the diff without
mixing in correctness or security review.

This is useful in the AIPI workflow because:

- autonomous agents tend to overbuild when translating business contracts into
  code;
- complexity review can run after tests pass, so it does not compete with
  root-cause fixing;
- it produces small actionable findings that the orchestrator can accept,
  reject, or turn into follow-up work;
- it aligns with the user's YAGNI requirement and the BDD contract boundary.

## aipi adaptation

Add a first-class `complexity-review` discipline and `complexity-reviewer`
agent.

Runtime behavior:

- runs in feature and bugfix review swarms;
- reads the accepted BDD contract, implementation artifact, diff, and owned-file
  scope;
- reports only deletions/simplifications;
- never applies fixes directly;
- never flags the minimal test or assertion needed to prove non-trivial logic;
- sends correctness, security, or performance concerns to the normal review
  agents instead of mixing them into its own output.

Output format:

```text
<file>:L<line>: <tag>: <what to cut>. <replacement>.
net: -<N> lines possible.
```

Allowed tags:

- `delete`: dead code, unused flexibility, speculative feature;
- `stdlib`: custom code covered by the language standard library;
- `native`: dependency or wrapper covered by the platform/framework;
- `yagni`: abstraction/config/layer with no second use;
- `shrink`: same behavior in fewer lines.

No findings:

```text
Lean already. Ship.
```

## Boundary With Other Reviewers

| Concern | Owner |
|---|---|
| Correctness and regressions | `code-reviewer`, `verifier` |
| Integration wiring | `integration-checker` |
| Security/privacy/production risk | `security-auditor` |
| Business-rule conflict | `business-rule-keeper` |
| Unnecessary complexity | `complexity-reviewer` |

The orchestrator resolves conflicts. A complexity finding cannot delete code
that is required by a BDD scenario, trust boundary, security rule, accessibility
baseline, or verification contract.
