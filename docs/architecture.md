# Architecture

local-decider puts a small local decision model in front of routine, fixed-choice decisions in
coding-agent harnesses. Research notes behind every choice here are in [research/](research/);
the decisions themselves are recorded as ADRs in [adr/](adr/).

```text
 engines                        gateway (127.0.0.1:8765)                 harness adapters
┌────────────────────┐   ┌──────────────────────────────────────┐   ┌──────────────────────────┐
│ strands-decider    │◄──┤ engine pool (one request in flight   │◄──┤ Paseo plugin (HTTP)      │
│  serve (uv venv)   │   │   per engine, health, restart)       │   │ Claude Code hooks (node) │
│ systemone-remote   │◄──┤ policies (YAML) → state → questions  │◄──┤ Codex hooks (node)       │
│ llm-logprobs       │◄──┤ redaction, 4k truncation, key sort   │◄──┤ MCP `decide` tool        │
│ (later) ONNX enc.  │   │ rules → action, mode off/shadow/act  │   │ `local-decider` CLI      │
└────────────────────┘   │ shadow log (JSONL) → stats           │   └──────────────────────────┘
                         └──────────────────────────────────────┘
```

## Packages

| path | what | ships as |
|---|---|---|
| `packages/core` | `/v1/systemone` types and normalisation, policy schema/loader/rules, redaction, truncation, gateway client | `@local-decider/core` (npm) |
| `packages/gateway` | HTTP service, engine adapters, engine supervisor, MCP server, `local-decider` CLI, service units | `local-decider` (npm, `bin`) |
| `packages/gateway/engines/strands-decider` | uv project pinning strands-decider; synced into `~/.local/share/local-decider/venvs/` | inside the npm package |
| `packages/paseo-plugin` | Paseo plugin `local-decider` (TS source; Paseo bundles it) | `paseo-plugin-local-decider` (npm) |
| `packages/hooks` | Claude Code + Codex hook runner, bundled to one zero-dependency file | `plugins/local-decider/dist/hook.mjs` |
| `plugins/local-decider` | the Claude Code **and** Codex plugin directory (both manifests) | git marketplace |
| `policies/` | default policies | inside the gateway package |

Claude Code and Codex share one plugin directory and one hook runner (ADR-0004), so the planned
`claude-plugin`/`codex-plugin` packages became `packages/hooks` plus `plugins/local-decider`.

## Gateway

A long-running Node service (ADR-0001), started with `local-decider gateway start` (a systemd
user unit on Linux, a launchd agent on macOS) or `local-decider gateway run` in the foreground.

| route | purpose |
|---|---|
| `POST /v1/systemone` | Strands/Jev/Laya-compatible pass-through to the active engine (keys sorted, secrets redacted) |
| `POST /v1/decide/:policy` | run a policy on structured harness input → `DecideResponse` (`packages/core/src/decision.ts`) |
| `POST /v1/outcomes` | adapters report what actually happened, for agreement and calibration |
| `POST /v1/usage` | adapters report one agent turn's token counts for the decision that applied to the agent, for savings |
| `GET /health`, `GET /ping` | engine state, model, p50/p95 latency |
| `GET /models` | known decision models (`StrandsAgents/*`), the active model and device, and whether the engine can switch |
| `POST /v1/engine` | `{engine?, model, device?}`: switch a spawned engine to another known model; saved as `selection` in `config.yaml`; 409 for a remote or `engine.url` engine |
| `GET /v1/policies` | loaded policies with effective modes, routes, and variants |
| `POST /v1/policies/:id/mode`, `/variant`, `POST /v1/policies/reload` | change a policy's mode or variant (written to `config.yaml`), re-read policy files |
| `GET /v1/policies/:id/prompt` | `{prompt, cwd}`: the prompt that has an agent write a variant of `:id` (routing) |
| `GET /v1/config`, `POST /v1/config/reload` | `config.yaml`'s path, schema paths and applied content; re-read it after an outside edit |
| `POST /v1/routing/presets` | `{harness, preset, model, mode?}`: map a preset in `config.yaml` (`model: null` removes it) |
| `POST /mcp` | MCP (streamable HTTP) with a `decide` tool; `local-decider mcp` is the stdio form |

