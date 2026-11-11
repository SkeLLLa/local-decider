# Ship the Claude Code / Codex plugin as an npm package instead of committing the bundle

## Context

`packages/hooks/build.mjs` writes two generated files into the plugin dir, both committed today:
`plugins/local-decider/dist/hook.mjs` and `plugins/local-decider/hooks/register.mjs` (the Claude
Code mod). CI diff-checks them (`ci.yml:124-126`), `.gitignore` re-includes `dist/`, ADR-0004
records "committed". Goal: stop committing them and build + package them in the release workflow,
while `claude plugin marketplace add SkeLLLa/local-decider` / `codex plugin marketplace add
SkeLLLa/local-decider` keep working.

Harness support (checked in the docs, 2026-11):

- Claude Code plugin sources: relative path, `github`, `url`, `git-subdir` (`url,path,ref,sha`),
  **`npm` (`package,version,registry`; install scripts never run)**, `archive` (zip + `sha256`),
  `command`.
- Codex plugin sources: `local`, `url`, `git-subdir` (`ref`/`sha`), **`npm`
  (`package,version,registry`; no lifecycle scripts; needs the `npm` CLI)**. No archive.

## Recommendation: (a) publish the plugin dir as `@local-decider/agent-plugin` on npm

`npm` is the only built-artifact source **both** harnesses support. It reuses the existing
trusted-publishing (OIDC) job: provenance is included, no `contents: write`, no generated branch,
no force-push. Option (b) (generated branch) needs a write token, gives no provenance, and leaves
branch history to deal with. Option (c) (archive) is Claude-only.
The marketplaces stay in git. Only each plugin entry's `source` changes.

### Marketplace entries

`.claude-plugin/marketplace.json`:

```json
"source": { "source": "npm", "package": "@local-decider/agent-plugin", "version": "0.1.0" }
```

`.agents/plugins/marketplace.json`:

```json
"source": { "source": "npm", "package": "@local-decider/agent-plugin", "version": "0.1.0" }
```

release-please keeps `version` pinned to an exact version (see below), so a marketplace commit always
names exactly one published artifact.

### Plugin package (`plugins/local-decider/package.json`, new)

```json
{
  "name": "@local-decider/agent-plugin",
  "version": "0.1.0",
  "description": "local-decider hooks for Claude Code and Codex (built plugin directory)",
  "license": "Apache-2.0",
  "repository": { "type": "git", "url": "git+https://github.com/SkeLLLa/local-decider.git", "directory": "plugins/local-decider" },
  "files": [".claude-plugin", ".codex-plugin", "hooks", "dist", "skills", "README.md"],
  "scripts": { "prepublishOnly": "test -s dist/hook.mjs && test -s hooks/register.mjs" },
  "publishConfig": { "access": "public", "provenance": true }
}
```

No dependencies or lockfile, so neither harness installs anything. `tests/` is left out of
`files`. Hooks start through `sh run-hook.sh`, so the exec bit doesn't matter.
`pnpm-workspace.yaml`: add `- plugins/*` so `pnpm -r publish` and release-please's
`node-workspace` plugin see the package. Then run `pnpm install` to add the importer to the lockfile.

### release.yml (`publish` job, permissions unchanged: `contents: read`, `id-token: write`, env `npm`)

- `Build publishable packages`: `pnpm -r build` (drop `--filter '!@local-decider/hooks'`; hooks
  must build to fill the plugin dir).
- New step before Publish, `Plugin bundle present`:
  `test -s plugins/local-decider/dist/hook.mjs && test -s plugins/local-decider/hooks/register.mjs`
- `Publish`: unchanged (`pnpm -r publish --access public --provenance --no-git-checks`). It picks
  up the new package and skips versions already on the registry.

### release-please

`release-please-config.json` → `packages`:

```json
"plugins/local-decider": {
  "component": "agent-plugin",
  "extra-files": [
    { "type": "json", "path": ".claude-plugin/plugin.json", "jsonpath": "$.version" },
    { "type": "json", "path": ".codex-plugin/plugin.json", "jsonpath": "$.version" },
    { "type": "json", "path": "/.claude-plugin/marketplace.json", "jsonpath": "$.plugins[0].source.version" },
    { "type": "json", "path": "/.agents/plugins/marketplace.json", "jsonpath": "$.plugins[0].source.version" }
  ]
}
```

