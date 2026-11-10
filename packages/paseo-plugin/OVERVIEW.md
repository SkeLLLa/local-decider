# Local decider

Local decider sends routine, fixed-choice decisions in Paseo to a small decision model that runs
on your own machine, through the local-decider gateway. It classifies how each agent turn ended,
triages tool permission requests, and can pick a model tier for new agents.

## How it works

The plugin is a thin client. It never runs a model itself. The daemon side calls the gateway
(default `http://127.0.0.1:8765`) and records decisions as compact rows in the agent's chat: the
answer, its confidence, the action, and whether it was enforced. If the gateway is down, slow,
or returns an error, Paseo behaves as if the plugin were not installed.

Every policy starts in shadow mode: decisions are recorded but change nothing. A policy changes
Paseo's behaviour only when the gateway's own policy mode is `act` and the plugin's setting for
that policy is also `act`.

- Turn outcome: after each completed or failed turn, the recent transcript is classified as done,
  needs input, stuck, or failed. Enforced attention cases are highlighted in the row. No follow-up
  prompt is ever sent.
- Permission: tool permission requests can be auto-allowed when the model is very confident. The
  plugin never denies a request; everything else stays pending for you.
- Routing: when a new agent is created, the gateway's routing policy picks a preset, which you map
  to a provider, model, and mode. The default picks `fast`, `standard`, or `deep`; you can switch
  to a budget or task-kind policy, or write your own. Paseo 0.15.3 does not pass the first prompt
  to plugins, so routing uses the agent title and skips agents without one.

## Setup

Install the gateway on the daemon machine with `local-decider gateway start`, which also installs
it as a user service (systemd on Linux, launchd on macOS). The sidebar shows whether it is up,
which model and engine it serves, and its median latency.

A remote gateway needs a bearer token. Set `LOCAL_DECIDER_TOKEN` in the daemon's environment.
The token is never stored in plugin settings, which every connected client can read.

## With the Claude Code or Codex plugin installed too

Paseo runs Claude Code and Codex agents through their own CLIs, so the local-decider plugin for
those CLIs also runs inside Paseo agents. The Paseo plugin tells it which decisions Paseo already
makes (turn outcome, permission, routing), and it skips them, so each decision is made once and
follows the modes set here. Its command guard and command-risk checks still run, since Paseo has
no equivalent.

## Settings

- Status: whether the gateway is up, and the engine's state in plain words: loaded (with model
  and engine), unloaded and loading automatically on the next decision, loading, or failed and
  why. Load now and Unload act on it right away. Lifecycle picks between automatic (load on
  demand, unload after a number of idle minutes, 1 to 1440) and always loaded. The gateway
  stores the lifecycle.
- Policies: mode per policy (`off`, `shadow`, `act`), and the threshold of each of its rules,
  such as "auto-allow when verdict is allow" at p(allow) ≥ 0.95. − and + move a threshold in
  steps of 0.05 and Reset restores the policy file's value. Lowering the auto-allow threshold
  below 0.90 warns that more requests will be auto-allowed without asking you, and below 0.80
  that the local model will often auto-allow requests it is unsure about; it never goes below
  0.50, which the gateway refuses. Thresholds are stored in the gateway's `config.yaml`
  (`policies.<id>.thresholds`), so the Claude Code and Codex hooks, which get their decisions
  from the gateway, use them too. For routing, the thresholds shown are those of the routing
  policy in use.
- Routing: which routing policy the gateway runs, a mapping for each of its presets, a reload for
  policy files, and "Write with an agent", which starts an agent that interviews you and writes a
  routing policy for your models. Routing and policy settings are stored in the gateway's
  `config.yaml`, shared with Claude Code and Codex; presets mapped by an older version of this
  plugin move there the first time the settings page opens.
