# ADR-0012: Cross-harness precedent and learning from answers

Status: accepted (2026-11-14) for §§1, 2 and 4.1; §3 emitters beyond the mod and §§4.2–4.4
remain proposed.

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
- **The log is hash-only.** Nothing can be retrained or calibrated per request from it beyond the
  stored answer probabilities.

## Decision

Invariant: **no number of calls to the public `/v1/decide` and `/v1/outcomes` endpoints may lower
an allow threshold.** A same-user process can read every 0600 file and call the gateway, so
neither a request's shape (`scope`, harness, call id) nor a gateway-issued capability proves that
a classifier ran or that anyone approved anything. Only the report token path of ADR-0006
(`user`, `supervised`) adds allow evidence, as today. Everything new here can only tighten.

### 1. One canonical precedent key

- Adapters send the working directory as `DecideRequest.workspace.cwd`, outside the model input.
  The gateway normalises it lexically (no `realpath`, no command execution) before including it in
  the key. Adapters keep sending their display `input.project` for the model. The key groups
  decisions; it is not an authentication boundary. The execution cwd stays in the key, so
  relative commands in different directories never share evidence.
- `canonicalSubject(tool, toolInput, cwd)` in `packages/core/src/subject.ts` is the only subject
  builder. The hooks, the mod and Paseo call it on the native tool input (Paseo passes its
  structured tool metadata, not its rendered prompt) after mapping native tool names to a shared
  vocabulary: `Bash`/`shell`/`exec_command` → `shell`; `Edit`/`Write`/`MultiEdit`/`apply_patch`
  → `edit`; `NotebookEdit` → `notebook`; MCP tools → `mcp:<server>:<tool>`; anything else keeps
  its name. Path fields (`file_path`, `filePath`, `notebook_path`, `path`) are read the same way
  everywhere. A missing or malformed field yields no subject, so no precedent.
- Key = `inputHash(['v2', policyId, lexicallyNormalisedCwd, canonicalSubject])`. The `v2` tag
  versions this tuple's format. The harness is not in the key, so a user's answer in Paseo counts
  for the same request in Claude Code and Codex, and a veto anywhere vetoes everywhere.
- Lossy steps must not merge distinct subjects: the key hashes the subject before truncation for
  the prompt, and whitespace is collapsed only outside quotes. Mutable execution context (an
  edited `./build.sh`, a different `PATH`) stays a documented limit; deterministic guards run on
  every call and precedent never bypasses them.
- Existing precedent hashes are discarded because they cannot be converted to the canonical
  key. A workspace is required for precedent; requests without one do not use precedent. New
  decisions and verified outcomes rebuild it within `maxAgeDays`. The 25-hour replay covers
  keyed auto-allows.

### 2. Model and harness outcomes are veto-only

- The mod's classifier outcomes and future harness observations stay unverified. The gateway
  keeps their claimed source in a new `claimed_source` column, so stats can split them, while
  `source` stays `unverified` as today.
- A policy may list `precedent.vetoSources` (default for `permission.yaml`: `[classifier]`). A
  `deny` outcome whose claimed source is listed vetoes the decision's subject for `maxAgeDays`,
  exactly as a verified veto does. Their `allow` outcomes never add allow evidence and never
  satisfy `minAllows`. Forging one can only add prompts, never remove one.
- No receipts, no source weights, no `allowModelOnly`. Positive learning from classifier or
  harness signals needs an isolation boundary the gateway does not have; that is future work
  with its own ADR.

### 3. Outcome emitters per harness

| Harness | Signal | Joins by | Effect |
| --- | --- | --- | --- |
| Paseo | `agent.permission.after` | `agentId:requestId` | allow evidence or veto (unchanged) |
| Claude Code, auto mode | mod `tool.call` result | `tool_use_id` | classifier veto on `deny` |
| Claude Code, auto mode | `PermissionDenied` hook | `tool_use_id`, only to an existing decision | classifier veto (deferred) |
| Claude Code, Codex | `PermissionRequest` then `PostToolUse` | none reliable | telemetry only (deferred) |

- `PermissionDenied` may report a veto only when it joins an existing permission decision; it
  never creates a decision. `PermissionRequest` has no `tool_use_id` in either harness, and a
  `(session, tool, input hash)` join is ambiguous across retries and identical calls. Both
  emitters wait until real payloads are captured and tested; a missing post-tool event is never
  read as a denial.
- The Claude Code mod classifier veto is implemented. The other §3 emitters remain proposed.

### 4. Learning beyond exact match (staged)

1. **Calibration.** `local-decider calibrate [--json]` fits a temperature per policy, engine and
   model on stored `answers` probabilities and the effective verified outcome per decision (the
   ADR-0006 fold). It reports sample count, temperature, Brier and ECE before and after, and
   suggested allow thresholds from raw probabilities; temperature is diagnostic only. A
   suggestion needs at least 30 selected decisions and a 95% Wilson lower bound on allow precision
   of at least 0.98. The fit requires 50 samples. It never writes configuration. The threshold
   floor is the lowest configured allow-rule `minProbability`; policies without a
   probability-based allow rule get no suggestion.
2. **Opt-in label store.** `labels.keepText: true` would keep the redacted subject and state for
   verified-outcome decisions (0600, retention, purge). Off by default; its own ADR.
3. **Near-duplicate precedent.** With the label store, a kNN over vetoed subjects may add `ask`
   to similar requests. Tighten-only.
4. **Fine-tuning.** Only `strands-decider` has a published recipe and loads local checkpoints;
   the plan is [docs/fine-tuning.md](../fine-tuning.md). d3 and FastFlowLM are out of scope.

## Consequences

- An answer to the same request in the same directory counts in Paseo, Claude Code and Codex.
- Claude Code auto-mode denials veto the subject in every harness; its allows are recorded but
  never lower a threshold. Forged reports can only cause extra prompts.
- Existing precedent hashes are discarded. Requests without a workspace receive no precedent;
  requests with one build evidence under the canonical key within `maxAgeDays`.
- Hook outcome emitters are deferred until payloads are verified.

## Alternatives

- **Decision receipts (HMAC per decision, granted by request shape).** Rejected: `/v1/decide`
  is open and `scope` is caller-supplied, so any same-user process could mint receipts and post
  six classifier allows to lower a threshold of its choosing.
- **Weighted sources with `allowModelOnly`.** Rejected: repeated classifier verdicts are
  correlated judgments, not independent approvals, and without authentication they are forgeable.
- **Give the mod the report token.** Any mod-scoped code could claim `user`; rejected.
- **Put the harness in the key.** Safer separation but vetoes would not carry; since only
  report-token sources allow, sharing adds no new allow path.
- **Treat a prompt with no later tool run as a denial.** Indistinguishable from crashes and
  declines.
- **Fine-tune first.** Needs text the log does not keep and thousands of labels.
