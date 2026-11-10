# Local decider

Local decider sends routine, fixed-choice decisions in Paseo to a small decision model that runs
on your own machine, through the local-decider gateway. It classifies how each agent turn ended,
triages tool permission requests, and can pick a model tier for new agents.

## How it works

The plugin is a thin client. It never runs a model itself. The daemon side calls the gateway
(default `http://127.0.0.1:8765`) and records every decision as a compact row in the agent's chat:
the answer, its confidence, the action, and whether it was enforced. If the gateway is down, slow,
or returns an error, Paseo behaves as if the plugin were not installed.

Every policy starts in shadow mode: decisions are recorded but change nothing. A policy changes
Paseo's behaviour only when the gateway's own policy mode is `act` and the plugin's setting for
that policy is also `act`.

- Turn outcome: after each completed or failed turn, the recent transcript is classified as done,
  needs input, stuck, or failed. Enforced attention cases are highlighted in the row. No follow-up
  prompt is ever sent.
- Permission: tool permission requests can be auto-allowed when the model is very confident. The
  plugin never denies a request; everything else stays pending for you.
- Routing: when a new agent is created, the gateway can pick a `fast`, `standard`, or `deep`
  preset, which you map to a provider, model, and mode. Paseo 0.15.3 does not pass the first
  prompt to plugins, so routing uses the agent title and skips agents without one.

## Setup

Install and start the gateway on the daemon machine with `local-decider gateway start`. The
sidebar footer shows whether it is up, which model it serves, and its median latency.

A remote gateway needs a bearer token. Set `LOCAL_DECIDER_TOKEN` in the daemon's environment.
The token is never stored in plugin settings, which every connected client can read.

## Settings and commands

- Gateway URL, preferred engine, decision model, and device. The gateway's own configuration
  decides what actually runs; the status screen shows the live values.
- Mode per policy (`off`, `shadow`, `act`) and the routing preset mapping, with a refresh for
  provider models.
- An optional switch that adds the gateway's `decide` MCP tool to every agent session. Providers
  without MCP support fail to open while it is on.
- `/decide <policy> <text>` in an agent's composer runs a policy on your text and shows the
  result in the chat without changing anything.
- Command Center items open the settings, the status screen, and the shadow statistics.
