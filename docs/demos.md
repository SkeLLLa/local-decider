# End-to-end demos

All on the Linux PoC machine (Ryzen AI 9 365, CPU engine, 2B model), gateway running as the
systemd user service, every policy in `shadow`.

## Gateway service (2026-11-10)

```text
$ local-decider gateway start
systemd user unit /home/m03geek/.config/systemd/user/local-decider.service started
$ local-decider gateway status
service (systemd): active
gateway http://127.0.0.1:8765: {"status":"ok","engine":"strands-decider","engineState":"ready",
  "model":"StrandsAgents/strands-decider-2B-qwen3.5-v1-2610","maxLength":4096,"queueDepth":0}
```

The engine was ready about 30 s after start (model load from a warm Hugging Face cache).

## Claude Code 2.1.311 (2026-11-10)

```sh
claude -p "Use the Bash tool to run exactly: cat notes.txt   Then reply with the file content and the word DONE." \
  --model haiku --plugin-dir plugins/local-decider --allowedTools "Bash(cat:*)"
```

All four hooks fired; shadow-log records (`decisions-2026-11-10.jsonl`, summarised):

```text
12:43:46 claude-code routing      shadow action=abstain tier=standard(0.37)     1561ms
12:43:49 claude-code command-risk shadow action=abstain risk=safe(0.97)         1617ms
12:43:51 claude-code permission   shadow action=ask     verdict=allow(0.69)     1766ms
12:43:56 claude-code turn-outcome shadow action=notify  outcome=needs_input(0.65) 2260ms
```

- `UserPromptSubmit` → `routing`, `PreToolUse` → `command-risk` (`cat notes.txt`: safe),
  `PermissionRequest` → `permission` (p(allow) below 0.95 → `ask`), `Stop` → `turn-outcome`.
- Headless `-p` mode did not approve the command, so the turn really did end waiting for the
  user; the decider classified it `needs_input`.
- Every decision took longer than the hooks' 1.5 s budget, so the hooks failed open (no output)
  and the gateway still finished and logged the shadow decisions.

## Codex CLI 0.164.0 (2026-11-10)

Installed into the real `~/.codex` from the local marketplace, hooks reviewed and trusted in the
TUI (`/hooks`), then:

```sh
codex plugin marketplace add /home/m03geek/Dev/os/local-decider
codex plugin add local-decider@local-decider
# codex → /hooks → trust the four local-decider hooks
codex exec --skip-git-repo-check -s read-only "Run the shell command: cat notes.txt. Then reply with its content and the word DONE."
```

Codex printed `hook: Stop` / `hook: Stop Completed`; shadow-log records:

```text
12:47:32 codex routing      shadow action=abstain tier=standard(0.22) 1420ms
12:47:37 codex command-risk shadow action=abstain risk=safe(0.97)     1531ms
12:47:40 codex turn-outcome shadow action=log     outcome=done(0.90)  1617ms
```

`PermissionRequest` did not fire: the read-only sandbox ran `cat` without asking.
