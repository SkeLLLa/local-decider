# ADR-0004: One plugin directory for Claude Code and Codex

Status: accepted (2026-11-10)

## Context

Codex reads `.codex-plugin/plugin.json` before `.claude-plugin/plugin.json` and
`.agents/plugins/marketplace.json` before `.claude-plugin/marketplace.json`, uses a
Claude-compatible hooks file format, and exports `CLAUDE_PLUGIN_ROOT`. Claude's
`plugin validate --strict` rejects Codex-only marketplace keys. Installs copy only the plugin
directory. (See [../research/claude-codex-hooks.md](../research/claude-codex-hooks.md).)

## Decision

```text
.claude-plugin/marketplace.json        # Claude Code marketplace → plugins/local-decider
.agents/plugins/marketplace.json       # Codex marketplace       → plugins/local-decider
plugins/local-decider/
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json            # "hooks": "./hooks/codex-hooks.json"
  hooks/hooks.json                     # Claude Code
  hooks/codex-hooks.json               # Codex
  dist/hook.mjs                        # bundled from packages/hooks, committed
```

Hooks run `node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" <claude|codex> <event>`. The bundle has
no dependencies; CI rebuilds it and fails if the committed file differs.

## Consequences

One repo, `claude plugin marketplace add SkeLLLa/local-decider` and
`codex plugin marketplace add SkeLLLa/local-decider`. The committed bundle is generated code in
git, kept honest by the CI diff check.
