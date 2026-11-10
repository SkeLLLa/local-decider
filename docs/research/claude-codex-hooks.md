# Claude Code and Codex CLI: plugins, hooks, marketplaces

Research for `local-decider`. The plan is a Claude Code plugin and a Codex plugin whose hooks call a local
gateway (`POST /v1/systemone`) with a short timeout and fail open.

Versions checked: Claude Code 2.1.311, Codex CLI 0.164.0 (2026-11-10).

How each claim was checked:
- **[src]**: openai/codex source on `main` (read with `gh api`).
- **[doc]**: official docs, code.claude.com or learn.chatgpt.com.
- **[cli]**: `--help` output from the installed binaries.
- **[local]**: files under `~/.codex`.
- **UNVERIFIED**: inferred or not tested.

---

## 0. TL;DR

- **Claude Code**
  - Hooks go in `plugins/<p>/hooks/hooks.json`, loaded by default, and receive `${CLAUDE_PLUGIN_ROOT}`.
  - A PreToolUse hook can return `allow`, `deny`, `ask` or `defer`. PermissionRequest uses `decision.behavior` `allow` or `deny`.
  - A timeout, a crash, or an exit code other than 0 or 2 is non-blocking, so fail-open is the default. Never exit 2 on an internal error.
- **Claude auto mode**
  - A PreToolUse `allow` does **not** skip the auto-mode classifier. This is anthropics/claude-code#94740, still OPEN.
  - A **mod** (`tool.check` in a JS module) is documented to bypass the classifier: "a call the mod approves runs without a classifier check".
- **Codex**
  - Hooks use the same JSON shapes as Claude, with stricter checks. PreToolUse `allow` is **rejected** unless it carries `updatedInput`, and `ask` is rejected too. So PreToolUse is deny-only.
  - Codex approves through **PermissionRequest** (`behavior: allow|deny`). That hook runs **before** the guardian/auto-review, and a hook `allow` skips the reviewer.
  - Codex reads `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` as fallbacks, and it exports `CLAUDE_PLUGIN_ROOT`.
- **One repo serves both** with two marketplace files and one plugin directory that has two manifests. Codex's manifest points at a separate hooks file.

---

## 1. Claude Code plugin layout, marketplace, install

### Plugin layout [doc: plugins/manifest-reference]

```
my-plugin/
├── .claude-plugin/plugin.json   # optional manifest; only `name` is required
├── hooks/hooks.json             # default hooks file, always loaded if present
├── scripts/…                    # anything; referenced via ${CLAUDE_PLUGIN_ROOT}
├── skills/<name>/SKILL.md
├── .mcp.json
└── bin/                         # put on Bash tool PATH while enabled
```

- **Path rules.** Component paths must start with `./`, stay inside the plugin root, and exist. A path containing `..` fails validation.
- **`hooks` in plugin.json.** It takes a path, an inline object, or an array of either. It **merges** with `hooks/hooks.json` and does not replace it.
- **Unknown top-level manifest keys.** They are stripped with a warning, so `interface` or `policy` are harmless.
- **Name.** It must be kebab-case. A name starting with `claude-`, `anthropic-` or `cc-plugin-` is an error.

Minimal `plugin.json`:
```json
{
  "name": "local-decider",
  "version": "0.1.0",
  "description": "Routes permission decisions through a local decision model; fails open.",
  "author": { "name": "SkeLLLa" },
  "license": "MIT",
  "userConfig": {
    "gateway_url": { "type": "string", "title": "Gateway URL",
      "description": "local-decider gateway", "default": "http://127.0.0.1:8765" },
    "timeout_ms":  { "type": "number", "title": "Timeout (ms)",
      "description": "Per-call timeout", "default": 1500, "min": 100, "max": 10000 }
  }
}
```

- `userConfig` values reach hook processes as `CLAUDE_PLUGIN_OPTION_<KEY>`, for example `CLAUDE_PLUGIN_OPTION_GATEWAY_URL`.
- `${user_config.KEY}` only substitutes into exec-form `args`. Shell-form `command` rejects it.

`hooks/hooks.json`. The `"hooks"` wrapper is required in a file, and `timeout` is in **seconds**:
```json
{
  "description": "local-decider hooks",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|mcp__.*",
        "hooks": [ { "type": "command",
                     "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/hook.mjs claude pre-tool-use",
                     "timeout": 3 } ] }
    ],
    "PermissionRequest": [ { "matcher": "*", "hooks": [ { "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/hook.mjs claude permission-request", "timeout": 3 } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/hook.mjs claude user-prompt-submit", "timeout": 3 } ] } ],
    "Stop": [ { "hooks": [ { "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/hook.mjs claude stop", "timeout": 3 } ] } ]
  }
}
```