- Binds `127.0.0.1:8765` with no auth. Binding any other address requires
  `LOCAL_DECIDER_TOKEN` in the environment; requests must then send `Authorization: Bearer`.
  The token is never logged or written to config.
- Request bodies are capped (256 KiB) and treated as untrusted data: they are only ever rendered
  into the model's state string. Nothing derived from them is executed, used as a path, or used
  as a URL.
- One request in flight per engine; concurrent decisions queue (strands-decider's concurrency is
  unverified upstream). Each queued request carries its caller's deadline and is dropped once it
  has expired.
- An engine error never becomes an enforced action: the response carries `error`, the policy
  default, and `enforced: false`.

### Decision pipeline (`/v1/decide/:policy`)

1. Look up the policy and its effective mode (config overrides beat the YAML). `off` → return
   `abstain` without calling an engine.
2. Redact secrets in every input string (`core/redact.ts`).
3. Render `state.sections` from the input in policy order (least to most relevant), objects as
   key-sorted JSON, and fit them into `state.maxTokens` from the end (`core/truncate.ts`).
4. Look up the decision cache (`inputHash` of policy id + version + state, TTL per policy).
5. Send `{state, questions}` with sorted keys to the engine; normalise answers so every engine
   reports the same `probabilities` and `confidence` (`core/systemone.ts`).
6. First matching rule → action, else the policy default (`core/policy.ts`). A precedent allow
   rule also requires a current model allow with p(allow) ≥ 0.6, enough recent exact-subject allows,
   and no deny; precedent never bypasses the model.
7. `enforced = mode === 'act' && no error`. Append a shadow record; return.

### Modes and the shadow log

`off` / `shadow` / `act` per policy, the equivalent of the Amazon `BEDROCK`/`DUAL`/`DECIDER`
rollout. Every policy ships in `shadow`. Adapters change harness behaviour only when
`enforced` is true.

Records go to `~/.local/share/local-decider/logs/decisions-YYYY-MM-DD.jsonl`:
`{kind: "decision", ts, decisionId, harness, sessionId?, policy, mode, inputHash, precedentKey?,
precedent?, stateTokens, requestedModel?, routedModel?, answers, action, enforced, engine, model,
latencyMs, error?}`. `precedentKey` is a hash of policy, project, and redacted normalized subject;
the subject itself is never logged. Adapters later append
`{kind: "outcome", decisionId, outcome, source}` through `/v1/outcomes`; sources include `user`,
`supervised`, `harness`, and `heuristic`.
and `{kind: "usage", decisionId, turnId?, model?, inputTokens, cachedInputTokens,
outputTokens, costUsd?}` through `/v1/usage`. No state text is logged, only its hash, so the log
never holds prompts, code or (unredacted) secrets. `local-decider stats` joins the three kinds
and reports agreement, Brier score and reliability per confidence bucket, plus savings
(`gateway/src/savings.ts`):

- **Routing**: a decide request may carry `models: {requested, routes, profiles}`, the model the
  agent uses unchanged, the model each route action switches to, and each harness agent
  profile's model. The gateway fills missing routes from `config.yaml` presets, resolving a
  `profile` preset through `profiles` (the Paseo plugin sends its agent profiles). With usage
  reported for the agent,
  stats sum the tokens of tasks routed to another model: `potential` for shadow decisions (the
  task ran on the requested model), `realized` for enforced ones. The optional `pricing` table
  in `config.yaml` prices both sides; without it savings stay in tokens. Shadow figures are an
  upper bound: a cheaper model may need more turns or fail.
- **Prompts**: shadow `allow` decisions the user answered, and the time from the decision to
  the answer (capped at 10 minutes each).

The Paseo plugin reports usage from the agent's `lastUsage` after each turn, for agents a
routing decision created (linked by cwd and title between `agent.create.before` and `.after`, in
memory).

## Engines (ADR-0002)

```ts
interface Engine {
  readonly id: string;
  start(signal: AbortSignal): Promise<void>; // spawn/attach; resolves when /health is ok
  health(): Promise<EngineHealth>;
  decide(req: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse>;
  stop(): Promise<void>;
}
```

