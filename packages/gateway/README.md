# @ziptie-soft/local-decider

The local gateway and `local-decider` CLI for
[local-decider](https://github.com/ziptie-soft/local-decider). It runs a small decision model on
your machine and answers routine coding-agent questions (permission prompts, command risk,
routing, turn outcomes) for Paseo, Claude Code and Codex. It listens on `127.0.0.1:8765` and
also serves an MCP endpoint.

```sh
npm install --global @ziptie-soft/local-decider
local-decider --help
```

Requires Node.js 24 or later. Engines, policies and harness plugins are covered in the
[install guide](https://github.com/ziptie-soft/local-decider/blob/master/docs/install.md).

Licensed under Apache-2.0.