- **Environment exported to hook processes:** `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` (`~/.claude/plugins/data/<id>/`, which survives updates), `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_OPTION_*`.
- **Quoting.** Wrap `${CLAUDE_PLUGIN_ROOT}` in double quotes in shell form. Alternatively use exec form (`args` array).
- **Other hook types** are `http`, `mcp_tool`, `prompt` and `agent`.
- **`http` hooks.** `{"type":"http","url":"http://127.0.0.1:8765/hooks/claude/pre-tool-use","timeout":2}` POSTs the stdin JSON to the URL. The response body must use the same output JSON format.
  - A non-2xx status or a connection failure is a **non-blocking error**, which is a natural fail-open.
  - This needs no Node at all, provided the gateway serves Claude-native hook endpoints next to `/v1/systemone`.
  - Codex has no `http` hook type: its types are `command`, `mcp_tool` and `prompt` [src protocol/src/hooks.rs].

### Which Node runs scripts?

- Claude Code ships as a single native binary (`claude`, about 280 MB). Command hooks run a **shell command** with the user's environment, and nothing bundles `node`. Whatever `node` resolves on `PATH` is used.
- Under mise, PATH can differ in GUI or desktop launches. **UNVERIFIED**: I did not confirm whether hook processes inherit mise shims.
- Recommendations:
  - Ship a dependency-free, single-file `dist/hook.mjs` that targets Node ≥18 (global `fetch` and `AbortSignal.timeout`).
  - Or use a tiny POSIX `sh` wrapper that exits 0 silently when `node` is missing (fail open).
- **Mods** (`hooks/hooks.json` → `"modules": ["./register.js"]`) run **inside Claude Code's own JS runtime**. They need no Node and no build step, and `.ts` loads directly.

### Marketplace [doc: plugin-marketplaces, cli]

File: `<root>/.claude-plugin/marketplace.json`. Required fields are `name`, `owner` and `plugins[]`. Each entry needs `name` and `source`.

```json
{
  "name": "local-decider",
  "owner": { "name": "SkeLLLa" },
  "description": "local-decider plugins",
  "plugins": [
    { "name": "local-decider", "source": "./plugins/local-decider",
      "description": "Local decision-model permission hooks (fail-open)" }
  ]
}
```

- **Source types:**
  - a relative path string (no `..`)
  - `{ "source": "github", "repo": "o/r" }`
  - `{ "source": "git-subdir", "url": "o/r", "path": "plugins/x" }`
  - `url`, `archive`, `npm`, `command`
- **Pinning:** git sources accept `ref` and `sha`.
- **Naming:** keep the entry `name` equal to the `plugin.json` `name`.
- **Validation:** `claude plugin validate ./ --strict` warns on unknown fields such as Codex's `policy` and `category`. With `--strict` those warnings fail.

### CLI flow [cli]

```
claude plugin validate ./                              # marketplace + each relative plugin
claude plugin marketplace add ./                       # or: add SkeLLLa/local-decider  (--scope user|project|local, --sparse .claude-plugin plugins)
claude plugin install local-decider@local-decider      # -s user|project|local ; --config key=value for userConfig
claude plugin list | details local-decider | enable | disable
claude --plugin-dir ./plugins/local-decider            # dev: load without installing, hot-reload
```

- **Local marketplace.** A marketplace added from a local path loads relative-path plugins **in place**. Edits apply on `/reload-plugins`.
- **Hosted marketplace.** Hosted installs are copied into the plugin cache and pinned by `version`.
- **Cache path.** Probably `~/.claude/plugins/cache/<mkt>/<plugin>/<version>/` (**UNVERIFIED**).

---

## 2. Claude Code hook I/O

### Common stdin fields [doc]
```json
{ "session_id": "abc123", "prompt_id": "…", "transcript_path": "…/x.jsonl", "cwd": "/repo",
  "permission_mode": "default|acceptEdits|plan|auto|dontAsk|bypassPermissions",
  "effort": "…", "hook_event_name": "PreToolUse", "agent_id": "(subagents only)", "agent_type": "…" }
```
The `permission_mode` enum is **UNVERIFIED** beyond `default`; the docs example only shows that value.

### Exit codes and timeouts [doc]

