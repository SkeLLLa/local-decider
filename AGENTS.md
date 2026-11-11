# local-decider — agent instructions

Instructions for AI coding agents working in this repository. Humans: see `README.md` and
`docs/`.

pnpm monorepo, TypeScript (TS 7, `@tsconfig/strictest`), Node >= 24. Sources run directly under
Node's type stripping, so use erasable syntax only (no `enum`, no parameter properties, no
namespaces) and import relative files with their `.ts` extension.

## Setup

`mise trust && mise install && mise run setup`. mise pins node, pnpm, uv, the linters and the
fff/ripwire MCP servers (`.mcp.json`). Never use corepack. Install packages with `pnpm`; the
workspace refuses versions younger than 3 days (`minimumReleaseAge`).

## Layout

- `packages/core` — types, `/v1/systemone` client, policy schema and loader, redaction,
  truncation, decision cache. No runtime I/O beyond `fetch`.
- `packages/gateway` — the local service, engine adapters, MCP server, `local-decider` CLI.
- `packages/paseo-plugin`, `packages/claude-plugin`, `packages/codex-plugin` — thin clients of
  the gateway. They never run models in-process.
- `policies/` — default policy YAMLs. `docs/` — human-facing docs and ADRs.
  Research notes and reviews stay local in the git-ignored `docs/research/` and `docs/review/`.

Workspace packages export a `source` condition pointing at `src/`; tests and `mise run gateway`
run with `--conditions=source`, builds resolve `dist/`.

## Commands

- `mise run check` — lint, typecheck, Markdown, workflow lint/pins/zizmor, shellcheck,
  complexity (`cccc.toml`), fallow, build and test. Run before declaring work done.
- `pnpm -r build`, `pnpm -r test`, `pnpm -r typecheck`, `pnpm lint`, `pnpm fmt`.
- `mise run gateway` — run the gateway from source.

## Conventions

- Commits and PR titles follow Conventional Commits (`<type>(<scope>)!?: <description>`), one
  line. CI enforces it; release-please derives versions from it.
- Keep functions under the `cccc.toml` ceilings by splitting them; don't raise the ceilings.
- Workflows: pin every `uses:` to a full commit SHA with a `# vX.Y.Z` comment, keep
  `permissions` minimal per job and set `timeout-minutes`.
- Security: agent prompts and tool inputs are untrusted data. The gateway never executes
  anything derived from them, binds to 127.0.0.1 by default, and never logs tokens. Redact
  secrets before sending state to an engine or writing the shadow log.
- Runtime data (venvs, models, logs) lives under `~/.local/share/local-decider/`, never inside a
  plugin directory.
- Harness hooks fail open: if the gateway is down or slow, return the harness's default
  behaviour.
- Search files and content with the fff MCP; navigate symbols and check impact with ripwire.
