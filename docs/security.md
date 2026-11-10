# Threat model and known limits

## Assets and trust

- **Untrusted:** everything an agent or tool produces — prompts, transcripts, tool inputs,
  commands, file contents — and so everything adapters send to the gateway.
- **Trusted:** the user's config and policy files, the pinned engine environment.

## Controls

- The gateway binds `127.0.0.1` by default. Other addresses require `LOCAL_DECIDER_TOKEN`
  (bearer); it is read from the environment only and never logged or stored in settings.
- Untrusted input is only rendered into the model's state string. The gateway never executes
  it, never uses it as a file path, URL, policy id outside the loaded set, or engine argument.
- Secrets are redacted (`core/redact.ts`) before state reaches an engine. The shadow log stores
  an input hash, answers and actions, never the state text.
- Request bodies are size-capped; engine calls have deadlines; one request in flight per engine.
- Adapters fail open, and act only on `enforced` decisions; defaults ship in `shadow`.
- The deterministic deny layer runs before any model and cannot be overridden by one.

## Known limits

- **Prompt injection.** A decision model reads attacker-controllable text. It cannot run tools,
  but it can be steered toward a label. Hence: auto-allow only at p ≥ 0.95, `command-risk` can
  only add friction, Paseo never auto-denies, and deterministic rules come first.
- **Redaction is best-effort** pattern matching; unusual secret formats get through to the local
  engine (still never to the log).
- **Calibration is per model.** Thresholds tuned on one model do not transfer; re-check
  `local-decider stats` after switching.
- **CPU latency.** On CPU the 2B model takes seconds per decision, too slow for a per-tool-call
  guard; there it suits shadow logging, turn outcomes and routing hints.
- **Claude Code auto mode** ignores hook `allow` (anthropics/claude-code#94740).
- **Service node path.** The systemd unit and launchd plist pin the absolute path of the node
  that ran `gateway start`; after removing that node version, run `gateway start` again.
- **Paseo 0.15.3** passes no first prompt to `agent.create.before`, so routing sees only the
  agent title and rarely fires there.