| Outcome | Effect |
|---|---|
| exit 0, empty stdout | no decision → normal permission flow |
| exit 0 + JSON | JSON applied |
| exit 2 | blocking; stderr is the reason. **Not honored for PermissionRequest**: use `decision` |
| other exit, invalid JSON, crash | **non-blocking** error; the action proceeds through normal flow |
| timeout | hook cancelled, output discarded, non-blocking. PreToolUse is not blocked unless `"onFailure": "block"` (v2.1.295+) |

Default timeouts:
- 600 s for `command`, `http` and `mcp_tool`.
- 30 s for those three on `UserPromptSubmit`.
- 30 s for `prompt` hooks and 60 s for `agent` hooks.

Universal output fields are `continue`, `stopReason`, `suppressOutput` and `systemMessage`. `systemMessage` is a warning shown to the user only.

### PreToolUse

Input adds `tool_name`, `tool_input` and `tool_use_id`:
```json
{ "hook_event_name": "PreToolUse", "tool_name": "Bash",
  "tool_input": { "command": "npm test", "description": "Run tests", "timeout": 120000, "run_in_background": false },
  "tool_use_id": "toolu_01…" }
```
Output:
```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask|defer",
    "permissionDecisionReason": "shown to user (allow/ask) or to Claude (deny)",
    "updatedInput": { "…": "replaces the whole tool_input" },
    "additionalContext": "context for Claude, appears next to the tool result" } }
```

- **`allow`** skips the permission prompt. **Deny and ask rules are still evaluated** regardless of the hook.
  - Some calls still prompt: critical-path `rm`, network-path reads, and `requiresUserInteraction` MCP tools.
  - In plan mode, `allow` has no effect on calls that are not read-only.
- **`defer`** needs `-p` (non-interactive mode).
- **Precedence across hooks** is `deny` > `defer` > `ask` > `allow`.
- **Abstain** means exit 0 with no stdout.

### PermissionRequest

It runs only when Claude Code is about to show a permission prompt, or when it would auto-deny a call that can't prompt. In headless sessions with no hook decision, the call is **denied**.
```json
{ "hook_event_name": "PermissionRequest", "tool_name": "Bash",
  "tool_input": { "command": "rm -rf node_modules", "description": "…" },
  "permission_suggestions": [ { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "rm -rf node_modules" }],
                                "behavior": "allow", "destination": "localSettings" } ] }
```
Output:
```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow", "updatedInput": { "command": "npm run lint" }, "updatedPermissions": [ … ] } } }
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest",
    "decision": { "behavior": "deny", "message": "why (to Claude)", "interrupt": false } } }
```
`updatedInput` and `updatedPermissions` apply to allow only. `message` and `interrupt` apply to deny only. To abstain, print nothing.

### UserPromptSubmit
Input adds `"prompt": "…"`. Output:
```json
{ "decision": "block", "reason": "shown to user",
  "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
    "additionalContext": "added alongside the prompt", "sessionTitle": "…", "suppressOriginalPrompt": true } }
```
- Plain stdout on exit 0 is also added as context.
- Omit `decision` to allow the prompt.
- Exit 2 blocks the prompt.

### Stop
Input adds these fields:
- `stop_hook_active`: true when this turn is already a stop-hook continuation.
- `last_assistant_message`
- `background_tasks[]`
- `session_crons[]`

Output:
```json
{ "decision": "block", "reason": "required; tells Claude why to continue" }
{ "hookSpecificOutput": { "hookEventName": "Stop", "additionalContext": "non-error feedback" } }
```
**Can Stop add context without blocking?** Only partly:
- `additionalContext` is not labelled an error ("Stop hook feedback"), but **it still continues the conversation**. It goes through the same loop protection: `stop_hook_active` and an 8-continuation cap, which `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` overrides.
- No field adds model context and still lets the turn end. `systemMessage` shows text to the user only.
- To prime the *next* turn, save state at Stop and inject it from `UserPromptSubmit`.

### Fail-open recipe (Claude and Codex)
- Use an internal HTTP timeout **shorter** than the hook `timeout`, for example a 1500 ms fetch with `"timeout": 3`.
- On any error (ECONNREFUSED, timeout, non-2xx, bad JSON), print nothing and `exit 0`. Never exit 2 or print a malformed JSON object.
- Only emit `deny` or `block` when the model is confident. Use abstention, not `ask`, for uncertain cases. In Codex, `ask` is invalid.

---

## 3. Auto mode vs. hook `allow`: anthropics/claude-code#94740