A leading `/` makes the path repo-root-relative (release-please PR #1187). `.release-please-manifest.json`:
`"plugins/local-decider": "0.1.0"`. Commits under `packages/hooks/` don't fall under that path, so
a hooks-only change won't bump the plugin by itself. Add `"exclude-paths"` handling or, simpler,
use scope `fix(plugin): …` with a touch in `plugins/local-decider`. Alternatively make the hooks
package the release unit; see Risks.

### ci.yml

- Delete the `Hook bundles are up to date` step (lines 124-126).
- Replace it with a packaging check after Build:
  `cd plugins/local-decider && npm pack --dry-run --json | node -e '…assert files include dist/hook.mjs, hooks/register.mjs, hooks/run-hook.sh, .claude-plugin/plugin.json, .codex-plugin/plugin.json'`
  (or a short script in `scripts/`), so a broken `files` list fails before release.

### .gitignore and the index

- Remove the `!plugins/local-decider/dist/` line and its comment. The global `dist/` rule now covers it.
- Add `plugins/local-decider/hooks/register.mjs`.
- `git rm --cached plugins/local-decider/dist/hook.mjs plugins/local-decider/hooks/register.mjs`.
- Keep the `.oxfmtrc.json` / `.oxlintrc.json` / `fallow.toml` ignores: the file still exists locally after a build.

### Fail-open and local dev

- `hooks/run-hook.sh`: before `exec`, add `[ -f "$root/dist/hook.mjs" ] || exit 0`, so an unbuilt
  checkout (`--plugin-dir` before building) fails open instead of node exiting 1. Add a bats case to
  `tests/run-hook.bats` (file absent → exit 0, no output).
- `mise.toml` `test:mod`: run `pnpm --filter @local-decider/hooks build` before
  `claude plugin validate --strict plugins/local-decider`.
- Dev loop, documented in `plugins/local-decider/README.md`: `pnpm --filter @local-decider/hooks build`,
  then `claude --plugin-dir plugins/local-decider`. For Codex, use a personal
  `~/.agents/plugins/marketplace.json` with `{source:"local", path:...}` pointing at the checkout. The
  repo marketplace now installs the published package, not the working tree.

### Docs

- New `docs/adr/0009-plugin-npm-distribution.md` that supersedes ADR-0004's "committed bundle" decision.
  Mark ADR-0004 "amended by 0009" and update its layout block (`dist/hook.mjs # built, published to npm`).
- `docs/install.md`, `plugins/local-decider/README.md` (lines ~80, 124), `docs/architecture.md:50`,
  `README.md:52`: say the bundle is built at release and installed from npm. Requirement: the `npm`
  CLI is on PATH (Codex needs it; Claude uses the npm client). User install commands are unchanged.

## Risks

- **First publish of a new npm name**: npm trusted publishing is configured per package on
  npmjs.com, and that may require the package to exist first. The user may need one manual
  `npm publish` (with 2FA) of 0.1.0 and then add the GitHub trusted publisher (repo, `release.yml`,
  env `npm`). Until 0.1.0 is on npm, marketplace installs fail.
- **Release-PR window**: the release PR bumps the marketplace pins before publishing. Between the
  merge and the publish job finishing (minutes), the pin names an unpublished version. Acceptable.
  Omitting `version` (latest) avoids it but drops reproducibility.
- **Hooks-only changes**: release-please bumps only on commits touching `plugins/local-decider/`.
  Mitigation: move the version source of truth to the plugin package and treat `packages/hooks` as
  its build input, e.g. by making the hooks package private and documenting that
  hook changes need a `plugins/local-decider` touch. Or add `packages/hooks` under the same
  component with release-please `"additional-paths": ["packages/hooks"]` on the plugin package
  (supported in release-please ≥16.x; verify on v5 action).
- **Supply chain**: the installable artifact now comes from the npm registry rather than git.
  Provenance links it to the workflow run. The marketplace pin limits drift. Neither harness
  runs install scripts.
- **Codex `npm` source** is newer than `local`. Check with `codex plugin marketplace add ./` plus
  `codex plugin add local-decider@local-decider` against a published version before switching docs.

## Verification

1. `pnpm --filter @local-decider/hooks build && mise run test:mod` passes. `git status` shows no
   generated files.
2. Delete `plugins/local-decider/dist`, then run `sh plugins/local-decider/hooks/run-hook.sh claude Stop </dev/null`.
   It should exit 0 with no output. `bats plugins/local-decider/tests/run-hook.bats` passes.
3. `cd plugins/local-decider && npm pack` gives a tarball whose listing has dist/, hooks/register.mjs,
   both manifests, and no tests/.
4. Unpack the tarball into an empty dir: `claude plugin validate --strict <dir>` passes. `claude --plugin-dir <dir>` runs hooks.
5. `mise run check` is green. CI no longer runs the diff step.
6. After the first release: `claude plugin marketplace add SkeLLLa/local-decider && claude plugin
   install local-decider@local-decider`. Then the Codex equivalent plus `/hooks` trust. Confirm that
   `~/.codex/plugins/cache/local-decider/local-decider/<version>/dist/hook.mjs` exists.
