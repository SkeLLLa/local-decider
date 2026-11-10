# local-decider

![local-decider logo](docs/assets/logo.svg)

Local decision models ("System One" models) for coding-agent harnesses: Paseo, Claude Code and
Codex. A small local model answers routine fixed-choice questions — is this turn done or stuck,
can this permission be allowed, which model should this task get, is this command risky — in one
forward pass, with a probability per option and a calibrated confidence. Anything uncertain still
goes to the large LLM or to you.

> **Status:** early development.
>
> **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by Strands
> Agents, Amazon Web Services, Anthropic, OpenAI or Paseo.

## How it works

```text
engines (strands-decider, any /v1/systemone server) ─► gateway 127.0.0.1:8765 ─► Paseo / Claude Code / Codex
```

- **Gateway** (`local-decider`): `POST /v1/systemone` (Strands/Jev/Laya compatible),
  `POST /v1/decide/:policy`, `GET /health`, `GET /models`, MCP `decide` tool at `/mcp`, shadow log
  and `local-decider stats` (agreement, Brier score, reliability).
- **Policies are data** (`policies/*.yaml`): turn outcome, permission triage, routing, command
  risk. Each runs `off`, `shadow` (log only, the default) or `act`.
- **Harness adapters** are thin, fail-open clients: a Paseo plugin, and one plugin directory
  serving both Claude Code and Codex.

<details>
<summary>Screenshots: the Paseo plugin</summary>

Quick status from the sidebar: engine state, latency and each policy's mode.

![Quick-status popover](docs/assets/screenshots/quick-status.png)

A decision row in the chat after a turn ends, with the answer, confidence, action, model and
latency, and your feedback.

![Turn-outcome decision row](docs/assets/screenshots/chat-decision.png)

Engine and model picker with download sizes, memory, latency and the FastFlowLM NPU check.

![Engine and model settings](docs/assets/screenshots/settings-models.png)

Policy modes, how decisions show in chat, and the sidebar item.

![Policy and display settings](docs/assets/screenshots/settings-policies.png)

Gateway service controls and shadow statistics.

![Gateway service and shadow statistics](docs/assets/screenshots/status.png)

</details>

## Quick start

```sh
mise trust; and mise install; and mise run setup; and mise run build
node packages/gateway/dist/cli.js engine install     # uv venv + model weights (~4.8 GB for 2B)
node packages/gateway/dist/cli.js gateway start      # systemd user unit / launchd agent
```

Then add one or more harnesses:

```sh
# Paseo, from this checkout or straight from GitHub (the path after ':' is the plugin directory)
paseo plugin install (pwd)/packages/paseo-plugin
paseo plugin install github:SkeLLLa/local-decider:packages/paseo-plugin
# Claude Code
claude plugin marketplace add SkeLLLa/local-decider; and claude plugin install local-decider@local-decider
# Codex (then trust the hooks with /hooks in the TUI)
codex plugin marketplace add SkeLLLa/local-decider; and codex plugin add local-decider@local-decider
```

Docs: [install and configure](docs/install.md), [architecture](docs/architecture.md),
[policy authoring](docs/policies.md), [threat model and limits](docs/security.md),
[supervised child agents](docs/supervised-subagents.md),
[benchmarks](docs/benchmarks.md), [demos](docs/demos.md), [ADRs](docs/adr/),
[research notes](docs/research/).

## Prior art and credits

[Strands Decider](https://github.com/strands-labs/strands-decider) (the `/v1/systemone` contract
and models, Apache-2.0), [Laya](https://github.com/NandhaKishorM/laya),
[GLiClass](https://github.com/Knowledgator/GLiClass),
[auto-mode-for-paseo](https://github.com/obetomuniz/auto-mode-for-paseo),
[jev-paseo](https://github.com/hypnguyen1209/jev-paseo),
[claude-decision-router](https://github.com/frankievalentine/claude-decision-router),
[claude-automode](https://github.com/lukaszmalik/claude-automode),
[SystemOne](https://github.com/iksnerd/SystemOne), [viz-dec](https://github.com/tomyak/viz-dec),
[building-with-decision-models](https://github.com/aaddrick/building-with-decision-models),
[destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard),
[codex-policy-hooks](https://github.com/jakubc78/codex-policy-hooks).

## Development

```sh
mise trust; and mise install; and mise run setup
mise run check
```

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