- **Issue:** "Auto mode: a PreToolUse hook "allow" should resolve the action like a permissions.allow rule".
- **Status:** OPEN, created 2026-09-16, labels `enhancement`, `area:hooks`, `area:permissions`. Reported on v2.1.266.
- **The documented auto-mode decision order** [doc permission-modes]:
  1. allow/ask/deny **rules** resolve immediately
  2. read-only actions and in-cwd edits are auto-approved
  3. everything else goes to the **classifier**

  Hooks are not a step in that order.
- **The reporter's point.** `permissionDecision: "allow"` only "skips the permission prompt". Auto mode has no prompt, so a hook-approved Bash command **still goes to the classifier and can be hard-blocked**. Hook `deny` and `ask` are honoured. The reporter's transcript replay found 3 commands the classifier blocked despite a hook allow.
- **What the issue asks for:**
  - let a hook `allow` resolve at step 1, possibly opt-in via something like `"resolvesAutoMode": true`
  - or provide a policy channel that the classifier consults
  - or at least document the behaviour
- **Activity:** one non-maintainer comment and no fix.
- **Current docs (2.1.311) still match.** Auto-mode step 1 lists only rules, and a PreToolUse `allow` can't approve critical-path removals.
  - PreToolUse `ask` in auto mode goes to the prompt without the classifier deciding.
  - `updatedInput` without `permissionDecision` can be denied as "changed after auto mode reviewed it".

**Verdict:** a hook `allow` does **not** override the auto-mode classifier. It can only tighten: `deny`, or `ask` to force a prompt.

**Workarounds:**
1. **Mod `tool.check`** [doc plugins/mods/events, permissions]. In auto mode, "a call the mod approves runs without a classifier check".
   - `tool.check` fires after PreToolUse hooks and *before* the prompt, the classifier and PermissionRequest.
   - It returns `{ decision: 'allow'|'ask'|'deny', reason? }`.
   - With managed settings, `managed-mcp.json`, or a Team/Enterprise login, deny rules, ask rules, hook-forced prompts and hook blocks still stand by default.
   - It can call the gateway with `$.http.fetch`. The hook's own time limit is 10 s, and time inside `$.http.fetch` doesn't count. A `.catch` handler gets 1 s.
   - A throw or timeout means the call gets the decision it would have had without the mod, which is fail-open.
   - Since v2.1.287, the "built-in guard" may restrict installed mods in org setups.
   ```js
   // plugins/local-decider/hooks/register.js   (hooks/hooks.json: { "modules": ["./register.js"], "hooks": {…} })
   export function register(on) {
     on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
       const decided = await next(e)                 // rules + mode + PreToolUse result
       if (decided.decision !== 'ask') return decided // only try to resolve what would prompt / hit classifier
       const r = await $.http.fetch('http://127.0.0.1:8765/v1/systemone', { method: 'POST', body: JSON.stringify({ /* … */ }) })
       // map answer → { decision: 'allow' } | { decision: 'deny', reason } | decided
       return decided
     })
   }
   ```
   **UNVERIFIED:** the exact `$.http.fetch` signature. Check the generated `.claude-plugin/types/claude-code/index.d.ts`.
2. **PostToolUse `classifierContext`** feeds the classifier an "unverified, application-provided" note. It is advisory only.
3. **Narrow `permissions.allow` rules.** Auto mode drops broad interpreter and `Bash(*)` rules.

---

## 4. Codex CLI

### Hook config locations [doc learn.chatgpt.com/docs/hooks, src discovery.rs, local]
- **User and project files:** `~/.codex/hooks.json` and `<repo>/.codex/hooks.json`, or inline `[hooks]` in `config.toml`. Project layers load only if the project is trusted.
- **Feature flag:** `hooks` is stable and on by default (`codex features list`). `plugin_hooks` is listed as "removed", meaning folded into `hooks`.
- **Trust.** Non-managed hooks, **including plugin hooks**, must be reviewed and trusted in the TUI via `/hooks`.
  - Trust is hash-based, and a changed script requires re-trust. It is stored in `config.toml` `[hooks.state."<path>:pre_tool_use:0:0"] trusted_hash = "sha256:…"` [local].
  - `--dangerously-bypass-hook-trust` skips the check for one run.
- **Matcher.** A regex; `*`, empty or omitted matches all.
  - Shell commands match as `Bash`.
  - `apply_patch` also matches `Edit` and `Write`, but input `tool_name` stays `"apply_patch"`.
  - MCP tools match as `mcp__server__tool`. Hosted tools such as WebSearch are not covered.
  - For Bash and apply_patch, the text is in `tool_input.command`.
