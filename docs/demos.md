# End-to-end demos

One run per harness on 2026-11-10, all on one machine (AMD Ryzen AI 9 365, CPU engine, 2B
model). The gateway ran as the systemd user service with every policy in `shadow`. Latencies
are from that machine only.

## Gateway service

```text
$ local-decider gateway start
systemd user unit ~/.config/systemd/user/local-decider.service started
$ local-decider gateway status
service (systemd): active
gateway http://127.0.0.1:8765: {"status":"ok","engine":"strands-decider","engineState":"ready",
  "model":"StrandsAgents/strands-decider-2B-qwen3.5-v1-2610","maxLength":4096,"queueDepth":0}
```

The engine was ready about 30 s after start (model load from a warm Hugging Face cache).

## Claude Code 2.1.311

```sh
claude -p "Use the Bash tool to run exactly: cat notes.txt   Then reply with the file content and the word DONE." \
  --model haiku --plugin-dir plugins/local-decider --allowedTools "Bash(cat:*)"
```

All four hooks fired. Shadow-log records, summarised:

```text
12:43:46 claude-code routing      shadow action=abstain tier=standard(0.37)       1561ms
12:43:49 claude-code command-risk shadow action=log     risk=safe(0.97)           1617ms
12:43:51 claude-code permission   shadow action=ask     verdict=allow(0.69)       1766ms
12:43:56 claude-code turn-outcome shadow action=notify  outcome=needs_input(0.65) 2260ms
```

- `UserPromptSubmit` → `routing`, `PreToolUse` → `command-risk`, `PermissionRequest` →
  `permission` (p(allow) below 0.95, so `ask`), `Stop` → `turn-outcome`.
- Headless `-p` mode did not approve the command, so the turn really ended waiting for the user;
  the decider classified it `needs_input`.
- Every decision took longer than the hooks' 1.5 s budget. The hooks failed open (no output) and
  the gateway still finished and logged the shadow decisions.

## Codex CLI 0.164.0

Installed from the local marketplace, hooks trusted in the TUI, then:

```sh
codex plugin marketplace add ~/src/local-decider
codex plugin add local-decider@ziptie-soft
# codex → /hooks → trust the four local-decider hooks
codex exec --skip-git-repo-check -s read-only "Run the shell command: cat notes.txt. Then reply with its content and the word DONE."
```

```text
12:47:32 codex routing      shadow action=abstain tier=standard(0.22) 1420ms
12:47:37 codex command-risk shadow action=log     risk=safe(0.97)     1531ms
12:47:40 codex turn-outcome shadow action=log     outcome=done(0.90)  1617ms
```

`PermissionRequest` did not fire: the read-only sandbox ran `cat` without asking.

## Paseo 0.15.3

```text
$ paseo plugin install ~/src/local-decider/packages/paseo-plugin
local-decider   running   yes   ~/src/local-decider/packages/paseo-plugin
$ paseo plugin logs local-decider
2026-11-10T12:49:22.114Z  stdout  [paseo] Loading plugin
2026-11-10T12:49:22.960Z  stdout  [paseo] Plugin ready
```

The orchestrator agent's turn ended by asking the user to reply, and `agent.turn.after`
classified it:

```text
12:49:53 paseo turn-outcome shadow action=log outcome=needs_input(0.28) 3574ms
  probabilities: needs_input 0.46, done 0.40, stuck 0.10, failed 0.04
```

Confidence was low, so no rule matched and the policy default (`log`) applied.
