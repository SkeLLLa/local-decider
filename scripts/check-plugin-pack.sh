#!/bin/sh
# Fails unless `npm pack` of the plugin dir lists the built bundle and manifests, and no tests.
# Run after `pnpm -r build`. Usage: scripts/check-plugin-pack.sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root/plugins/local-decider"
listing=$(npm pack --dry-run --json | grep '"path"')

status=0
for want in dist/hook.mjs hooks/register.mjs hooks/run-hook.sh hooks/hooks.json \
  hooks/codex-hooks.json .claude-plugin/plugin.json .codex-plugin/plugin.json; do
  if ! printf '%s\n' "$listing" | grep -q "\"path\": \"$want\""; then
    echo "::error::npm pack is missing $want" >&2
    status=1
  fi
done
if printf '%s\n' "$listing" | grep -q '"path": "tests/'; then
  echo "::error::npm pack includes tests/" >&2
  status=1
fi
exit "$status"