- **Handler fields** [src protocol/src/hooks.rs]:
  - `type: "command"`
  - `command`, `commandWindows`
  - `timeout`, in **seconds**, default **600**. SessionEnd and Interrupt default to 1 s, max 3.
  - `async`
  - `statusMessage`
  - `additionalContextLimit`

  The file format is Claude-compatible.

TOML form, copied from a local project config:
```toml
[[hooks.PreToolUse]]
matcher = "^Bash$"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "node .agents/scripts/hook-runner.mjs pre-tool-use"
timeout = 30
statusMessage = "Checking command policy"
```

### Events [src app-server-protocol HookEventName]
- `PreModelRequest`, `PostModelRequest`
- `PreToolUse`, `PermissionRequest`, `PostToolUse`
- `PreCompact`, `PostCompact`
- `SessionStart`, `SessionEnd`
- `UserPromptSubmit`
- `SubagentStart`, `SubagentStop`
- `Stop`, `Interrupt`

### Stdin schemas [src codex-rs/hooks/schema/generated/*.json]

Common required fields: `session_id`, `cwd`, `hook_event_name`, `model`, `permission_mode` (`default|acceptEdits|plan|dontAsk|bypassPermissions`), `transcript_path` (nullable) and `turn_id` (a Codex extension). `agent_id` and `agent_type` are optional.

| Event | Extra required fields |
|---|---|
| PreToolUse | `tool_name`, `tool_input` (any), `tool_use_id` |
| PermissionRequest | `tool_name`, `tool_input` (**no** `tool_use_id`, no `permission_suggestions`) |
| UserPromptSubmit | `prompt` |
| Stop | `stop_hook_active`, `last_assistant_message` (nullable) |

All of these schemas have `additionalProperties: false`, so the field sets are exact.

**Host detection inside a shared script:**
- `turn_id` present, or `model` present → Codex.
- Codex also exports `PLUGIN_ROOT` and `PLUGIN_DATA` next to the `CLAUDE_*` aliases.
- Simplest: pass `codex` or `claude` as an argv flag from each hooks file.

### Stdout schemas and semantics [src output_parser.rs, events/*.rs]
- **Universal fields:** `continue`, `stopReason`, `suppressOutput` and `systemMessage`. On PreToolUse and PermissionRequest, `continue:false`, `stopReason` and `suppressOutput` are **rejected as unsupported**: the hook is marked Failed and the call proceeds.
- **PreToolUse output schema:**
  ```json
  { "decision": "approve|block", "reason": "…",
    "hookSpecificOutput": { "hookEventName": "PreToolUse",
      "permissionDecision": "allow|deny|ask", "permissionDecisionReason": "…",
      "updatedInput": {}, "additionalContext": "…" } }
  ```
  - `deny` **requires** a non-empty `permissionDecisionReason`. This is the only control effect besides rewriting.
  - `allow` **without** `updatedInput` is rejected ("unsupported permissionDecision:allow").
  - `allow` **with** `updatedInput` rewrites the call.
  - `ask` and legacy `decision:"approve"` are rejected.
  - Legacy `decision:"block"` with a `reason` blocks.
  - Exit 2 with stderr blocks. Exit 2 with empty stderr counts as Failed.
  - `additionalContext` is accepted.
  - **So Codex PreToolUse is deny-only.**
- **PermissionRequest output schema:**
  ```json
  { "hookSpecificOutput": { "hookEventName": "PermissionRequest",
      "decision": { "behavior": "allow|deny", "message": "…" } } }
  ```
  - Setting `updatedInput`, `updatedPermissions` or `interrupt:true` **fails closed**: the hook's output is ignored and marked Failed.
  - Exit 2 with stderr is a deny.
  - Across multiple hooks, **any deny wins**, otherwise the last allow wins, otherwise there is no verdict and the normal flow runs.
  - An allow from an "Environment" source is ignored ("may restrict … never grant").
- **When PermissionRequest fires.** Only when Codex would ask for approval: shell escalation, managed network, MCP approval, apply_patch outside the sandbox and similar. It does not fire for commands the sandbox or policy already allows.
- **UserPromptSubmit.** Plain stdout becomes developer context. Also accepts `hookSpecificOutput.additionalContext`, and `decision:"block"` + `reason` or exit 2 to block.
- **Stop.** Output must be JSON on exit 0; plain text is invalid. `decision:"block"` + `reason` makes Codex **continue**, using `reason` as a new continuation prompt. There is no non-blocking context channel: `systemMessage` is a user-visible warning only.
- **Errors.** A non-zero exit other than 2, a timeout or invalid JSON marks the hook Failed and the flow continues, so **fail-open is the default**. Empty stdout with exit 0 means no-op.

