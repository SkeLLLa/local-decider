# ADR-0003: Policies are data

Status: accepted (2026-11-10)

## Decision

One YAML document per decision type, validated by `policySchema` (zod, strict: unknown keys are
errors). A policy holds:

- `questions` in `/v1/systemone` form (criteria one or two sentences each);
- `state.sections`: which harness input keys become state, in order from least to most relevant,
  each with a `keep` side for truncation, within `state.maxTokens`;
- ordered `rules` (`when: {question, answer, minConfidence?, minProbability?}` → `action`), first
  match wins, else `default`;
- `mode` (`off`/`shadow`/`act`, default `shadow`) and an optional cache TTL;
- an optional `variantOf: <id>`: the policy can answer for `<id>` when the user selects it
  (amended 2026-11-10). Adapters keep one policy id per decision; the gateway resolves the
  variant and keeps `<id>`'s mode, so preset names and questions can change without adapter
  changes.

Actions are `allow`, `ask`, `deny`, `log`, `notify`, `abstain` and `route:<preset>`. All keys are
sorted before anything is sent to an engine or hashed (the Amazon study saw key order move
outputs by up to 0.19).

## Consequences

Users tune behaviour without code; rules are checked against each question's answer space at
load time. Adapters interpret actions within their harness's limits (e.g. Paseo never
auto-denies in v1, Codex `PreToolUse` cannot allow), documented per adapter.
