# local-decider plugin for Claude Code and Codex

Hooks that send routine decisions to a local decision-model gateway: a deterministic command
guard, command-risk checks, permission triage, routing hints and turn-outcome logging. One plugin
directory serves both harnesses (see [ADR-0004](../../docs/adr/0004-marketplace-layout.md)).

## Requirements

- Node.js 20 or newer on `PATH` for the hook processes.
- A running `local-decider` gateway, by default at `http://127.0.0.1:8765`. Without it the hooks
  only run the deterministic guard and otherwise do nothing.

## Install

Claude Code:

```sh
claude plugin marketplace add SkeLLLa/local-decider
claude plugin install local-decider@local-decider
```

Codex:

```sh
codex plugin marketplace add SkeLLLa/local-decider
codex plugin add local-decider@local-decider
```

Then open the Codex TUI and run `/hooks` to review and trust the plugin hooks. Codex does not run
untrusted plugin hooks, and asks again whenever the hooks change.

## What each hook does

| Event | Claude Code | Codex |
|---|---|---|
| `PreToolUse` | Guard deny; `command-risk` deny or ask when enforced | Guard deny; `command-risk` deny when enforced |
| `PermissionRequest` | `permission` allow when enforced; otherwise the normal prompt | `permission` allow when enforced; otherwise the auto-reviewer or user |
| `UserPromptSubmit` | `routing` hint as extra context when enforced, naming the mapped model | Same |
| `Stop` | `turn-outcome`, logged only | Same |

Policies ship in `shadow` mode: the gateway records what it would have done and the hooks change
nothing until you switch a policy to `act`. The hooks never allow a tool call from `PreToolUse`
and never deny a permission request from the model.

The guard denies a short list of clearly destructive shell commands without asking the gateway:
recursive deletes of `/`, `~`, `$HOME` or system directories, deleting `.git`, `mkfs`, `dd` or
redirects onto disk devices, fork bombs, `chmod -R 777 /`, piping `curl` or `wget` into a shell,
force-pushing to `main` or `master`, and `shutdown` or `reboot`.

## Fail-open

If the gateway is down, slow or returns an error, or the hook itself fails, the hook prints
nothing and exits 0, so the harness behaves as if the plugin were not installed. The gateway call
has a 1500 ms budget; the hook timeout is 5 s.

## Configuration

Decision settings are shared with Paseo and live in the gateway's
`~/.config/local-decider/config.yaml`, which the gateway applies as it changes:

- `local-decider policies mode <policy> off|shadow|act` and
  `local-decider policies use routing <variant>` set policy modes and the routing policy;
- `local-decider routing map claude-code <preset> <model> [--thinking <level>]` (`haiku`,
  `sonnet`, `opus` or a full id) and `local-decider routing map codex <preset> <model>
  [--thinking <level>]` map routing presets to a model and, optionally, a thinking level (`low`,
  `medium`, `high`, `xhigh`, `max`). Hooks cannot switch the session model, so the routing hint
  names the model and level; Claude Code can pass the model to the subagents it starts, and you
  can switch with `/model` and Claude Code's effort control or Codex's reasoning level.

The file has a JSON Schema (`local-decider config schema`), so agents can edit it directly. The
plugin ships two skills for that: `local-decider-settings` (view and change settings) and
`local-decider-routing-policy` (interview you and write a routing policy for your models, the
same flow as Paseo's "Write with an agent" button).

Environment variables read by the hook process:

| Variable | Default | Meaning |
|---|---|---|
| `LOCAL_DECIDER_URL` | `http://127.0.0.1:8765` | Gateway base URL |
| `LOCAL_DECIDER_TOKEN` | unset | Bearer token for a remote gateway; never logged |
| `LOCAL_DECIDER_TIMEOUT_MS` | `1500` | Gateway call budget |
| `LOCAL_DECIDER_GUARD` | on | Set to `off` to disable the deterministic guard |
| `LOCAL_DECIDER_DEBUG` | unset | Set to `1` for diagnostics on stderr |

`dist/hook.mjs` is generated from `packages/hooks` by `pnpm --filter @local-decider/hooks build`.
Do not edit it by hand.
