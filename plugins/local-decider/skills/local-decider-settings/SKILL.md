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
     <model> [--thinking <level>] [--mode <mode>]` and `local-decider routing unmap <harness>
     <preset>` change them. Harness ids are `paseo` (model as `provider/model`, plus optional
     `--mode <mode-id>` and `--profile <paseo-profile-id>`), `claude-code` (`haiku`, `sonnet`,
     `opus` or a full model id) and `codex` (a model id). `--thinking` sets a thinking or
     reasoning level such as `low`, `medium`, `high`, `xhigh` or `max`.
4. Or edit `config.yaml` directly, keeping its comments, then run `local-decider config check`.
   The keys are `policies.<id>.mode`, `policies.<id>.variant` and
   `routing.presets.<harness>.<preset>.model`/`.thinking`/`.mode`/`.profile` (`mode` and
   `profile` apply to Paseo only).
5. Changes to `host`, `port`, `engine` or `decisionTimeoutMs` need
   `local-decider gateway restart`; everything else applies within a second.

Policies ship in shadow mode. Confirm with the user before switching one to `act`, because
the hooks then change behaviour (auto-allowing permission requests, denying risky commands).
Claude Code and Codex cannot switch the session model from a hook: a mapped routing preset is
passed to the session as advice naming the model and, when mapped, the thinking level (the user
sets it with `/model` and the harness's effort or reasoning control).
