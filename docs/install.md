# Install and configure

## 1. Gateway

Requirements: Node >= 24 and [uv](https://docs.astral.sh/uv/) (for the strands-decider engine).
From a checkout (`mise install` provides both):

```sh
mise run setup; and mise run build
node packages/gateway/dist/cli.js engine install            # cpu on Linux, mlx on Apple Silicon
node packages/gateway/dist/cli.js gateway start             # systemd user unit / launchd agent
node packages/gateway/dist/cli.js gateway status
```

Once published: `npm install -g local-decider`, then the same `local-decider ...` commands.

- `engine install` syncs a pinned uv project into
  `~/.local/share/local-decider/venvs/strands-decider` and downloads the adapter and base weights
  into the Hugging Face cache (2B: ~4.8 GB; E4B: ~16 GB). `--flavor cpu|mlx|cuda`,
  `--model <id>`, `--no-download`.
- `gateway start` writes `~/.config/systemd/user/local-decider.service` (Linux) or
  `~/Library/LaunchAgents/dev.local-decider.gateway.plist` (macOS) and starts it. Without
  systemd it falls back to a detached process with a pid file. `gateway stop`,
  `gateway uninstall`. `gateway run` stays in the foreground.
- The gateway listens on `127.0.0.1:8765` at once and reports `degraded` on `/health` while the
  engine loads (about 10 s for the 2B model from a warm cache on CPU). Logs:
  `~/.local/share/local-decider/logs/` (`gateway.log`, `engine-strands-decider.log`,
  `decisions-YYYY-MM-DD.jsonl`).

Check it:

```sh
local-decider decide turn-outcome lastMessage="All tests pass; the PR is open."
local-decider stats
```

### AMD Ryzen AI NPU (Linux): FastFlowLM

```sh
node packages/gateway/dist/cli.js engine install --engine fastflowlm   # portable FLM, sha256-checked
```

This downloads the pinned upstream FastFlowLM portable build into
`~/.local/share/local-decider/engines/fastflowlm/<version>/`, verifies it against GitHub's
published SHA-256, runs `flm validate` and pulls `d3:nano`. Then pick the engine and model in
Settings → Local decider (Paseo) or `POST /v1/engine {"engine":"fastflowlm","model":"d3:mini"}`;
the choice is saved as `selection:` in `config.yaml` and survives restarts. An `flm` already on
`PATH` is found automatically; any tool path or model directory can be set in settings or under
`tools:` / `dirs:` in `config.yaml`.

The engine loads lazily: the first decision starts it (~5 s on FLM), and it unloads after 15
idle minutes (`lifecycle: {mode: lazy|eager, idleUnloadMinutes}`).

## 2. Configuration

Every setting lives in `~/.config/local-decider/config.yaml` (all keys optional;
`local-decider config path` prints the location). Paseo's settings page and the
`local-decider policies|routing` commands write to it, keeping your comments, and the gateway
applies edits to it and to `policies/` as they happen; only `host`, `port`, `engine` and
`decisionTimeoutMs` need a restart. The gateway writes JSON Schemas for this file and for policy
files to `~/.config/local-decider/schemas/` (`local-decider config schema`; repository copies in
`schemas/`), so editors and agents can validate edits. `local-decider config check` validates
the file and every policy. A `state.json` from older versions is folded in once and renamed.

```yaml
# yaml-language-server: $schema=schemas/config.schema.json
host: 127.0.0.1          # anything else requires LOCAL_DECIDER_TOKEN (>= 16 chars)
port: 8765
decisionTimeoutMs: 30000 # per decision, queue wait included
engine:
  type: strands-decider
  model: StrandsAgents/strands-decider-2B-qwen3.5-v1-2610
  device: auto           # auto | cpu | mlx | mps | cuda
  maxBatch: 8
  # url: http://127.0.0.1:8000   # attach to a running `strands-decider serve` instead
# engine:
#   type: systemone-remote       # any /v1/systemone server (another machine, laya-serve, GLiClass)
#   url: http://gpu-box:8000
#   tokenEnv: REMOTE_DECIDER_TOKEN
selection: { engine: fastflowlm, model: d3:mini }   # set by the settings page; beats engine.type/model
lifecycle: { mode: lazy, idleUnloadMinutes: 15 }
policies:
  permission: { mode: shadow }   # off | shadow | act, overrides the policy file
  routing: { mode: act, variant: routing-budget }   # variant: a policy with variantOf: routing
  # permission: { thresholds: { verdict.allow: 0.9 } }   # rule thresholds by <question>.<answer>; allow ≥ 0.5
policyDirs: []                   # extra dirs; ~/.config/local-decider/policies is added automatically
routing:
  presets:                       # route:<preset> → model, per harness
    paseo:
      cheap: { model: claude/haiku }              # provider/model, optional mode: <mode id>
      premium: { model: codex/gpt-5.5, mode: full-access }
      fast: { model: codex/gpt-6-luna, thinking: xhigh }   # thinking/reasoning level
      deep: { profile: design-opus }              # Paseo only: a Paseo agent profile id
    claude-code:
      cheap: { model: haiku }                     # named in the hook's hint; Claude Code passes it to subagents
    codex:
      premium: { model: gpt-5.5 }
pricing:                         # optional, USD per million tokens (example values); savings stay in tokens without it
  claude/claude-opus-4-6: { input: 5, cachedInput: 0.5, output: 25 }
  claude-haiku-4-5: { input: 1, cachedInput: 0.1, output: 5 }   # a bare id matches any provider
```

`pricing` is never fetched or updated for you: copy current list prices from your provider.
`cachedInput` defaults to `input`.

Secrets never go in this file. For a remote gateway, put `LOCAL_DECIDER_TOKEN=...` in
`~/.config/local-decider/env` (mode 0600), which the systemd unit reads if present; clients read
`LOCAL_DECIDER_TOKEN` and `LOCAL_DECIDER_URL` from their environment.

## 3. Rolling out a policy

1. Leave it in `shadow` (the default) for a while. Every decision is logged with what it
   *would* have done.
2. Adapters report outcomes where they can see them (e.g. what the user answered to a
   permission prompt). `local-decider stats` shows agreement, Brier score and reliability per
   confidence bucket, the time you spent on prompts a policy would have allowed, and for routing
   the tokens that ran (or would have run) on another model, in dollars when `pricing` is set.
   Shadow savings are an upper bound: they assume the routed model would have used the same
   tokens and succeeded.
3. When the high-confidence buckets are accurate, switch that policy to `act`:
   `local-decider policies mode <policy> act`, Paseo's settings page, or `mode: act` under
   `policies:` in `config.yaml`. The gateway applies it immediately.
