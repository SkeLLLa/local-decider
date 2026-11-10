# ADR-0007: Claude Code auto mode: a `tool.check` mod, shadow first

Status: accepted (2026-11-11)

## Context

In auto mode Claude Code has no permission prompt: a server-side classifier decides, and a hook
`allow` does not skip it ([#94740](https://github.com/anthropics/claude-code/issues/94740)). The
local decider could only add `ask` or `deny` there. Claude Code mods (`tool.check`, 2.1.287+)
can approve a call so that it runs without a classifier check.

## Decision

A mod, `plugins/local-decider/hooks/register.mjs` (built from `packages/hooks/src/mod/`), wraps
`tool.check` for `Bash`, `Edit`, `Write`, `MultiEdit` and `NotebookEdit`:

- It calls `next(e)` first and only ever turns a **plain `ask`** into `allow`. It never returns
  `deny`, and never changes an `allow`, a `deny`, or an ask that has a `rule`, `hook`, `setting`,
  `decider` or `ceiling`.
- It acts only when the gateway's call record says the call ran in **auto mode** (from the
  `PreToolUse` hook's `tool_use_id` and `permission_mode`) and `command-risk` answered `log`. A
  mod `allow` would also run in `dontAsk` mode, and a missing record means no allow.
- It asks the `permission` policy with `scope: "claude-auto"`. The effective mode is the lower of
  the policy's mode and `policies.permission.scopes.claude-auto.mode`, **default `shadow`**: until
  you set that scope to `act`, the mod never allows anything. It only logs.
- Path safety is the mod's job: Claude Code's own path asks (outside the working directory,
  "multiple operations") carry no field the mod can read, so a deterministic check keeps any
  call with an outside or protected path (`.git`, `.claude`, `.env*`, shell rc files, …), `git push`,
  publishing, network and container tools, `rm -r`, `sudo` or a `-c` script away from an allow.
- Subagent calls (`agentId` set) are shadow-only; the request has the tool and input but no
  history, because `$.session.messages()` returns the main conversation.
- It needs Claude Code 2.1.304 or newer (`$.session.version().base`, compared numerically).
  `LOCAL_DECIDER_MOD=off` switches it off. It skips sessions where Paseo runs the permission
  policy (`LOCAL_DECIDER_HOST_POLICIES` lists `permission`).
- A `tool.call` hook records what the classifier did, as outcome source `classifier`: a denial
  (`isError` with the classifier's denial text) is `deny`, a call that ran is `allow`, and the
  3-denials fallback or any other permission refusal records nothing. Stats only: this source never
  counts as precedent.
- Rollout: ship in shadow, read `local-decider stats --scope claude-auto`, switch to `act` after
  roughly 300 compared allows with a Wilson lower bound ≥ 0.98, reviewed disagreements and
  timeouts ≤ 5%. Roll back with `LOCAL_DECIDER_MOD=off` or the scope back to `shadow`.

## Options considered

| Option | Why not |
|---|---|
| `PreToolUse` hook `allow` | In auto mode the classifier still runs and can block (#94740) |
| `PermissionRequest` hook | Not consulted in auto mode: nothing prompts |
| Narrow `permissions.allow` rules | Static, and auto mode drops broad interpreter rules |
| `PostToolUse` `classifierContext` | Advisory note only; the classifier decides anyway |
| `--permission-prompt-tool` approval server | Only for sessions a host launches; plain CLI sessions have none |
| **`tool.check` mod** | Chosen: the one place an allow skips the classifier |

## What the experiments showed (Claude Code 2.1.319, Team login)

- A mod `allow` skipped the classifier (`permissionDecisionMs` 23 ms against 633 ms) and the
  command ran. `tool_use_id` is the same in the hook, `tool.check` and `tool.call`.
- Ask rules and `PreToolUse` hook asks are **not** overridden: the built-in guard discards the
  mod's allow and the ask stands. Host sessions (SDK `can_use_tool`, `--permission-prompt-tool`)
  are the same, silently.
- `decider: 'host'` is never set, so a host cannot be detected from `next(e)`; Paseo is detected
  through `LOCAL_DECIDER_HOST_POLICIES`.
- A refused call is not a `{deny}`: `tool.call`'s `next(e)` returns a result with `isError: true`
  and the denial text. After three denials in a row the text becomes `This command requires
  approval`.
- `dontAsk` mode reports a plain `ask`, hence the strict auto-mode check. Some safety asks (an
  outside-cwd path, "multiple operations") are plain too.
- A timeout is safe: after the budget the classifier decided in the usual way.
- `claude plugin validate --strict` accepts the bundle if `$.env.get` uses literal names and the
  hooks are top-level functions.

## Residual risks

- **A mod `allow` overrides even a classifier `hard_deny`.** With `autoMode.hard_deny` set to
  "never git push", a mod-allowed push ran. The deterministic block above keeps the obvious
  cases out, but anything the policy allows is not seen by the classifier at all.
- **Every honoured allow prints a notice** the model sees: the built-in guard says the mod's hook
  "was skipped" while it still honours the allow. This is a known cost of act mode; shadow mode
  never allows, so it adds none.
- **Host sessions fall back to the classifier silently.** The guard discards the mod's allow
  there, so `act` has no effect in them. The outcome record then shows the classifier's own
  verdict, including a denial after an allow the mod gave.
- The classifier's denial text is versioned wording; a change makes outcomes `allow` or unknown
  rather than `deny`. Agreement stats would show it.

## Consequences

Act mode can save the classifier round trip and its occasional refusal for calls the local model
allows with high confidence, at the cost above. Nothing changes until the scope is switched.