### Interaction with the guardian / auto-review [src core/src/tools/approvals.rs, config.schema.json]
- **Config:** `approvals_reviewer = "user" | "auto_review"` (legacy alias `guardian_subagent`). Feature `guardian_approval` is stable and on.
- **Order inside `request_approval_with_user_prompt`:**
  1. Policy checks run first.
  2. **`run_permission_request_hooks`** runs next.
  3. On the result:
     - `Allow`, when the call doesn't require human approval → **Approved, source=Hook**. The guardian is skipped.
     - `Deny{message}` → denied. "Hook denials always win."
     - `None`, or `Allow` on a managed checkpoint that requires a human → `request_reviewer_approval`, which goes to the guardian (auto_review) or the user prompt.
  4. Managed requirements are re-checked even after a hook approval.

  Comment in the source: "Managed checkpoints require a person even when a hook allows the action or the session uses automatic review."
- So, unlike Claude auto mode, **a Codex PermissionRequest `allow` does pre-empt the automatic reviewer**. Abstaining (no output) defers to the guardian.

### Codex plugin layout [src core-plugins, utils/plugins; doc learn.chatgpt.com plugins/build; local cache]

**Manifest lookup order** (`DISCOVERABLE_PLUGIN_MANIFEST_PATHS`):
1. `plugin.json` at the plugin root, in the Agent Plugins v1 format. `.codex-plugin/plugin.json` is used as an overlay, unless `extensions.com.openai` is present.
2. `.codex-plugin/plugin.json`
3. `.claude-plugin/plugin.json`
4. `.cursor-plugin/plugin.json`

**Manifest fields:**
- `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`
- `skills`, `mcpServers`, `apps` (`.app.json`)
- `hooks`: a path, a path array, an inline object, or an inline array. If set, it **replaces** the default `hooks/hooks.json`.
- `interface`: `displayName`, `shortDescription`, `longDescription`, `developerName`, `category`, `capabilities`, `defaultPrompt` (≤3), `brandColor`, `composerIcon`, `logo`, `screenshots`, …

**Hook environment:** `PLUGIN_ROOT`, `PLUGIN_DATA`, plus `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` "for OOTB compat".

**Cache:** `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`. Local plugins use version `local`.

Example `.codex-plugin/plugin.json`:
```json
{
  "name": "local-decider",
  "version": "0.1.0",
  "description": "Local decision-model permission hooks (fail-open).",
  "author": { "name": "SkeLLLa" },
  "license": "MIT",
  "hooks": "./hooks/codex-hooks.json",
  "interface": { "displayName": "Local Decider", "shortDescription": "Local decision model approvals",
                 "developerName": "SkeLLLa", "category": "Productivity", "capabilities": [] }
}
```
Per-project enablement: `config.toml` `[plugins."local-decider@local-decider"] enabled = true` [doc].

**Caveat [doc]:** "Hooks apply only to plugins installed manually in the Codex desktop app. Plugins with hooks aren't eligible for the public directory." **UNVERIFIED** whether the CLI loads hooks from marketplace-installed plugins. Source discovery (`append_plugin_hook_sources`) has no desktop-only gate, so it probably does, after `/hooks` trust. Test this end to end.

### Codex marketplace [src marketplace.rs; cli; doc]

**Lookup order** within a marketplace root:
1. `.agents/plugins/marketplace.json`
2. `.agents/plugins/api_marketplace.json`
3. `.claude-plugin/marketplace.json`
4. `.cursor-plugin/marketplace.json`

The personal marketplace is `~/.agents/plugins/marketplace.json`.

Raw schema: top level `{ name, interface?: { displayName }, plugins: [...] }`. Each plugin entry has:
- `name`
- `source`: a string path, or one of:
  - `{source:"local", path}`
  - `{source:"url", url, path?, ref?, sha?}`
  - `{source:"git-subdir", url, path, ref?, sha?}`
  - `{source:"npm", package, version?, registry?}`
- `policy?`: `{ installation: AVAILABLE|INSTALLED_BY_DEFAULT|NOT_AVAILABLE, authentication: ON_INSTALL|ON_USE, products? }`
- `category?`
- other fields, flattened into a fallback manifest

