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

## Development

```sh
mise trust; and mise install; and mise run setup
mise run check
```

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
