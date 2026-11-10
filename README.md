# local-decider

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

## Quick start

```sh
mise trust; and mise install; and mise run setup; and mise run build
node packages/gateway/dist/cli.js engine install     # uv venv + model weights (~4.8 GB for 2B)
node packages/gateway/dist/cli.js gateway start      # systemd user unit / launchd agent
```

Then add one or more harnesses:

```sh
# Paseo
paseo plugin install ./packages/paseo-plugin
# Claude Code
claude plugin marketplace add SkeLLLa/local-decider; and claude plugin install local-decider@local-decider
# Codex (then trust the hooks with /hooks in the TUI)
codex plugin marketplace add SkeLLLa/local-decider; and codex plugin add local-decider@local-decider
```

Docs: [install and configure](docs/install.md), [architecture](docs/architecture.md),
[policy authoring](docs/policies.md), [threat model and limits](docs/security.md),
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
