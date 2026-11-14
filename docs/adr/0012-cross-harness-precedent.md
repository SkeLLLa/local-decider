# ADR-0012: Cross-harness precedent and learning from answers

Status: proposed (2026-11-14)

Extends [ADR-0006](0006-outcome-precedent.md) and [ADR-0007](0007-claude-auto-mode-mod.md).

## Context

Precedent (ADR-0006) is the only way the decider learns from answers. Today it works in Paseo
only:

- **Keys never match across harnesses.** The key hashes the policy id, `input.project` and the
  subject. The hooks and the Claude Code mod send `project` as `name (cwd)`
  (`hooks/src/permission-input.ts`), while Paseo sends the raw cwd
  (`paseo-plugin/server/history.ts`). The mod and the hooks also build the subject slightly
  differently (`notebook_path` vs `filePath`, `command` only for `Bash`).
- **Classifier verdicts are dropped.** The mod posts `{source: classifier}` outcomes without the
  report token, so the gateway stores them as `source: unverified, verified: false`, and the
  precedent store ignores them. The original source is overwritten, so even stats lose it.
- **Plain Claude Code and Codex hooks report no outcomes.** They see only `PreToolUse`,
  `PermissionRequest`, `Stop` and `UserPromptSubmit`; nothing after a prompt resolves.
- **First verified outcome wins.** An early low-trust outcome would block a later user answer.
- **The log is hash-only.** Nothing can be retrained or calibrated per request from it beyond the
  stored answer probabilities.

## Decision

### 1. One canonical precedent key

- The gateway, not the adapters, derives the key's project from a `cwd` input:
  `realpath`-free lexical normalisation, then the git work-tree root when the adapter supplies it
  (`input.repoRoot`), else the cwd. Adapters keep sending their display `project` for the model;
  the key uses `projectKey`.
- One `canonicalSubject(tool, toolInput, cwd)` in `packages/core/src/subject.ts` is the only
  subject builder. The hooks, the mod and Paseo call it with their native tool names mapped to a
  shared vocabulary (`Bash`/`shell`/`exec_command` → `shell`; `Edit`/`Write`/`MultiEdit`/
  `apply_patch` → `edit`; `NotebookEdit` → `notebook`; MCP tools keep `mcp:<server>:<tool>`).
- Key = `sha256(keyVersion, policyId, projectKey, canonicalSubject)`, `keyVersion = 2`. The
  harness is not in the key, so an answer in one harness counts in the others for the same
  project and request.
- Migration: decisions keep their v1 `precedent_key`; a new `precedent_key_v2` column is written
  from now on. The store reads only v2. Old evidence ages out within `maxAgeDays` (14 days);
  that is acceptable and keeps the migration trivial.

### 2. Decision receipts: verified outcomes without the global token

- `POST /v1/decide/*` returns a `receipt`: `base64url(HMAC(receiptKey, decisionId ‖ sources ‖
  expiry))`, where `sources` is the set the caller may later claim, and `receiptKey` is a 0600
  file next to the report token.
- The gateway grants `sources` by request shape, never by request content:
  - mod requests (`scope: claude-auto`): `[classifier]`;
  - hook requests: `[harness]`;
  - Paseo requests keep using the report token for `user` and `supervised`.
- `POST /v1/outcomes` accepts `{decisionId, outcome, source, receipt}`. A valid, unexpired
  (24 h) receipt for that decision and source marks the outcome `verified: true` with its real
  source. A receipt is bound to one decision, so a leaked receipt can label only that decision,
  only as a low-trust source.
- Unverified outcomes keep their claimed source in a new `claimed_source` column, so stats can
  still split them.

### 3. Weighted, per-source evidence

- `precedent.sources` also accepts a map of weights; the list form means weight 1:

  ```yaml
  precedent:
    from: subject
    minAllows: 3          # minimum evidence weight
    maxAgeDays: 14
    sources: { user: 1, supervised: 1, classifier: 0.5, harness: 0.25 }
  ```

- Each decision keeps one outcome per source. Its evidence is the outcome of its highest-weight
  verified source, so a later user answer overrides an earlier classifier verdict. A veto from
  any listed source still vetoes the subject for `maxAgeDays`.