- Engine and model: pick an engine (for example Strands Decider on PyTorch, or FastFlowLM on an
  AMD NPU) to list its models. Engines that are not installed or cannot run here are marked and
  say why; the plugin never installs engines (use `local-decider engine install`). Each model
  shows its download size, memory, a latency hint, and whether it is recommended. A model that is
  not downloaded has a Download button and shows progress while it downloads; one that needs
  more memory than the machine has is disabled; the one in use is marked. Use switches the
  gateway to that model now, and the gateway keeps the choice across restarts. Strands Decider
  also has a device picker, where Gateway default keeps the gateway's device.
- FastFlowLM check: the result of `flm validate` (NPU, firmware, driver), when it ran, its full
  output, and a Re-validate button.
- Decisions in chat: every decision, only notable ones (changed something, need attention,
  failed, or below 70% confidence while the policy is in shadow), or none. Routine decisions of a
  policy in act, such as the `log` after every turn, are not notable. Hiding rows does not stop
  decisions or the gateway's log. A details line and feedback buttons can be turned off
  separately.
- Sidebar: the status row at the top or bottom of the sidebar, or hidden; what its label shows;
  and whether pressing it opens a quick status popover or the status screen.
- Advanced: the gateway URL, a switch that adds the gateway's `decide` MCP tool to every agent
  session (providers without MCP support fail to open while it is on), and a switch that loads
  the model when Paseo starts.
- Paths, collapsed by default: the tools and directories the gateway uses (the `flm` launcher,
  `strands-decider`, `uv`, the FastFlowLM model directory, the Hugging Face cache). Each shows the
  path in use, where it came from (found automatically, or custom), and whether it works. You can
  set a custom absolute path, which the gateway checks before accepting it, or go back to
  automatic discovery. A remote gateway shows them read-only.

Engine, model, download, validation, path and lifecycle changes go to the gateway, not to plugin
settings, so they apply to every client of that gateway.

## What this plugin runs

The plugin starts one kind of process: the gateway's user service manager, when you press Start,
Stop or Restart gateway (on the status screen, in the Command Center, or Start in the quick
status popover while the gateway is down). The command is fixed per platform and never built from
settings or input, and each button shows it:

- Linux, when `~/.config/systemd/user/local-decider.service` exists:
  `systemctl --user start|stop|restart local-decider.service`.
- macOS, when `~/Library/LaunchAgents/dev.local-decider.gateway.plist` exists:
  `launchctl bootstrap gui/<uid> <plist>`, `launchctl bootout gui/<uid>/dev.local-decider.gateway`,
  and `launchctl kickstart -k gui/<uid>/dev.local-decider.gateway`.

It runs without a shell and times out after 20 seconds. Stop asks for confirmation first. Without
an installed service there are no buttons, only the command to install one.

## Feedback

Each turn and `/decide` row can ask "Right answer?" with one button per option. Your answer goes
to the gateway's `/v1/outcomes` as ground truth, and `local-decider stats` uses it for agreement,
Brier score, and calibration. Permission rows have no buttons: your Accept or Deny on the prompt
is the one ground-truth outcome, and the row then reads "You allowed" or "You denied". A row
says "auto-allowed" when the plugin allowed the request, otherwise "asked you", followed by what
the model leaned towards (or "unsure" below 50% confidence).

## Commands

- `/decide <policy> <text>` in an agent's composer runs a policy on your text and shows the
  result in the chat without changing anything.
- Command Center items open the settings, the status screen, and the shadow statistics, and
  start, stop or restart the gateway service (the status screen opens and shows the result; stop
  asks for confirmation there).

## Quick status, Details and preloading

- The sidebar popover has **Refresh**, **Details** and **Settings** buttons. Settings opens the
  full settings as a plugin screen.
- Paseo 0.15.3 gives plugin screens no way to open other screens, so the **Details** page shows
  the settings inline behind its **Settings** button instead of linking to them.
- **Load the model when Paseo starts** (off by default): when the plugin starts, it waits up
  to 2 minutes for the gateway and asks it to load its model once (`POST /v1/engine/load`), so
  the first decision skips the load (~5 s on FastFlowLM). With the lazy lifecycle the model
  still unloads after the idle time.
- Choosing a policy mode in settings sets it in the gateway too (`POST /v1/policies/<id>/mode`).
