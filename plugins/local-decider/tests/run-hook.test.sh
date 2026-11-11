#!/bin/sh
# Tests for hooks/run-hook.sh: finds node on a bare PATH, and fails open when there is none.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
shim="$here/../hooks/run-hook.sh"
# Normalise the path (macOS TMPDIR ends in '/') so it matches the shim's own `cd && pwd`.
tmp=$(CDPATH='' cd -- "$(mktemp -d "${TMPDIR:-/tmp}/run-hook.XXXXXX")" && pwd)
trap 'rm -rf "$tmp"' EXIT

# A plugin root with a fake dist/hook.mjs and a copy of the shim.
mkdir -p "$tmp/plugin/hooks" "$tmp/plugin/dist" "$tmp/fakebin" "$tmp/home"
cp "$shim" "$tmp/plugin/hooks/run-hook.sh"
: >"$tmp/plugin/dist/hook.mjs"

# The fake node prints its argv.
printf '#!/bin/sh\necho "node:$*"\n' >"$tmp/fakebin/node"
chmod +x "$tmp/fakebin/node"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

out=$(HOME="$tmp/home" PATH="$tmp/fakebin:/usr/bin:/bin" sh "$tmp/plugin/hooks/run-hook.sh" claude Stop) ||
  fail "node on PATH: exit $?"
[ "$out" = "node:$tmp/plugin/dist/hook.mjs claude Stop" ] || fail "node on PATH: got '$out'"

# The mise shim is used when node is not on PATH.
mkdir -p "$tmp/home/.local/share/mise/shims"
cp "$tmp/fakebin/node" "$tmp/home/.local/share/mise/shims/node"
out=$(HOME="$tmp/home" PATH=/usr/bin:/bin sh "$tmp/plugin/hooks/run-hook.sh" codex Stop) ||
  fail "mise shim: exit $?"
[ "$out" = "node:$tmp/plugin/dist/hook.mjs codex Stop" ] || fail "mise shim: got '$out'"

# No node anywhere we look: exit 0, nothing on stdout. (A real node in /opt/homebrew or
# /usr/local would be found by design, so only assert this when neither exists.)
rm "$tmp/home/.local/share/mise/shims/node"
if [ ! -x /opt/homebrew/bin/node ] && [ ! -x /usr/local/bin/node ]; then
  out=$(HOME="$tmp/home" PATH=/usr/bin:/bin sh "$tmp/plugin/hooks/run-hook.sh" claude Stop) ||
    fail "no node: exit $?"
  [ -z "$out" ] || fail "no node: stdout '$out'"
fi

echo "run-hook.sh: ok"
