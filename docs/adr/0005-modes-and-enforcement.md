# ADR-0005: Shadow first, enforce narrowly, fail open

Status: accepted (2026-11-10)

## Decision

- Every default policy ships in `shadow`. The gateway sets `enforced` only in `act` mode with an
  engine answer; adapters change behaviour only when `enforced` is true.
- Auto-allow needs p(allow) ≥ 0.95. Paseo never auto-denies permissions in v1; it leaves them
  pending for the user. Claude Code `PreToolUse` and Codex `PreToolUse` may deny from the
  deterministic layer, and from `command-risk` only when enforced.
- Every adapter fails open: gateway down, slow or erroring → the harness's default behaviour,
  no output, exit 0.
- Claude Code auto mode: a hook `allow` does not bypass the classifier
  (anthropics/claude-code#94740), so hooks there only add `ask`/`deny`.

Amendment (2026-11-11): the auto-mode `allow` goes through a `tool.check` mod instead, behind
its own `claude-auto` scope that defaults to `shadow` ([ADR-0007](0007-claude-auto-mode-mod.md)).

## Consequences

A wrong or slow model can only cost friction it would have cost anyway, until a user opts a
policy into `act` after checking `local-decider stats`.
