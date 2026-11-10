# Local decider

Local decider sends routine, fixed-choice decisions in Paseo to a small decision model on your
own machine, through the local-decider gateway. It classifies how each agent turn ended, triages
tool permission requests, and can pick a model for new agents.

## How it works

The plugin is a thin client; it never runs a model. The daemon side calls the gateway (default
`http://127.0.0.1:8765`) and records each decision as a compact row in the agent's chat: the
answer, its confidence, the action, and whether it was enforced. If the gateway is down, slow,
or returns an error, Paseo behaves as if the plugin were not installed.

Every policy starts in shadow mode: decisions are recorded but change nothing. A policy changes
Paseo's behaviour only when the gateway's mode and the plugin's setting for that policy are both
`act`. Choosing a mode here sets it in the gateway too.

| Policy | When | What `act` does |
|---|---|---|
| Turn outcome | After each completed or failed turn (not cancelled ones) | Classifies done, needs input, stuck or failed, and highlights the attention cases in the row. Never sends a prompt. |
| Permission | When an agent asks to use a tool | Auto-allows when the model is very confident (p(allow) ≥ 0.95 by default). Never denies; everything else stays pending for you. Questions and plan approvals are left to you. |
| Routing | When a new agent is created | Applies the preset the routing policy picks: provider, model, mode and thinking level, or an agent profile. A mode the creator set wins. Paseo 0.15.3 does not pass the first prompt, so routing uses the agent title and skips agents without one. |

For permission checks the plugin sends the project, recent chat (with tool calls summarised),
the agent's first and latest request, and the tool request. With child agents, the parent can
answer a pending request; that answer is reported as supervised feedback and can become
exact-match precedent. See the [supervised child agent guide](../../docs/supervised-subagents.md).

## Setup

Install the gateway on the daemon machine and run `local-decider gateway start`, which installs
it as a user service (systemd on Linux, launchd on macOS). The sidebar then shows whether it is
up, which model and engine it serves, and its median latency. A remote gateway needs
`LOCAL_DECIDER_TOKEN` in the daemon's environment; it is never stored in plugin settings, which
every connected client can read.

## With the Claude Code or Codex plugin installed too

Paseo runs Claude Code and Codex agents through their own CLIs, so the local-decider plugin for
those CLIs also runs inside Paseo agents. The Paseo plugin tells it which decisions Paseo already
makes (turn outcome, permission, routing), and it skips them. Its command guard and command-risk
checks still run, since Paseo has no equivalent.

## Settings

- **Status:** whether the gateway is up, and the engine's state: loaded (with model and engine),
  unloaded and loading on the next decision, loading, or failed and why. Load now and Unload act
  at once. Lifecycle picks automatic (load on demand, unload after 1 to 1440 idle minutes) or
  always loaded.
- **Policies:** the mode of each policy (`off`, `shadow`, `act`).
- **Routing:** which routing policy the gateway runs, a table mapping each of its presets to an
  agent profile or a model, with effort (thinking level) and mode, a reload for policy files, and
  "Write with an agent", which starts an agent that interviews you and writes a routing policy
  for your models.
- **Engine and model:** pick an engine (Strands Decider on PyTorch, or FastFlowLM on an AMD NPU)
  to list its models with download size, memory, a latency hint and a recommendation. Download
  shows progress; a model too big for the machine is disabled; Use switches the gateway now.
  Strands Decider also has a device picker. Engines that are not installed say how to install
  them; the plugin never installs engines. The FastFlowLM check shows the `flm validate` result
  with a Re-validate button.
- **Decisions in chat:** show all rows, only notable ones (changed something, need attention,
  failed, or below 70% confidence in shadow), or none. Hiding rows does not stop decisions or
  the gateway's log. The details line and feedback buttons can be turned off separately.
- **Sidebar:** the status item at the top or bottom of the sidebar, or hidden; what its label
  shows; and whether pressing it opens a quick status popover or the status screen.
- **Advanced:** the gateway URL; a switch that adds the gateway's `decide` MCP tool to every
  agent session (providers without MCP support then fail to open); and a switch that loads the
  model when Paseo starts.
- **Decision thresholds** (collapsed): a slider and number field for each rule of each policy,
  such as "auto-allow when verdict is allow" at p(allow) ≥ 0.95, in steps of 0.01, with Reset.
  Below 0.90 it warns that more requests are auto-allowed without asking; below 0.80 that the
  model will often auto-allow requests it is unsure about. It never goes below 0.50.
- **Paths** (collapsed): the tools and directories the gateway uses (`flm`, `strands-decider`,
  `uv`, the FastFlowLM model directory, the Hugging Face cache), where each came from, and
  whether it works. You can set a custom absolute path, which the gateway checks first. A remote
  gateway shows them read-only.

Policy modes, thresholds, routing, engine, model, lifecycle and path changes are stored by the
gateway in its `config.yaml`, so they apply to every client of that gateway, including the
Claude Code and Codex hooks.

## Status and statistics

- The **status screen** shows the gateway, the engine, and the service controls.
- The **statistics screen** shows, per policy, decisions, actions, latency, agreement with your
  answers, calibration, routing savings and the time you spent on prompts the policy would have
  allowed.
- The sidebar **quick status** popover has Refresh, Details and Settings buttons. Paseo 0.15.3
  gives plugin screens no way to open other screens, so Details shows the settings inline.

## Feedback

Turn and `/decide` rows can ask "Right answer?" with one button per option. Your answer goes to
the gateway as ground truth for agreement, Brier score and calibration. Permission rows have no
buttons: your Accept or Deny on the prompt is the outcome, and the row then reads "You allowed"
or "You denied". A row says "auto-allowed" when the plugin allowed the request, otherwise "asked
you", followed by what the model leaned towards.

## Commands

- `/decide <policy> <text>` in an agent's composer runs a policy on your text and shows the
  result in the chat without changing anything.
- Command Center items open the settings, the status screen and the statistics, and start, stop
  or restart the gateway service.

## What this plugin runs

The plugin starts one kind of process: the gateway's user service manager, when you press Start,
Stop or Restart. The command is fixed per platform, never built from settings or input, and
shown next to each button:

- Linux, when `~/.config/systemd/user/local-decider.service` exists:
  `systemctl --user start|stop|restart local-decider.service`.
- macOS, when `~/Library/LaunchAgents/dev.local-decider.gateway.plist` exists:
  `launchctl bootstrap gui/<uid> <plist>`, `launchctl bootout gui/<uid>/dev.local-decider.gateway`,
  and `launchctl kickstart -k gui/<uid>/dev.local-decider.gateway`.

It runs without a shell and times out after 20 seconds. Stop asks for confirmation first.
Without an installed service there are no buttons, only the command to install one.
