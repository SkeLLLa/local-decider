# shellcheck shell=bats

setup() {
  local test_dir
  test_dir=$(cd -- "$(dirname -- "$BATS_TEST_FILENAME")" && pwd -P)
  tmp=$(cd -- "$BATS_TEST_TMPDIR" && pwd)
  shim="$test_dir/../hooks/run-hook.sh"
  home="$tmp/home"
  fakebin="$tmp/fakebin"
  sysbin="$tmp/sysbin"

  mkdir -p "$tmp/plugin/hooks" "$tmp/plugin/dist" "$home" "$fakebin" "$sysbin"
  cp "$shim" "$tmp/plugin/hooks/run-hook.sh"
  : >"$tmp/plugin/dist/hook.mjs"
  ln -s "$(command -v dirname)" "$sysbin/dirname"

  # The fake node prints its argv.
  printf '#!/bin/sh\necho "node:$*"\n' >"$fakebin/node"
  chmod +x "$fakebin/node"
}

@test "uses node on PATH" {
  run env HOME="$home" PATH="$fakebin:$sysbin" /bin/sh "$tmp/plugin/hooks/run-hook.sh" claude Stop
  [ "$status" -eq 0 ]
  local expected="node:$tmp/plugin/dist/hook.mjs claude Stop"
  [ "$output" = "$expected" ] || { printf 'expected %s, got %s\n' "$expected" "$output"; return 1; }
}

@test "falls back to the mise node shim" {
  mkdir -p "$home/.local/share/mise/shims"
  cp "$fakebin/node" "$home/.local/share/mise/shims/node"
  run env HOME="$home" PATH="$sysbin" /bin/sh "$tmp/plugin/hooks/run-hook.sh" codex Stop
  [ "$status" -eq 0 ]
  local expected="node:$tmp/plugin/dist/hook.mjs codex Stop"
  [ "$output" = "$expected" ] || { printf 'expected %s, got %s\n' "$expected" "$output"; return 1; }
}

@test "fails open with no node and empty stdout" {
  if [ -x /opt/homebrew/bin/node ] || [ -x /usr/local/bin/node ]; then
    skip "a system node is installed in a fallback location"
  fi
  run env HOME="$home" PATH="$sysbin" /bin/sh "$tmp/plugin/hooks/run-hook.sh" claude Stop
  [ "$status" -eq 0 ]
  [ -z "$output" ] || { printf 'expected empty stdout, got %s\n' "$output"; return 1; }
}

@test "fails open when dist/hook.mjs is missing" {
  rm "$tmp/plugin/dist/hook.mjs"
  run env HOME="$home" PATH="$fakebin:$sysbin" /bin/sh "$tmp/plugin/hooks/run-hook.sh" claude Stop
  [ "$status" -eq 0 ]
  [ -z "$output" ] || { printf 'expected empty stdout, got %s\n' "$output"; return 1; }
}
