# local-decider plugin for Claude Code and Codex

Hooks that send routine decisions to a local decision-model gateway: a deterministic command
guard, command-risk checks, permission triage, routing hints and turn-outcome logging. One plugin
directory serves both harnesses ([ADR-0004](../../docs/adr/0004-marketplace-layout.md)).

## Requirements

- Node.js 20 or newer for the hook processes. The hooks start through `hooks/run-hook.sh`, which
  uses `node` from `PATH`, then `~/.local/share/mise/shims/node`, `/opt/homebrew/bin/node` and
  `/usr/local/bin/node`. On macOS a harness started from the Dock or Spotlight has a bare `PATH`,
  so a Homebrew or mise node is still found. With no node at all the hook exits 0 silently (fail
  open).
- For the auto-mode mod: Claude Code 2.1.304 or newer.
- A running `local-decider` gateway, by default at `http://127.0.0.1:8765`
  ([install](../../docs/install.md)). Without it the hooks run only the deterministic guard.

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
untrusted plugin hooks, and asks again whenever they change.

## What each hook does

| Event | Policy | Claude Code, when enforced | Codex, when enforced |
|---|---|---|---|
| `PreToolUse` | guard, then `command-risk` | deny or ask | deny only |
| `PermissionRequest` | `permission` | allow; otherwise the normal prompt | allow; otherwise the auto-reviewer or user |
| `UserPromptSubmit` | `routing` | add a hint naming the mapped model | same |
| `Stop` | `turn-outcome` | nothing: logged only | same |

Policies ship in `shadow` mode: the gateway records what it would have done and the hooks change
nothing until you switch a policy to `act`. The hooks never allow a tool call from `PreToolUse`
and never deny a permission request from the model. They also cannot see your answer to a
prompt, so they report no outcomes: stats agreement and precedent need Paseo.

The guard runs on shell commands before any gateway call, including Codex argv arrays,
`bash -lc` scripts and commands behind `sudo`, `env` or `nice`. It denies recursive deletes of
`/`, `~`, `$HOME` or system directories, deleting `.git`, `mkfs`, `dd` or redirects onto disk
devices, fork bombs, `chmod -R 777` on system paths, piping `curl` or `wget` into a shell,
force-pushing to `main` or `master`, and `shutdown` or `reboot`.

## Claude Code auto mode

In auto mode there is no prompt: a server-side classifier decides, and a hook `allow` does not
skip it. The plugin therefore also ships a mod (`hooks/register.mjs`, listed under `modules` in
`hooks/hooks.json`; Codex does not read it) that asks the `permission` policy first. When Claude
Code would hand a plain, unremarkable `ask` to the classifier, the mod can allow it instead. It
never allows asks from rules, hooks or settings, outside auto mode, for subagents, or for
anything with a path outside the project, a protected path, `git push`, publishing, network tools,
`rm -r` or `sudo`.

**The mod never allows anything until you turn it on.** It ships with `scopes.claude-auto` in
`shadow`: it logs what it would have allowed and nothing else. Check
`local-decider stats --scope claude-auto`, then:

```sh
local-decider policies mode permission act --scope claude-auto
```

Needs Claude Code 2.1.304 or newer (older versions are skipped) and a running gateway. Set
`LOCAL_DECIDER_MOD=off` to switch it off. In act mode Claude Code shows the model a notice that
the plugin's hook "was skipped" on each allow, and in Paseo-launched sessions the allow is ignored
and the classifier decides. See [ADR-0007](../../docs/adr/0007-claude-auto-mode-mod.md).

`hooks/register.mjs` is generated from `packages/hooks/src/mod` by the same build as
`dist/hook.mjs`. `mise run test:mod` validates it and runs `claude plugin test`.

## Fail-open

If the gateway is down, slow or returns an error, or the hook itself fails, the hook prints
nothing and exits 0, so the harness behaves as if the plugin were not installed. The gateway call
has a 1500 ms budget; the hook timeout is 5 s.

## Configuration

Decision settings live in the gateway's `~/.config/local-decider/config.yaml`, shared with Paseo:

```sh
local-decider policies mode permission act
local-decider policies use routing routing-budget
local-decider routing map claude-code cheap haiku --thinking low
local-decider routing map codex premium gpt-5.5 --thinking high
```

Hooks cannot switch the session model, so the routing hint names the model and thinking level.
Claude Code can pass the model to subagents it starts, and you can switch with `/model`. See
[policies.md](../../docs/policies.md#routing-presets).

The plugin ships two skills: `local-decider-settings` (view and change settings) and
`local-decider-routing-policy` (interview you and write a routing policy for your models).

Environment variables read by the hook process and the mod:

| Variable | Default | Meaning |
|---|---|---|
| `LOCAL_DECIDER_URL` | `http://127.0.0.1:8765` | Gateway base URL |
| `LOCAL_DECIDER_TOKEN` | unset | Bearer token for a remote gateway; sent only over https or to loopback, never logged |
| `LOCAL_DECIDER_TIMEOUT_MS` | `1500` | Gateway call budget |
| `LOCAL_DECIDER_MOD` | on | Set to `off` to disable the Claude Code auto-mode mod |
| `LOCAL_DECIDER_GUARD` | on | Set to `off` to disable the deterministic guard |
| `LOCAL_DECIDER_DEBUG` | unset | Set to `1` for diagnostics on stderr |
| `LOCAL_DECIDER_HOST_POLICIES` | unset | Comma list of policies a host runs itself; the hooks skip them |

Inside Paseo, the Paseo plugin sets `LOCAL_DECIDER_HOST_POLICIES=turn-outcome,permission,routing`
on the agents it launches, so there the hooks run only the guard and `command-risk`. The skip
also applies to a `claude -p` or `codex exec` the agent starts itself, since it inherits the
environment.

`dist/hook.mjs` is generated from `packages/hooks` by `pnpm --filter @local-decider/hooks build`.
Do not edit it by hand.