| engine | status | notes |
|---|---|---|
| `strands-decider` | MVP | spawns `strands-decider serve <model> --device cpu\|mlx\|mps\|cuda --port <free>` from the managed venv, or attaches to a URL |
| `systemone-remote` | M5 | any `/v1/systemone` URL: another machine, `laya-serve`, the GLiClass example server |
| `llm-logprobs` | M5 | OpenAI-compatible server; one constrained completion per question, top-k logprobs of the option tokens → probabilities. Verified per server at start; disabled if no logprobs |
| `onnx-encoder` | spike | Laya / GLiClass through onnxruntime-node; VitisAI EP for the NPU later |

Linux PoC (this machine, Ryzen AI 9 365): `strands-decider` with
`StrandsAgents/strands-decider-2B-qwen3.5-v1-2610` on `--device cpu`. Mac: the same model, or E4B,
on `--device mlx`. See [research/engines.md](research/engines.md) for latency expectations and
the llama.cpp Vulkan route for the iGPU.

## Policies (ADR-0003)

YAML, one file per decision type, validated by `policySchema` in `packages/core/src/policy.ts`.
See [policies.md](policies.md) for authoring. Defaults: `turn-outcome`, `permission`,
`routing`, `command-risk`.

## Harness adapters

- **Paseo** ([research/paseo-plugin-api.md](research/paseo-plugin-api.md)): a thin client; no
  models in-process, no runtime dependencies. `agent.turn.after` → `turn-outcome` (first);
  `agent.permission.before` → `permission` (auto-allow only when enforced, never auto-deny in
  v1, "already resolved" races swallowed); `agent.create.before` → `routing` with a ~2 s budget,
  skipped when the gateway is not ready; `agent.open.before` → optional MCP injection. Targets
  Paseo `>=0.15.3`.
- **Claude Code** ([research/claude-codex-hooks.md](research/claude-codex-hooks.md)):
  `PreToolUse` runs the deterministic deny layer, then `command-risk` (ask/deny only);
  `PermissionRequest` runs `permission` (allow, or nothing); `Stop` runs `turn-outcome` (log
  only: a Stop hook that adds context would keep the turn going); `UserPromptSubmit` runs
  `routing` as a hint. Under Claude auto mode a hook `allow` does not override the classifier
  (anthropics/claude-code#94740, open), so there the decider can only add `ask`/`deny`.
- **Codex**: the same runner and policies. `PreToolUse` is deny-only; approval goes through
  `PermissionRequest`, where printing nothing abstains, leaving the built-in auto-reviewer in
  charge.
- **Paseo running Claude Code or Codex**: Paseo launches the real CLIs, which load this plugin
  too. One event gets one decision: the Paseo plugin's `agent.open.before` sets
  `LOCAL_DECIDER_HOST_POLICIES=turn-outcome,permission,routing`, and the hooks skip those
  policies, leaving the guard and `command-risk` (Paseo has no pre-tool hook). Without it a
  Claude hook `allow` would answer the prompt before Paseo saw it, bypassing the Paseo plugin's
  own mode, and every turn and permission would be logged twice.
- Every hook fails open: a gateway that is down, slow (1.5 s default budget) or erroring produces
  no output and exit code 0, i.e. the harness's default behaviour.

## Open questions, settled

| question | decision |
|---|---|
| Gateway language | Node/TS gateway supervising Python engine processes (ADR-0001) |
| One marketplace for Claude Code and Codex? | Yes: one plugin dir with both manifests, two marketplace files (ADR-0004) |
| Which local servers expose logprobs? | llama.cpp server and Ollama (`top_logprobs`) yes; FastFlowLM from 1.0.12; LM Studio only on `/v1/responses`; Lemonade unverified. The `llm-logprobs` engine probes at start-up |
| Default thresholds | Auto-allow only at p(allow) ≥ 0.95; everything ships in `shadow`; tune from `local-decider stats` |
| Reuse auto-mode-for-paseo for routing? | No dependency: it registers itself as a whole provider. Our gateway serves `/v1/systemone`, so it can be that plugin's Jev/Laya-style backend unchanged; routing presets are our own small map |

## Threat model and known limits

See [security.md](security.md).