The docs call `policy` and `category` required, but the code defaults them. Paths must start with `./` and stay inside the root.

```json
{ "name": "local-decider", "interface": { "displayName": "Local Decider" },
  "plugins": [ { "name": "local-decider",
                 "source": { "source": "local", "path": "./plugins/local-decider" },
                 "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
                 "category": "Productivity" } ] }
```
CLI [cli]:
```
codex plugin marketplace add ./                 # or owner/repo[@ref], https/ssh git URL; --ref, --sparse <PATH>
codex plugin marketplace list | upgrade [name] | remove <name>
codex plugin add local-decider@local-decider    # or: codex plugin add local-decider -m local-decider
codex plugin list | remove
# then in the TUI: /hooks → review & trust the plugin hooks
```

---

## 5. One repo for both: prior art and recommendation

| Repo | What it does | Relevance |
|---|---|---|
| tomyak/viz-dec | Has both `.agents/plugins/marketplace.json` (Codex, `source:{source:local}`, policy, category) **and** `.claude-plugin/marketplace.json`, pointing at one `plugins/visual-decider/` that holds both `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` (plus `interface`). Skills and MCP only, no hooks. | **The layout to copy.** |
| aaddrick/building-with-decision-models | Puts the plugin **at the repo root** (`source: "./"`), with manifests for every agent: root `plugin.json` (Agent Plugins schema), `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/` and others. Skill only. | Shows that manifests for several hosts can coexist. Avoid the root `plugin.json`: Codex reads it *first*, as the Agent Plugins format. |
| jakubc78/codex-policy-hooks | A Python dispatcher on Codex **PermissionRequest** (matcher `Bash`, `timeout: 5`). Validators return ALLOW/DENY/ABSTAIN. **ABSTAIN prints nothing.** Emits `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":…,"message":…}}}`. Installed by hand in `~/.codex/hooks.json`, not as a plugin. | Confirms the Codex allow, deny and abstain contract. |
| lukaszmalik/claude-automode | Uses Claude settings hooks, not a plugin. Its layers: deny rules, then a PreToolUse regex deny script, then a **PermissionRequest** LLM classifier (`claude -p --model sonnet`) returning `decision.behavior`. "PermissionRequest … is the only hook that can auto-approve." Bug: it uses `"timeout": 5000`, but the unit is seconds. | Same structure as ours; swap the classifier for `/v1/systemone`. It doesn't help in auto mode (see §3). |
| frankievalentine/claude-decision-router | A Claude **mod** plugin: `plugin/hooks/hooks.json` = `{"modules":["./router.ts"]}`, marketplace `source: "./plugin"`. Calls `http://127.0.0.1:8888/v1/systemone` (Unsloth) or `:9931` (llama.cpp) with `{model?, state:{currentRequest:{text}, recentDialogue}, questions:{name:{type:"score"|"choice"|"noul", instructions, criteria}}}`. Parses `answers[name].{choice,probabilities,score,noul}`. `userConfig` has `local_url`, `timeout_ms` (default 2500 hosted, 8000 local) and `min_confidence`. | Reference for the `/v1/systemone` request and answer shape, and for running inside a mod. |
| iksnerd/SystemOne | The `verdict` server, which answers TypeSafe Jev's `/v1/systemone` protocol plus `GET /v1/capabilities`. Its plugin (`plugins/verdict`) is a Claude skill with evals and no hooks. | A gateway backend candidate. |

### Recommended layout (monorepo)

```
local-decider/
├── .claude-plugin/marketplace.json        # Claude: {name, owner, plugins:[{name:"local-decider", source:"./plugins/local-decider"}]}
├── .agents/plugins/marketplace.json       # Codex (checked before .claude-plugin): source {source:"local", path:"./plugins/local-decider"}, policy, category
├── packages/
│   ├── gateway/                           # HTTP gateway: POST /v1/systemone (+ optional /hooks/claude/* native endpoints)
│   └── hook-client/                       # TS source of the hook adapter; bundled (esbuild/tsup) into the plugin dir
└── plugins/local-decider/                 # self-contained: installs copy ONLY this dir
    ├── .claude-plugin/plugin.json         # Claude manifest (+ userConfig)
    ├── .codex-plugin/plugin.json          # Codex manifest: "hooks": "./hooks/codex-hooks.json" (replaces default discovery)
    ├── hooks/hooks.json                   # Claude only (auto-loaded): PreToolUse, PermissionRequest, UserPromptSubmit, Stop
    │                                      #   (+ optional "modules": ["./register.js"] for auto-mode tool.check)
    ├── hooks/codex-hooks.json             # Codex only: PreToolUse (deny-only), PermissionRequest (allow/deny), UserPromptSubmit, Stop
    ├── hooks/register.js                  # optional Claude mod (tool.check → $.http.fetch gateway)
    └── dist/hook.mjs                      # committed single-file bundle, zero deps: `node dist/hook.mjs <claude|codex> <event>`
```

