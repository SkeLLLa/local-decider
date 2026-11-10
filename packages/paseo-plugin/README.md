# paseo-plugin-local-decider

A [Paseo](https://paseo.sh) plugin that uses a small **local decision model** for routine,
fixed-choice calls: did an agent's turn finish, get stuck, need you, or fail; can a permission
request be allowed; which model tier fits a new task. Everything runs on your machine, and
everything starts in **shadow mode**: decisions are shown and logged, nothing is changed until
you switch a policy to "act".

> Unofficial. Not affiliated with Paseo, Strands Agents, AWS, AMD or FastFlowLM.

## Requirements

The plugin is a thin client of the **local-decider gateway**, which runs the model:

- Linux with an AMD Ryzen AI NPU: FastFlowLM `d3` models (~0.25–0.6 s per decision), or
- any Linux/macOS machine: Strands Decider (PyTorch; CPU, Apple MLX/MPS or CUDA).

Install and start the gateway first:
[github.com/SkeLLLa/local-decider](https://github.com/SkeLLLa/local-decider#quick-start).

## Install

Plugins must be enabled on the daemon first (**Settings → Plugins → Enable plugins**). Plugins
are trusted, unsandboxed code, so read the source before you install. Pick one of these:

**From npm:**

```sh
paseo plugin install npm:paseo-plugin-local-decider
```

**From GitHub.** The plugin is in the `packages/paseo-plugin` directory of the monorepo, so add
that path after a `:` at the end of the source:

```sh
paseo plugin install github:SkeLLLa/local-decider:packages/paseo-plugin
# or as a full Git URL
paseo plugin install https://github.com/SkeLLLa/local-decider.git:packages/paseo-plugin
# pin a branch, tag or commit
paseo plugin install github:SkeLLLa/local-decider:packages/paseo-plugin --ref main
```

**From a local checkout.** Give the absolute path to the plugin directory, not the repository
root:

```sh
git clone https://github.com/SkeLLLa/local-decider.git
paseo plugin install (pwd)/local-decider/packages/paseo-plugin
```

The plugin imports only modules Paseo provides, so none of these need `pnpm install` or a build.
Run `paseo plugin ls` and check that `local-decider` shows `running`. To upgrade, run
`paseo plugin update local-decider`. A local directory install loads the files in place, so use
`paseo plugin reload local-decider` after you pull.

Then open **Settings → Local decider** to pick the engine and model (with download buttons),
check the NPU, choose each policy's mode, and control the gateway service.

## Privacy and what it runs

- Agent transcripts and tool requests are sent only to the gateway URL in settings (default
  `http://127.0.0.1:8765`). The gateway redacts secrets before the model sees them and logs
  hashes, never text.
- A bearer token (`LOCAL_DECIDER_TOKEN`, read from the daemon's environment, never stored in
  settings) is only sent over https or to loopback.
- The only processes the plugin starts are the gateway service commands behind the Start / Stop /
  Restart buttons (`systemctl --user … local-decider.service` or `launchctl …`), shown next to each
  button. See [OVERVIEW.md](OVERVIEW.md).

## Licence

Apache-2.0.
