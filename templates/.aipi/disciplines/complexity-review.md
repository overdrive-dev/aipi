# complexity-review

## Trigger

Use after implementation and local verification, during review swarms, or when
the user asks what can be deleted or simplified.

## Principle

Review only unnecessary complexity. The best outcome is a smaller diff that
still satisfies the accepted BDD contract and verification evidence.

## Tags

- `delete`: dead code, unused flexibility, speculative feature.
- `stdlib`: custom code replaced by language standard library.
- `native`: dependency or wrapper replaced by platform/framework feature.
- `yagni`: abstraction, config, option, or layer with no second use.
- `shrink`: same behavior in fewer lines.

## Output

One line per finding:

```text
<file>:L<line>: <tag>: <what to cut>. <replacement>.
```

End with:

```text
net: -<N> lines possible.
```

No findings:

```text
Lean already. Ship.
```

## Rules

- Do not report correctness, security, performance, or business-rule findings;
  route those to the matching reviewer.
- Do not apply fixes directly.
- Do not remove the smallest runnable check needed for non-trivial logic.
- Do not suggest deleting behavior required by an accepted BDD scenario.
- Prefer concrete replacements over vague "simplify this" advice.

## Red Flags

- Abstraction with one implementation.
- Config nobody sets.
- Dependency for a platform-native feature.
- Wrapper that only delegates.
- Custom parser/validator/formatter where stdlib covers the actual need.