Why it works:
- **Manifest selection.** Codex picks `.codex-plugin/plugin.json` before `.claude-plugin/plugin.json`. Claude reads only `.claude-plugin/`.
- **Hooks files stay separate.**
  - Codex's explicit `hooks` field stops it loading `hooks/hooks.json`, so Claude-only semantics never reach Codex: PreToolUse `allow`, `ask`, mods, `PermissionDenied`.
  - Claude merges its manifest `hooks` with `hooks/hooks.json`, so don't point Claude's manifest at the Codex file.
- **Marketplace selection.** Codex picks `.agents/plugins/marketplace.json` first. Claude reads `.claude-plugin/marketplace.json`.
  - One file could serve both, since each host ignores the other's extra keys. But Claude `validate --strict` fails on `policy` and `category`, so keep two files.
- **The bundle must live inside `plugins/local-decider/`.** Paths can't escape the plugin root, and the cache copies only that directory.
- **Install:**
  - Claude: `claude plugin marketplace add SkeLLLa/local-decider && claude plugin install local-decider@local-decider`
  - Codex: `codex plugin marketplace add SkeLLLa/local-decider && codex plugin add local-decider@local-decider`, then `/hooks` to trust.

### Adapter decision mapping (what `dist/hook.mjs` returns)

| Host / event | allow | deny | abstain |
|---|---|---|---|
| Claude PreToolUse | `permissionDecision:"allow"` (skips prompt; **not** classifier in auto mode) | `permissionDecision:"deny"` + reason | print nothing |
| Claude PermissionRequest | `decision:{behavior:"allow"}` | `decision:{behavior:"deny",message}` | print nothing |
| Claude mod `tool.check` (auto mode) | `{decision:'allow'}` (skips classifier) | `{decision:'deny',reason}` | `return next(e)` result |
| Codex PreToolUse | **not possible** (abstain) | `permissionDecision:"deny"` + non-empty reason | print nothing |
| Codex PermissionRequest | `decision:{behavior:"allow"}` (skips guardian) | `decision:{behavior:"deny",message}` | print nothing → guardian/user |
| UserPromptSubmit (both) | n/a | `decision:"block"` + reason | context via `additionalContext` or nothing |
| Stop (both) | let stop: print nothing (Codex: `{}` JSON safest) | `decision:"block"` + reason → continues | print nothing |

For Codex Stop on exit 0, emit `{}` rather than plain text. Empty stdout is treated as a no-op in the source, which is safe.

---

## 6. claude-code-router custom router (brief) [src packages/core/src/gateway/claude-code-router-plugin.ts]

- **Config:** `"CUSTOM_ROUTER_PATH": "/abs/path/custom-router.js"` in `~/.claude-code-router/config.json`.
- **Loading:** the module is loaded with `require`. Its cache is cleared on each request.
- **Export:** the default export or a module function.
```js
// custom-router.js (CommonJS)
module.exports = async function router(req, config, { event }) {
  // req: the incoming Anthropic /v1/messages request (req.body.model, req.body.messages, req.body.system, req.body.tools, req.log)
  // config: the loaded CCR config; event: CCR event bus
  return "providerName,modelName";   // route selector string; return undefined/null to fall back to built-in Router rules
};
```
Any thrown error is logged, and routing falls back to the defaults. The `req.body` field names come from the README convention and are **UNVERIFIED** in the current source.

---

## Open questions / to verify by test
1. Does Codex CLI (not desktop) run hooks from a marketplace-installed plugin after `/hooks` trust?
2. Does Claude PermissionRequest fire in auto mode for classifier-routed calls? The docs don't say. Probably not, since there is no prompt.
3. What is the exact mods `$.http.fetch` signature, and does the built-in guard affect a user-installed `tool.check` mod on Pro/Max?
4. Do mise-managed `node` shims resolve inside hook processes for both hosts? If not, ship an `sh` wrapper that probes `command -v node` and exits 0 when absent.
