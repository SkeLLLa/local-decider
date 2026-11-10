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

## 2. Configuration

`~/.config/local-decider/config.yaml` (all keys optional):

```yaml
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
policies:
  permission: { mode: shadow }   # off | shadow | act, overrides the policy file
policyDirs: []                   # extra dirs; ~/.config/local-decider/policies is added automatically
```

Secrets never go in this file. For a remote gateway, put `LOCAL_DECIDER_TOKEN=...` in
`~/.config/local-decider/env` (mode 0600), which the systemd unit reads if present; clients read
`LOCAL_DECIDER_TOKEN` and `LOCAL_DECIDER_URL` from their environment.

## 3. Rolling out a policy

1. Leave it in `shadow` (the default) for a while. Every decision is logged with what it
   *would* have done.
2. Adapters report outcomes where they can see them (e.g. what the user answered to a
   permission prompt). `local-decider stats` shows agreement, Brier score and reliability per
   confidence bucket.
3. When the high-confidence buckets are accurate, set `mode: act` for that policy in
   `config.yaml` and restart the gateway (`local-decider gateway start`).