- Evidence weight per subject is the sum over decisions; the `precedent: allow` rule needs
  `weight ≥ minAllows`, zero vetoes, at least one non-`classifier`/`harness` outcome unless the
  policy sets `precedent.allowModelOnly: true`, and the model must still select `allow` at the
  rule threshold (0.6). Default `permission.yaml` ships with `classifier: 0.5` and
  `allowModelOnly: true`, so six classifier allows of the same request lower its threshold.
- Only `ask` decisions collect allow evidence, as before. For the mod this is the shadowed or
  acted `claude-auto` permission decision that returned `ask`.

### 4. Outcome emitters per harness

| Harness | Signal | Joins by | Outcome, source |
| --- | --- | --- | --- |
| Paseo | `agent.permission.after` | `agentId:requestId` | `allow`/`decline`/`interrupted`, `user` or `supervised` (unchanged) |
| Claude Code, auto mode | mod `tool.call` result | `tool_use_id` | `allow`/`deny`, `classifier` |
| Claude Code, auto mode | `PermissionDenied` hook | `tool_use_id` | `deny`, `classifier` (works without the mod) |
| Claude Code, default modes | `PermissionRequest` then `PostToolUse`/`PostToolUseFailure` | gateway join on session + tool + input hash | `allow`, `harness` |
| Codex | `PermissionRequest` then `PostToolUse` | gateway join on session/turn + tool + input hash | `allow`, `harness` |

- `PermissionRequest` carries no `tool_use_id` in either harness. The gateway keeps a short-lived
  (10 min, 1,000 entries) pending map from `(session, tool, sha256(tool_input))` to the
  decision id and receipt; the new `PostToolUse` hook posts the tool input hash and the gateway
  resolves it. Hook processes stay stateless.
- A prompt with no later `PostToolUse` is **not** a denial (a crash, interrupt or decline look
  the same) and records nothing.
- `PostToolUse` approval cannot say who approved (user or a rule) in Claude Code's default
  modes, nor user vs auto-reviewer in Codex, hence the low `harness` weight.
- Claude Code `classifierVerdict` text matching stays the mod's verdict source; the
  `PermissionDenied` hook is the version-stable cross-check for denials.

### 5. Learning beyond exact match (staged, opt-in)

1. **Calibration (no text needed).** `local-decider calibrate` fits a per-policy, per-model
   temperature on verified outcomes and the stored `answers` probabilities, and suggests
   thresholds. It never lowers an allow threshold below the policy `floor`.
2. **Opt-in label store.** `labels.keepText: true` stores the redacted canonical subject and
   policy input for verified-outcome decisions in a `label` table (0600 database file,
   `labels.retainDays`, `local-decider labels purge`). Off by default.
3. **Near-duplicate precedent (tighten-only first).** With the label store on, an embedding kNN
   over labelled subjects can add `ask` to similar requests that were vetoed. It never allows on
   similarity alone until stats show its agreement.
4. **Fine-tuning.** Only the `strands-decider` adapter has a published recipe and loads local
   LoRA adapters; train off-box after 1–3k clean labels, gate on a golden set, serve through
   `strands-decider` or a merged GGUF on `llama-vulkan`. d3 models (no training code) and
   FastFlowLM (no custom adapters) are out of scope.

## Consequences

- An answer to the same request in the same project counts in Paseo, Claude Code and Codex.
- Claude Code auto-mode verdicts become precedent evidence at half weight, and denials veto.
  This is a second model's judgment feeding the first; the veto rule, the 0.6 model floor, the
  mod's deterministic blocks and the `allowModelOnly` switch bound it.
- Receipts add a second trust path. It is per decision and per low-trust source; the report
  token stays the only path to `user` and `supervised`.
- Existing v1 precedent stops counting after the switch and is rebuilt from new answers within
  `maxAgeDays`.
- New hook: `PostToolUse` for Claude Code and Codex (fail-open, log only, no output).

## Alternatives

- **Give the mod the report token.** It would let any mod-scoped code claim `user`; rejected.
- **Put the harness in the key.** Safer separation but defeats sharing; vetoes would not carry.
- **Treat a prompt with no later tool run as a denial.** Indistinguishable from crashes and
  declines; ADR-0006 already treats declines as neutral.
- **Fine-tune first.** Needs text the log does not keep, thousands of labels, and works on one
  engine only; calibration and the label store come first.
