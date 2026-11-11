# @ziptie-soft/paseo-plugin-local-decider

A [Paseo](https://paseo.sh) plugin that uses a small **local decision model** for routine,
fixed-choice calls: did an agent's turn finish, get stuck, need you, or fail; can a tool
permission request be allowed; which model fits a new agent. Everything runs on your machine,
and every policy starts in **shadow mode**: decisions are shown and logged, and nothing changes
until you switch a policy to `act`.

> Unofficial. Not affiliated with Paseo, Strands Agents, AWS, AMD or FastFlowLM.

## Requirements

- Paseo `>=0.15.3 <0.17.0`, with plugins enabled on the daemon (**Settings → Plugins → Enable
  plugins**).
- The **local-decider gateway** running on the daemon machine. The plugin is a thin client and
  never runs a model itself. Install the gateway first:
  [docs/install.md](../../docs/install.md).

## Install

Plugins are trusted, unsandboxed code, so read the source before you install.

```sh
paseo plugin install npm:@ziptie-soft/paseo-plugin-local-decider
# or straight from GitHub, optionally pinned to a branch, tag or commit
paseo plugin install github:ziptie-soft/local-decider:packages/paseo-plugin --ref master
# or from a local checkout: the plugin directory, not the repository root
paseo plugin install (pwd)/local-decider/packages/paseo-plugin
```

The plugin imports only modules Paseo provides, so no install step or build is needed.

Run `paseo plugin ls` and check that `local-decider` shows `running`. Upgrade with
`paseo plugin update local-decider`; after pulling a local checkout, use
`paseo plugin reload local-decider`.

Then open **Settings → Local decider** to pick the engine and model, choose each policy's mode,
and control the gateway service. What each setting does: [OVERVIEW.md](OVERVIEW.md). The engines
listed there come from the gateway; see [docs/engines.md](../../docs/engines.md).

## Permissions and agent modes

The permission policy only sees requests that the agent's provider shows to Paseo as a prompt:

- **Always Ask (`default`) or Accept File Edits:** every tool prompt goes to the local model
  first. When it is confident, the request is allowed without asking you. Otherwise it stays
  pending for you. This is where the plugin saves time.
- **Auto mode:** the provider's hosted classifier reviews each action first, and the plugin only
  sees what it passes on. You save nothing over auto mode alone.
- **Bypass:** nothing is asked, so there is nothing to decide.

The plugin never denies a request. Parent agents can answer a child's pending request, and those
answers can become exact-match precedent: see
[supervised child agents](../../docs/supervised-subagents.md).

## Privacy and what it runs

- Transcripts and tool requests go only to the gateway URL in settings (default
  `http://127.0.0.1:8765`). The gateway redacts secrets before the model sees them and logs
  hashes, never text.
- A bearer token (`LOCAL_DECIDER_TOKEN` in the daemon's environment, never stored in settings)
  is sent only over https or to loopback.
- The only processes the plugin starts are the gateway service commands behind the Start, Stop
  and Restart buttons. See [OVERVIEW.md](OVERVIEW.md#what-this-plugin-runs).

## Licence

Apache-2.0.
