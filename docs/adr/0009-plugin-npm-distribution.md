# ADR-0009: Ship the plugin bundle from npm, not git

Status: accepted (2026-11-11); amends [ADR-0004](0004-marketplace-layout.md)

## Context

ADR-0004 committed `plugins/local-decider/dist/hook.mjs`, and the mod `hooks/register.mjs`
followed, so that installs from the git marketplace worked. Generated code in git needed a CI diff
check and noisy diffs. Claude Code and Codex both support an `npm` plugin source; no other built
artifact source is common to both.

## Decision

- The plugin directory is published as `@ziptie-soft/local-decider-agent-plugin` by the existing release
  workflow (npm trusted publishing, provenance).
- Both marketplaces stay in git; each plugin entry's `source` is
  `{ "source": "npm", "package": "@ziptie-soft/local-decider-agent-plugin", "version": "<x.y.z>" }`.
  release-please keeps that version, both `plugin.json` versions and `package.json` in step.
- `dist/hook.mjs` and `hooks/register.mjs` are git-ignored and built by
  `pnpm --filter @ziptie-soft/local-decider-hooks build`. CI checks `npm pack --dry-run` contents
  instead of a bundle diff.
- `run-hook.sh` exits 0 silently when `dist/hook.mjs` is missing (unbuilt checkout).

## Consequences

No generated files in git. The installable artifact comes from the npm registry, pinned per
marketplace commit; neither harness runs install scripts. The `npm` CLI must be on `PATH`. The
first release (1.0.0) was published by hand to set up trusted publishing; until a version is on
npm, marketplace installs of it fail. release-please bumps the plugin only for commits touching
`plugins/local-decider/`, so hook-only changes need a touch there (release-please has no
`additional-paths`). The repo marketplace no longer installs the working tree; develop with
`claude --plugin-dir plugins/local-decider` after a build.
