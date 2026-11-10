---
name: local-decider-settings
description: View or change local-decider settings (policy modes, the routing policy variant, which model each routing preset maps to for Paseo, Claude Code or Codex, engine lifecycle, tool paths, pricing). Use when the user asks to configure local-decider, turn a policy on, off or to act mode, switch routing policy, or map routing presets to models.
---

# local-decider settings

Every local-decider setting lives in one YAML file that the gateway watches and applies as it
changes. Paseo's settings page writes to the same file.

1. Find it: `local-decider config path` prints `config.yaml`, the `schemas/` directory and the
   user `policies/` directory (usually under `~/.config/local-decider/`).
2. Read `schemas/config.schema.json` next to it before editing: every key has a description.
   Run `local-decider config schema` first if the directory is missing.
3. Prefer the commands, which validate before writing:
   - `local-decider policies` lists policies, their modes, routes and variants (gateway running).
   - `local-decider policies mode <policy> off|shadow|act`
   - `local-decider policies use routing <variant>` (e.g. `routing-budget`, `routing-task-kind`)
   - `local-decider routing` shows preset targets; `local-decider routing map <harness> <preset>
     <model> [mode]` and `local-decider routing unmap <harness> <preset>` change them. Harness ids
     are `paseo` (model as `provider/model`, optional mode id), `claude-code` (`haiku`, `sonnet`,
     `opus` or a full model id) and `codex` (a model id).
4. Or edit `config.yaml` directly, keeping its comments, then run `local-decider config check`.
   The keys are `policies.<id>.mode`, `policies.<id>.variant` and
   `routing.presets.<harness>.<preset>.model`/`.mode`.
5. Changes to `host`, `port`, `engine` or `decisionTimeoutMs` need
   `local-decider gateway restart`; everything else applies within a second.

Policies ship in shadow mode. Confirm with the user before switching one to `act`, because
the hooks then change behaviour (auto-allowing permission requests, denying risky commands).
Claude Code and Codex cannot switch the session model from a hook: a mapped routing preset is
passed to the session as advice naming the model.
