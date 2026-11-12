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
`LOCAL_DECIDER_TOKEN` and `LOCAL_DECIDER_TOKEN_ORIGIN` in the daemon's environment; the bearer is
never stored in plugin settings, which every connected client can read. The daemon reads the
control and report tokens from the gateway's config directory and re-reads them after a 401.

## With the Claude Code or Codex plugin installed too

Paseo runs Claude Code and Codex agents through their own CLIs, so the local-decider plugin for
those CLIs also runs inside Paseo agents. The Paseo plugin tells it which decisions Paseo already
makes (turn outcome, permission, routing), and it skips them. Its command guard and command-risk
checks still run, since Paseo has no equivalent.

## Settings

- **Status:** whether the gateway is up, and the engine's state: loaded (with model and engine),
  unloaded and loading on the next decision, loading, failed and why, or "Benchmarking (3 of 6)"
  while a benchmark runs. Load now and Unload act
  at once. Lifecycle picks automatic (load on demand, unload after 1 to 1440 idle minutes) or
  always loaded.
- **Policies:** the mode of each policy (`off`, `shadow`, `act`).
- **Routing:** which routing policy the gateway runs, a table mapping each of its presets to an
  agent profile or a model, with effort (thinking level) and mode, a reload for policy files, and
  "Write with an agent", which starts an agent that interviews you and writes a routing policy
  for your models.
- **Engine and model** has three blocks, top to bottom. Everything comes from the gateway, so a
  gateway that knows another engine or model shows it here without a plugin update.
  - **Recommended for this machine:** the model family you are using, on the runtime that is
    fastest here, in plain words (for example "d3 lite on NPU"), with its typical and long
    latency, why it was picked, and what is running now. It shows one state at a time: nothing
    to do, a download or install to finish, a backup engine after a failure, or a manual choice
    that is slower than the recommendation. Badges say when a measurement is out of date, comes
    from few runs, is noisy, or leaves other runtimes unmeasured. A single button acts on it:
    Use, Download, Show install steps, Use automatic or Run benchmark. Switching to a specific
    runtime while Automatic is on says "(turns off automatic)" and offers to turn it back on.
  - **Benchmark this machine:** times every installed model on every runtime, one at a time, with
    short, typical and long prompts. See [Benchmarks](#benchmarks).
  - **Advanced: engine, device and model** (collapsed): the engine, device and model pickers with
    download size, memory and a latency hint, Download with progress, Use, the connection form
    for OpenAI-compatible servers, and the engine check (FastFlowLM) with a Re-validate button.
    A model too big for the machine is disabled. An engine this machine cannot run is hidden
    unless it is the active one, and an uninstalled engine says how to install it; the plugin
    never installs engines. An engine whose probabilities are not calibrated, such as
    OpenAI-compatible, shows an "uncalibrated" badge, and its models are discovered from the
    server.
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
- **Paths** (collapsed): the tools and directories the gateway uses, which depend on the gateway
  host (`flm` and the FastFlowLM model directory only appear where FastFlowLM is supported;
  `strands-decider`, `uv` and the Hugging Face cache everywhere), where each came from, and
  whether it works. You can set a custom absolute path, which the gateway checks first. A remote
  gateway shows them read-only.

Policy modes, thresholds, routing, engine, model, lifecycle and path changes are stored by the
gateway in its `config.yaml`, so they apply to every client of that gateway, including the
Claude Code and Codex hooks.

## Benchmarks

A benchmark runs inside the gateway, one model and runtime at a time, and keeps going if you
close settings. It measures short, typical (1,024 tokens) and long (3,800 tokens) prompts.

- **Decisions are passed to you while it runs.** The gateway fails open, so agents are never
  blocked; the status views say "Benchmarking (k of n)".
- **Your setup comes back when it ends.** In automatic mode the gateway then re-ranks with the
  new results, so it may land on a faster runtime of the same model family. If it cannot switch
  back, the card says so and offers Try again and Use automatic.
- **Cancel keeps what finished.** Finish benchmark measures only what is missing.
- **Results are from this machine only.** Each is stamped with the engine version and hardware,
  and goes out of date when either changes; run the benchmark again then. Custom servers are not
  benchmarked.

### How the recommendation is chosen

The recommendation compares runtimes of **one model family** and never changes the family. The
family is the one you chose, else the gateway's default. Within it:

1. Runtimes with a fresh measurement are ranked by typical latency; the fastest wins.
2. Close calls (within about 10%) go to a dedicated runtime such as the NPU, then to the steadier
   one, then to the hardware order NPU, CUDA, Vulkan, MLX, MPS, CPU.
3. An out-of-date or few-run measurement counts as unmeasured: that runtime keeps its place in the
   hardware order until it is measured again.
4. A runtime whose last run failed moves behind the ranked ones.

If a different family is clearly faster here, the card says so with a link to the results; it
does not switch for you. In the results, Use fastest acts per family.

## Status and statistics

- The **status screen** shows the gateway, the engine, and the service controls.
- The **statistics screen** shows, per policy, decisions, actions, latency, agreement with your
  answers, calibration, routing savings and the time you spent on prompts the policy would have
  allowed.
- The sidebar **quick status** popover has Refresh, Details and Settings buttons. Paseo 0.15.3
  gives plugin screens no way to open other screens, so Details shows the settings inline.

## Feedback

Turn and `/decide` rows can ask "Right answer?" with one button per option. Your answer goes to
the gateway as ground truth for agreement, Brier score and calibration. Permission rows take your
Accept or Decline on the prompt as the outcome, and the row then reads "You allowed", "You
declined" or "You stopped the agent" (a Stop without Paseo's `interrupt` flag shows as a
decline). A decline is neutral; the row then offers *Not a safety issue*, *Unsafe* and *Skip*,
and only *Unsafe* is reported (as a veto). An auto-allowed row with a precedent key offers
*Mark unsafe*, which stops your past allows from lowering that subject's threshold; a
high-confidence rule may still allow it. Chips work for 24 hours and one tap, are unavailable
for rows drawn before a daemon restart, and follow "Ask for feedback". A row says "auto-allowed"
when the plugin allowed the request, otherwise "asked you", followed by what the model leaned
towards.

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
