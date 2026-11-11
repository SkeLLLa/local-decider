# ADR-0004: One plugin directory for Claude Code and Codex

Status: accepted (2026-11-10); amended by [ADR-0009](0009-plugin-npm-distribution.md)

## Context

Codex reads `.codex-plugin/plugin.json` before `.claude-plugin/plugin.json` and
`.agents/plugins/marketplace.json` before `.claude-plugin/marketplace.json`, uses a
Claude-compatible hooks file format, and exports `CLAUDE_PLUGIN_ROOT`. Claude's
`plugin validate --strict` rejects Codex-only marketplace keys. Installs copy only the plugin
directory.

## Decision

```text
.claude-plugin/marketplace.json        # Claude Code marketplace → plugins/local-decider
.agents/plugins/marketplace.json       # Codex marketplace       → plugins/local-decider
plugins/local-decider/
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json            # "hooks": "./hooks/codex-hooks.json"
  hooks/hooks.json                     # Claude Code
  hooks/codex-hooks.json               # Codex
  dist/hook.mjs                        # built from packages/hooks, published to npm
```

Hooks run `node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" <claude|codex> <event>`. The bundle has
no dependencies. It is no longer committed; ADR-0009 builds it at release.

## Consequences

One repo, `claude plugin marketplace add ziptie-soft/local-decider` and
`codex plugin marketplace add ziptie-soft/local-decider`. The bundle is not in git (see ADR-0009).
