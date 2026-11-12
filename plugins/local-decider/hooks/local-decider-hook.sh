#!/bin/sh
# Runs dist/local-decider-hook.mjs with whichever node can be found. A harness started from the macOS GUI has
# a bare PATH, so look in the usual places; with no node, or an unbuilt checkout
# without dist/local-decider-hook.mjs, fail open (exit 0, no output).
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd) || exit 0

node_bin=$(command -v node 2>/dev/null)
if [ -z "$node_bin" ]; then
  for candidate in \
    "$HOME/.local/share/mise/shims/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      node_bin=$candidate
      break
    fi
  done
fi
[ -n "$node_bin" ] || exit 0

[ -f "$root/dist/local-decider-hook.mjs" ] || exit 0

exec "$node_bin" "$root/dist/local-decider-hook.mjs" "$@"
