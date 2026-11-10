# Paseo plugin API research for `paseo-plugin-local-decider`

Researched 2026-11-10 against the installed Paseo CLI/daemon **0.15.3**. Sources, in order of
authority:

1. **`.d.ts` from `@getpaseo/plugin@0.15.3`, `@getpaseo/client@0.15.3`, `@getpaseo/protocol@0.15.3`**
   (downloaded with `npm pack`). The installed app (`/opt/Paseo`) ships no plugin `.d.ts`, so these
   are the real types for this host.
2. Deployed docs: `paseo.sh/docs/plugins{,/reference,/hooks,/publishing}.md`, `docs/sdk/reference.md`.
   **The deployed docs describe 0.16.0-beta.1**, which is newer than the host. Where they differ, this
   document says so and labels the newer feature `[0.16]`.
3. `getpaseo/paseo` `plugin-examples/` (lifecycle-actions, agent-configuration, agent-tools, settings).
4. Local inspection of `~/.paseo` and `paseo plugin init` output on 0.15.3.

Labels used here: `[verified]` means checked in the `.d.ts` or on disk. `[docs]` means the docs say
so but it was not checked in code. `[unverified]` means an assumption or a community convention.

---

## 1. Package layout, manifest, build, install

### Layout (from `paseo plugin init` on 0.15.3) [verified]

```text
paseo-plugin/                  # plugin root = directory containing paseo-plugin.json
  paseo-plugin.json            # required manifest
  OVERVIEW.md                  # listing page (registry); not needed to run
  package.json  tsconfig.json
  index.server.ts              # daemon subprocess entry (optional)
  index.client.tsx             # app entry (optional); at least one entry required
  server/   client/   shared/  # ALL other modules must live in these dirs
```

- No other code module may sit in the plugin root (compile error). `client/` must not import `server/`
  or `node:*`. `server/` must not import `client/`, React, or RN. `shared/` holds only Zod contracts and
  plain values. These rules also apply to type imports and transitive imports. [docs]
- A plugin without `index.server.ts` starts no subprocess. Hooks, RPC handlers, and `registerSettings`
  require the server entry. [docs]
- Each entry **default-exports a synchronous** `contribute(ctx)` function that returns a cleanup
  function (`PluginCleanup = () => void | Promise<void>`). jev-paseo notes that the loader rejects an
  async default export. [verified type; loader behavior unverified]

### `paseo-plugin.json` [verified via init plus docs]

```json
{
  "id": "local-decider",
  "name": "Local decider",
  "description": "Routes and decides via a local System One gateway",
  "requirements": { "paseo": ">=0.15.3 <0.17.0" }
}
```

| Field | Notes |
| --- | --- |
| `id` (required) | Default install ID. Must match `^[a-z][a-z0-9-]*$`. `--id` at install overrides it. |
| `name`, `icon` (PNG path), `media` (array) | Need Paseo >=0.11. `init` emits `"media": []` and a `$comment`. |
| `description` | Shown in Settings → Plugins. |
| `requirements.paseo` | npm semver range. **Omitting it means `<0.8.0`, and 0.8+ rejects the plugin.** Unknown keys under `requirements` are rejected. Prereleases satisfy a range when their stable core does (`0.16.0-beta.1` satisfies `>=0.16.0`). The daemon checks the range on install, update, startup, enable, and reload. **Each app checks it again before evaluating client code.** A plugin with no client entry does not depend on the app version. `init` writes `>=<cli version>`. |
| `build` | `[["npm","ci","--omit=dev"]]`: argv arrays run without a shell on install/update, mainly for Git sources. Omit it for npm and directory installs. |
| `translations` | Registry only. |

Unknown top-level fields are ignored.

### Build expectations [verified on disk]

- **No pre-build is needed. Ship the TypeScript source.** Paseo compiles and bundles each entry itself
  (esbuild ships in `/opt/Paseo/resources/app.asar.unpacked/node_modules/@esbuild`). Installed npm
  plugins such as `@stevecastaneda/paseo-progress` ship `index.server.ts`, `client/`, and the rest as
  raw `.ts`/`.tsx`.
- The `tsconfig` from `init`: `target ES2020`, `module ESNext`, `moduleResolution Bundler`,
  `lib ["ES2023"]` (no DOM), `jsx react-jsx`, `strict`, `noEmit`. Typechecking is the only local step
  (`tsc --noEmit`).
- `package.json` from `init`: `"private": true` and a `files` list of
  `paseo-plugin.json, OVERVIEW.md, OVERVIEW.*.md, index.client.ts(x), index.server.ts(x), client/, server/, shared/`.
  devDependencies: `@getpaseo/plugin 0.15.3`, `@tanstack/react-query ^5.90.11`, `@types/react ~19.2.0`,
  `react 19.1.0`, `react-native 0.81.5`, `typescript ^5.9.3`, `zod ^4.4.3`. `init` does not set `"type"`.
  The SDK package is ESM (`"type":"module"`).
- **Host-provided at runtime, so keep these in devDependencies:** `@getpaseo/plugin` (and its
  `/server`, `/server/provider`, `/server/acp`, `/server/usage`, `/client`, `/client/ui` subpaths),
  `zod`, `react`, `react/jsx-runtime`, `react-native`, `@tanstack/react-query`. Server code can import
  anything else installed in the plugin directory. Real runtime deps belong in `dependencies` and need
  an `npm-shrinkwrap.json` to be accepted by the registry. **Recommendation: use zero runtime deps.
  Node's global `fetch` and `AbortSignal.timeout` are enough for an HTTP client.**
- Types from `@getpaseo/protocol/agent-types` (`AgentPermissionRequest`, `AgentTimelineItem`, and so
  on) need `@getpaseo/protocol@0.15.3` and `@getpaseo/client@0.15.3` as devDependencies. They are peer
  deps of `@getpaseo/plugin` and are not pulled in by `init`.
- pnpm caveat [unverified]: in a directory install, the daemon resolves imports from the plugin dir.
  pnpm symlinked `node_modules` should be fine for type-only deps. Runtime deps behind symlinks have not
  been tested.

### Install / manage (CLI 0.15.3 `paseo plugin --help`) [verified]

```fish
paseo plugin init /abs/path                      # scaffold; does not run npm
paseo plugin install /abs/path/packages/paseo-plugin   # directory source (alias: add)
paseo plugin install npm:paseo-plugin-local-decider@0.1.0
paseo plugin install 'npm:@scope/pkg@>=0.1.0 <0.2.0' --id local-decider-staging
paseo plugin install npm:@scope/mono@1.0.0:packages/paseo-plugin    # subdir suffix
paseo plugin ls [id] [--json]                    # status must be "running"
paseo plugin reload local-decider                # needed after every source edit (directory installs)
paseo plugin logs local-decider [--json]
paseo plugin disable|enable local-decider
paseo plugin update local-decider [--version 0.2.0] [--check] [--yes]   # skips directory installs
paseo plugin remove local-decider
# global flags: --host <endpoint>, --home <path> (default ~/.paseo)
```

- Global switch: root `pluginsEnabled` in `~/.paseo/config.json`. It is `true` on this host. Apply
  changes with `paseo reload --json`.
- Installed config lives in `~/.paseo/config.json` → `plugins.<id> = { source: "directory", path, enabled }`.
  npm and registry sources become a directory entry that points into a managed dir. [verified]
- **Managed (npm/git/registry) installs** go to
  `~/.paseo/plugins/<id>/<uuid>/node_modules/<pkg>`, with a wrapper `package.json` and lockfile.
  Provenance is in `~/.paseo/plugins/sources.json`. [verified] **`remove` deletes those managed files.
  For a directory source, `remove` keeps your directory.** [docs]
- `remove` also deletes the installation's host settings, so a reinstall starts from defaults, and it
  clears the log tail. [docs]
- Do not restart the daemon to pick up source changes. Use `plugin reload`. A failed reload stays
  failed and does not roll back.

---

## 2. Settings

### Shared definition (0.15.3 `settings.d.ts`) [verified]

```ts
export interface SettingsDefinition<Schema extends ZodType = ZodType> {
  id: string;            // [a-z][a-z0-9_-]*, unique within the installation
  scope: "host";         // 0.15.3: ONLY "host". [0.16] adds "device".
  version: number;       // positive int, schema version (not the write revision)
  schema: Schema;        // must parse `{}` into a complete doc, so give every field a .default()
  migrate?: (values: unknown, fromVersion: number) => unknown | Promise<unknown>;
}
export declare function defineSettings<S extends ZodType>(d: SettingsDefinition<S>): SettingsDefinition<S>;
```

```ts
// shared/settings.ts
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
export const deciderSettings = defineSettings({
  id: "decider", scope: "host", version: 1,
  schema: z.object({
    gatewayUrl: z.string().url().default("http://127.0.0.1:8787"),
    timeoutMs: z.number().int().min(100).max(25_000).default(5_000),
    autoPermissions: z.enum(["off", "shadow", "on"]).default("off"),
  }),
});
```

### Server handle (`server/contracts.d.ts`) [verified]

```ts
registerSettings<S extends ZodType>(def: SettingsDefinition<S>): PluginSettings<S>;
interface PluginSettings<S> {
  read(): Promise<PluginSettingsState<S>>;
  subscribe(listener: (s: PluginSettingsState<S>) => void | Promise<void>): PluginCleanup;
}
type PluginSettingsState<S> =
  | { status: "ready"; revision: string; values: z.output<S> }
  | { status: "invalid"; revision: string; error: string };
```

`subscribe` fires after each successful save, reset, or migration. It does not fire for invalid writes
or conflicts. Call `registerSettings` inside `contribute` before returning. If the doc is missing,
`read()` returns the schema defaults. Invalid stored data comes back as `invalid` and is never reset
silently. Values survive restart, reload, disable, and update. [docs] Stored on disk under
`~/.paseo/plugin-settings/<plugin-id>/…json` [observed: `plugin-settings/paseo-cafe/directory-settings.json`].

### Client

```ts
useSettings<S>(def): SettingsState<S>   // from "@getpaseo/plugin/client"
type SettingsState<S> = ({status:"loading"} | {status:"error";error:string}
  | {status:"invalid";error:string;revision:string}
  | {status:"ready";values:z.output<S>;revision:string})
  & { saving: boolean; saveError: string|null;
      save(values, revision): Promise<boolean>;  // never throws; false on validation/conflict/transport
      reset(): Promise<boolean>; reload(): Promise<void>; };
client.addSettingsScreen({ id, title, icon, Component }): PluginCleanup  // Component: ComponentType<PluginSurfaceProps>
```

The first screen opens from the cog on the plugin's row in Settings → Plugins. Several screens become
tabs. `openSettings(id)` is available on the client context and in every command callback.

**Field components** (`@getpaseo/plugin/client/ui`) [verified]. There are no declarative fields; you
compose rows yourself:

| Component | Props |
| --- | --- |
| `SettingsSection` | `title`, `children`, `info?`, `trailing?`, `testID?` |
| `SettingsCard` | `children`, `testID?` |
| `SettingsRow` (base) | `label`, `hint?`, `error?: string\|null`, `children?`, `testID?` |
| `SettingsSwitch` (**toggle**) | Row props plus `value: boolean`, `onValueChange(v)`, `disabled?` |
| `SettingsSelect<V extends string>` (**select**) | Row props plus `value: V`, `options: readonly {label, value: V}[]`, `onValueChange(v)`, `disabled?` |
| `SettingsInput` (**text**) | Row props plus `onChangeText(t)`, `initialValue?`, `placeholder?`, `disabled?`, `secureTextEntry?`, `ref?: Ref<{focus,blur,getText,replaceText}>` |
| `SettingsAction` (button) | Row props plus `actionLabel`, `onPress()`, `disabled?` |

There is **no number input**. Use `SettingsInput` and parse with `z.coerce.number()` or `Number()`
before calling `save`. `SettingsInput` owns its draft text, so `initialValue` only seeds it. Pattern
from the official `settings` example: immediate toggle or select →
`settings.save({ ...settings.values, key: v }, settings.revision)`. For a text draft, capture
`{values, revision}` when editing starts and save against that revision so another client's edit
produces a conflict.

**Secrets:** docs: "These documents are ordinary host-side JSON, not a credential vault." Every
authorized client can read host settings through `useSettings`, and `daemon.manage` gates settings
RPCs. `secureTextEntry` only masks the input. Do not log secrets: the log tail is readable by connected
users and is persisted in `daemon.log`. Prior art (auto-mode-for-paseo) keeps API keys out of Paseo
settings. It stores them in its own 0600 JSON file through a custom RPC and returns only
`hasApiKey: boolean` to the client. A loopback gateway URL needs no secret. If a gateway token is added
later, read it from the daemon env or a 0600 file on the server and never return it over RPC.

---

## 3. `providers.listModels()` [verified, client `index.d.ts` plus protocol]

```ts
paseo.providers.listModels(provider: string, options?: { cwd?: string; requestId?: string })
  : Promise<{ provider: string; models?: AgentModelDefinition[]; error?: string | null;
              fetchedAt: string; requestId: string }>
interface AgentModelDefinition {
  provider: string; id: string; aliases?: string[]; isSelectable?: boolean; label: string;
  description?: string; isDefault?: boolean; metadata?: Record<string, unknown>;
  contextWindowMaxTokens?: number;
  thinkingOptions?: { id: string; label: string; description?: string; isDefault?: boolean }[];
  defaultThinkingOptionId?: string;
}
```

Related calls: `listModes(provider, opts)` → `{ provider, modes?: AgentMode[] /*{id,label,description?,icon?,colorTier?}*/, error?, fetchedAt, requestId }`.
`listAvailable()` → `{ providers: [{ provider, available, error? … }], error? }`. `snapshot()` and
`waitForReady({ cwd?, timeoutMs? = 60s })` return the catalog with
`entries: ProviderSnapshotEntry[]` (`{provider,status:"ready"|"loading"|"error"|"unavailable",enabled,models?,…}`).
`refresh({providers?})` only acknowledges the request, and discovery continues in the background
(auto-mode notes this). Filter out `isSelectable === false`. jev and auto-mode build ids as
`` `${provider}/${model.id}` ``, which is the form `agents.create({config:{provider:"codex/gpt-5.5"}})` expects.

---

## 4. Sidebar footer, Command Center, slash commands [verified `client/contracts.d.ts`]

```ts
client.addScreen({ id, title: PluginText | ((params) => PluginText), Component: ComponentType<PluginScreenProps> }): PluginCleanup
client.addSidebarFooterItem({ id, title, Component: ComponentType<PluginSidebarItemProps> }): PluginCleanup
// also addSidebarHeaderItem (same shape)
interface PluginSidebarItemProps extends PluginHostProps {   // theme, host{id,label}, layout{compact,platform}
  currentScreen: { screenId: string; params: Record<string,string> } | null;
  openScreen(input: { screenId: string; params?: Record<string,string> }): void;
  openPopover(Content: ComponentType<PluginPopoverProps /* + close(), openScreen() */>): void;
}
```

The footer row sits between "Add project" and the fixed icon row. Render
`<SidebarRow icon="Scale" onPress={…} active? label? trailing? id? />`, with `SidebarSeparator` from
`/client/ui` between groups. A component that throws renders nothing. Items can be added or removed at
runtime with the returned remover.

```ts
client.addCommandCenterItem({
  id, title, icon, keywords?: readonly string[],
  context: "global" | "workspace" | "agent",
  onSelect(ctx): void | Promise<void>,
})
// ctx (all): context, paseo: PaseoApi, rpc(contract, input), openScreen(input), openSettings(id)
// workspace/agent ctx add: workspace: PluginWorkspaceSnapshot, openPanel(id, {location?})
// agent ctx adds: agent: PluginAgentSnapshot {id, workspaceId, provider, status, model, currentModeId,
//   thinkingOptionId, labels, cwd, title, requiresAttention, attentionReason, parentAgentId, ...}

client.addSlashCommand({
  name: "decide",                 // without slash
  description: "Ask the local decider", argumentHint: "<question>",
  context: "agent",               // or "workspace" (drafts too)
  async onSubmit({ args, agent, workspace, rpc, paseo, openPanel, openScreen, openSettings }) {
    await rpc(decideRpc, { agentId: agent.id, question: args });
  },
}): PluginCleanup
```

- `args` is the trimmed text after `/decide`. The text is never sent to the agent. Paseo owns
  autocomplete, input clearing, and the error toast on rejection. It does not show a pending state.
- Precedence is built-in, then plugin (first in catalog order), then provider. Collisions are dropped.
  Commands do not run while the composer has attachments. There are no server-side slash commands.
- Icons are a Lucide name string, `{ svg }`, or a component.
- 0.15.3 also has `addComposerPill`, `addHeaderButton`, `addWorkspacePanel`, `addAgentPanel`, and
  `addFilePanel`. **`addComposerItem`/`useComposer`, `addNewWorkspaceItem`, `addSidebarView`, and
  `client.subscribe`/`defineSubscription` are `[0.16]` only.**

---

## 5. Hooks [verified `server/lifecycle.d.ts` 0.15.3]

```ts
server.addHook<Name>(name, handler: (payload, ctx: { paseo: PaseoApi; signal: AbortSignal }) => Promise<Result>): () => void
// legacy, deprecated until 2027-04-30: server.on("agent.turn_ended", …), server.before("agent.create", …)
```

**Handlers must be async** (the type requires a Promise). Unknown names fail registration. The input
is a **detached snapshot**: return a replacement object instead of relying on mutation. Ordering is
plugin-ID order, then registration order within a plugin. Delivery is live and best effort, with no
replay or retry, and different events may overlap.

**Timeouts:** every invocation has a 30 s limit and aborts `ctx.signal`. For waiting hooks, a throw,
an invalid return, or a timeout fails the operation with `Plugin <id> <hook> failed: …`. For
notification hooks the error is only logged. Pass `ctx.signal` to `fetch`.

| Hook | Waits | Payload (0.15.3) | Return |
| --- | --- | --- | --- |
| `agent.create.before` | yes | `{ request: { config: AgentSessionConfig; env?: Record<string,string> } }` | same shape or `undefined` |
| `agent.open.before` | yes | `{ request: PluginSessionOpenRequest }` | same shape or `undefined` |
| `agent.turn.before` | no | `{ agent: PluginHookAgent; turnId: string\|null }` | void |
| `agent.turn.after` | no | `{ agent; turnId; outcome: PluginTurnOutcome; timeline /*deprecated, always []*/ }` | void |
| `agent.permission.before` | no | `{ agent; request: AgentPermissionRequest }` | void |
| `agent.permission.after` | no | `{ agent; requestId: string; resolution: AgentPermissionResponse }` | void |
| `agent.create.after`/`close.after` | no | `{ agent }` | void |
| `agent.archive.after` | no | `{ agent; archivedAt }` | void |
| `workspace.create.before` / `worktree.create.before` / `worktree.create.after` | yes | request / `{worktree:{path,branch,sourceCheckout}}` | … |

```ts
interface PluginHookAgent { id; workspaceId: string|null; parentAgentId: string|null; provider: string; cwd: string; title: string|null }
type PluginTurnOutcome = {kind:"completed"} | {kind:"failed"; error:{message; code?}} | {kind:"canceled"; reason}
interface AgentSessionConfig {          // @getpaseo/protocol/agent-types
  provider: string; cwd: string;        // cwd immutable in create.before
  systemPrompt?; modeId?; model?; thinkingOptionId?; featureValues?: Record<string,unknown>;
  title?: string|null; providerOptions?: Record<string,unknown>;
  toolPolicy?: { preapproved: {kind:"mcp";server;tool}[] };
  mcpServers?: Record<string, McpServerConfig>; internal?: boolean;
}
interface PluginSessionOpenRequest {
  agentId; workspaceId: string|null; provider; cwd;
  reason: "create"|"resume"|"refresh"|"import"; purpose: "interactive"|"history";
  readonly title: string|null; readonly labels: Readonly<Record<string,string>>;
  tools: AgentToolDefinition[]; env: Record<string,string>;
  mcpServers: Record<string, McpServerConfig>;   // starts EMPTY per plugin
}
type McpServerConfig = {type:"stdio";command;args?;env?;alwaysLoad?} | {type:"http";url;headers?;alwaysLoad?} | {type:"sse";url;headers?;alwaysLoad?}
interface AgentPermissionRequest { id; provider; name; kind: "tool"|"plan"|"question"|"mode"|"other";
  title?; description?; input?: Record<string,unknown>; detail?: ToolCallDetail;
  suggestions?; actions?: {id;label;behavior:"allow"|"deny";variant?;intent?}[]; metadata? }
type AgentPermissionResponse =
  | { behavior: "allow"; selectedActionId?; updatedInput?; updatedPermissions? }
  | { behavior: "deny"; selectedActionId?; message?: string; interrupt?: boolean }
```

**`agent.create.before`** (once per agent; changes are saved and persist after the plugin is removed).
You can change `provider`, `model` (a separate field from provider in this hook), `modeId`,
`thinkingOptionId`, `providerOptions`, `systemPrompt`, `title`, `mcpServers`, `toolPolicy`, and
`featureValues`. You **cannot** change `cwd`. Switching provider usually means also setting
model/mode and clearing `providerOptions`, as the official example does:

```ts
server.addHook("agent.create.before", async ({ request }) => {
  if (request.config.provider === "codex") {
    return { ...request, config: { ...request.config, provider: "claude", model: "haiku",
      modeId: "default", providerOptions: undefined } };
  }
  return request;
});
```

`env` applies only to the first launch and is not saved. **Metadata:** `request.metadata`,
`PluginHookAgent.metadata`, and `agent.setMetadata()` are **`[0.16]` only and absent in 0.15.3**. On
0.15.3, labels are set at `agents.create({labels})` and read in `agent.open.before`
(`request.labels`) or from `PluginAgentSnapshot.labels`. Labels cannot be set from `create.before`.
**Do not await network I/O near the 30 s limit:** a slow gateway fails agent creation. Use a short
`AbortSignal.any([ctx.signal, AbortSignal.timeout(n)])` and **fail open** (return `undefined`) on error.

**`agent.open.before`** runs on every provider launch (create, resume after restart, refresh, import,
history read). Only `env`, `tools`, and `mcpServers` can change, and only for this launch. Everything
else is read-only. **MCP injection:**

```ts
server.addHook("agent.open.before", async ({ request }) => {
  if (request.purpose === "history") return;            // ignored for history anyway
  return { ...request, mcpServers: { ...request.mcpServers,
    "local-decider": { type: "http", url: "http://127.0.0.1:8787/mcp" } } };
});
```

A name that collides with a saved server, the built-in `paseo` server, or another plugin's server
fails the open. A provider without MCP support fails with `does not support MCP servers`.
Starting, stopping, or reloading a plugin that declares `agent.open.before` marks open sessions stale,
and each one reopens before its next idle prompt. `await paseo.agents.ref(id).reload()` applies the
change now and interrupts a running turn. **Inside `open.before`, never await a write to the same
agent** (mode/model/option/label changes). That write waits for the open, so it deadlocks until the
timeout. Fire it with `void …catch()`.
Agent tools: `defineAgentTool({ name /*^[a-z][a-z0-9_]*$ ≤64*/, title?, description, input: zod, execute(input, {agent, paseo, signal}) })`
→ push into `request.tools`. The execute limit is 10 min.

**`agent.permission.before`** is a notification: Paseo does not wait, and the request stays pending
until someone answers. Answer through the SDK (see §6). This races with the user, so expect "already
resolved" failures. A permission request does not end the turn.

**`agent.turn.after`** fires on completion, failure, and cancellation. `timeline` is always `[]`. Fetch
history with `timeline.refetch`. History replay does not fire turn hooks (docs). jev's de-dupe comment
says it can, which applied to older versions [unverified].

Hooks exclude daemon-private helper agents. Background agents do fire hooks. Agents your plugin creates
also fire your hooks, so guard against loops (jev skips `config.title === "jev judge"` and agents with
`workspaceId === null`).

---

## 6. Timeline, permissions, follow-ups [verified `@getpaseo/client` 0.15.3]

```ts
const agent = paseo.agents.ref(agentId);              // PaseoAgentHandle; fields null until a snapshot
agent.timeline.refetch(opts?: { direction?: "tail"|"before"|"after"; cursor?: {…}; limit?: number;
  projection?: "projected"|"canonical"; requestId? }): Promise<FetchAgentTimelinePayload>
// payload: { agentId, agent: snapshot|null, direction, projection, epoch, reset, staleCursor, gap,
//   window, startCursor, endCursor, hasOlder, hasNewer,
//   entries: { provider; item: AgentTimelineItem; turnId?; timestamp: string; seqStart; seqEnd; … }[],
//   error: string|null }
agent.timeline.append(item: { type: "plugin"; id: string; kind: string; version: number; data: JsonValue })
  : Promise<{ seq: number; epoch: string }>
agent.respondToPermission({ requestId: string, response: AgentPermissionResponse }): Promise<void>
agent.send(text, { activeTurnBehavior?: "interrupt"|"steer" /*default interrupt*/, images?, attachments?, messageId?, sessionMode? }): Promise<void>
agent.run(text, { timeoutMs? /*10 min*/ }) / waitForFinish(ms?) / reload() / refresh() / commands()
agent.pendingPermissions  // after refresh(): AgentPermissionRequest[] | null
```

`AgentTimelineItem` is one of `user_message{text}`, `assistant_message{text,messageId?}`,
`reasoning{text}`, `tool_call`, `todo`, `error{message}`, `notification{level,message}`, compaction,
or `plugin{id,pluginId,kind,version,data}`. Assistant text can arrive in chunks with the same
`messageId`. Official helper:

```ts
export function latestOutputText(timeline: readonly AgentTimelineItem[]): string {
  let output = "";
  for (const item of timeline) {
    if (item.type === "user_message") output = "";
    else if ("text" in item && typeof item.text === "string") output += item.text;
    else output += JSON.stringify(item) + "\n";
  }
  return output;
}
// usage: (await agent.timeline.refetch({ direction: "tail", limit: 20 })).entries.map(({ item }) => item)
export function shellCommand(r: AgentPermissionRequest): string | null {
  if (!r.input) return null;
  if (typeof r.input.command === "string") return r.input.command;
  if (typeof r.input.cmd === "string") return r.input.cmd;
  return null;
}
```

**Decision rows.** In the server: `timeline.append({type:"plugin", id:\`decision-${requestId}\`, kind:"decision", version:1, data})`.
The daemon stamps `pluginId`. Re-appending the same `id` replaces the row live and on refetch, which
is how you update a row. `data` must be at most 64 KiB serialized or the call is rejected. Rows live in
the daemon's in-memory timeline: they survive refetch and reconnect but **not a daemon restart**. Calls
from non-plugin sessions are rejected. The host feature flag is `server_info.features.pluginTimelineItems`.
In the client, render the row:

```tsx
const DecisionData = z.object({ verdict: z.enum(["allow","deny","defer"]), reason: z.string(), confidence: z.number() });
function DecisionRow({ item, theme, layout, agentId, timestamp }: PluginTimelineItemProps<z.output<typeof DecisionData>>) {
  return <Text style={{ color: theme.colors.foregroundMuted }}>{item.data.verdict}: {item.data.reason}</Text>;
}
client.addTimelineRenderer({ kind: "decision", version: 1, schema: DecisionData, Component: DecisionRow });
```

If the renderer is missing, or `data` fails its schema, the row shows "Plugin timeline item
unavailable". Theme tokens: `surface0/1/2, border, foreground, foregroundMuted, accent,
accentForeground, statusSuccess, statusWarning, statusDanger`. Use React Native primitives only.

**Permission answer:**

```ts
await agent.respondToPermission({ requestId: event.request.id,
  response: { behavior: "deny", message: "Blocked by local decider." } });   // or { behavior: "allow" }
```

The docs table says only "Already-resolved request → SDK response fails". **The exact error text is
unverified.** Wrap the call in `try/catch` and treat any failure after a user answer as benign. Logging
the message on first occurrence would pin it down.

**Notify / follow-up.** 0.15.3 has **no server-side notify or attention API**. jev filed an issue
(`docs/paseo-plugin-notifications-request.md`). Options:
- Write a timeline row with `append` (visible in the agent chat).
- Send a follow-up with `agent.send(text)`. This starts a new turn and loops unless rate-limited.
- On the client only: `useToast().show(msg, {variant})` / `.error(msg)` inside components,
  `client.playAudio({base64,mimeType})`, and `addComposerPill` badges.
- Agent attention ("finished/permission") notifications come from Paseo itself.

---

## 7. Data dir, logging

- **Plugin data dir: there is no official API or convention.** `~/.paseo/plugin-data/` does not exist
  on this host. `<PASEO_HOME|~/.paseo>/plugin-data/<name>` is a community convention (jev-paseo, which
  credits `panrafal/paseo-plugins`) [unverified as official]. Whether the daemon passes `PASEO_HOME`
  to the plugin subprocess is unverified, so fall back to `~/.paseo`. jev's resolver:
  ```ts
  export function paseoHome(): string {
    const raw = process.env.PASEO_HOME;
    if (!raw) return join(homedir(), ".paseo");
    if (raw === "~") return homedir();
    if (raw.startsWith("~/") || raw.startsWith("~\\")) return resolve(homedir(), raw.slice(2));
    return raw;
  }
  ```
  **`plugin remove` will not delete this dir** (only managed installs and settings are deleted).
  Use atomic writes (temp file plus `rename`, mode 0o600) and cap file growth.
- **Logging:** `console.log` → stdout and `console.error` → stderr of the subprocess. Protocol traffic
  uses a separate channel, so logging cannot corrupt RPC. Paseo keeps 500 entries / 256 KiB per plugin
  in memory, with lines capped at 16 KiB, plus `[paseo]` lifecycle entries. The tail survives reload,
  disable, and crash. It is cleared on remove and on daemon restart. A structured copy goes to
  `$PASEO_HOME/daemon.log`. Read it with `paseo plugin logs <id> [--json]` (a snapshot, not a follow)
  or Settings → Plugins → Logs. Client-side logs stay in the app console. No logger object is provided.
  Never log secrets.

---

## 8. Testing

There are **no plugin test utilities** in `@getpaseo/plugin` (`createLifecycleRegistration` is
`@internal`). Official examples unit-test pure helpers with vitest (`lifecycle-actions/server/inspect.test.ts`).
jev uses vitest and auto-mode uses `node:test`. Recommended approach:
- Keep the gateway client, the request→decision mapping, and hook policies as pure functions.
- Test hook wiring with a hand-rolled fake `PluginServerContext` whose `addHook` captures handlers, plus
  a fake `paseo` (`agents.ref()` → `{ respondToPermission: vi.fn(), timeline: { append: vi.fn(), refetch } }`),
  then call the handlers directly.
- Run end-to-end on a real daemon: `paseo plugin install <dir>`, `plugin ls` → `running`,
  `plugin logs`. Use `paseo plugin install --id local-decider-dev` for a side-by-side copy.

---

## 9. Prior art

**auto-mode-for-paseo** (obetomuniz, v0.2.0, `requirements >=0.8.0`, SDK 0.8.0)
- Architecture: registers itself as a **provider** (`server.registerProvider`). The user picks "Auto",
  each message is classified (TypeSafe/Jev, local Python "Laya", or OpenAI), and it runs a native agent
  on the preset's provider/model/effort/mode through the SDK. Routing is a preset table
  (`{id,name,description,provider,model,effort,taskDepth,taskTypes,workMode,instructions,enabled}`,
  at most 32) chosen by task type and depth, plus a notice when no preset fits.
- Settings: its **own** JSON at `~/.paseo/auto-mode-for-paseo.local.json`. It does not use
  `defineSettings`. Writes are atomic and serialized, keys are kept server-side, the client gets
  `toPublic()` with `hasApiKey`, and a bespoke 30 KB settings screen autosaves through RPC. Model
  catalog: `listAvailable` → `refresh` → `waitForReady(20s)` → `listModels`/`listModes` per provider.
- Weaknesses: replacing a provider is heavyweight (45 KB `provider.ts`, its own Codex JSON-RPC
  process), and it breaks with Paseo internals. It captures `paseo` through a dummy
  `before("agent.session_open")` hack. It hand-rolls migrations in the loader. Windows-only scripts
  (`.cmd`/`.ps1`). Settings are not shared through Paseo's revisioned store. Hard-coded speculative
  model ids in its defaults.

**jev-paseo** (hypnguyen1209, v0.7.0, plugin id `jev`, `>=0.9.0-0`, SDK 0.9.2)
- Uses `defineSettings` (host, Zod with defaults and `.refine`) plus `server.registerSettings` with a
  `getConfig()` that falls back to defaults on any error. Env overrides (`JEV_HOOK_*`) for headless
  use. Data: `plugin-data/jev-tasks.json` (atomic, pruned to 200 resolved) and an append-only
  `jev-decisions.jsonl` decision log with a size-keyed cache, used for calibration and agreement stats.
  Presets are form prefills (verify/route/severity/guardrail/rerank/keep).
- Hooks: `on("agent.turn_ended")` parses `[jev] …` markers from assistant text and queues tasks. It
  includes circuit breakers (5 markers per turn, 10 auto-judges per hour, 20 pending) and de-dupe. An
  opt-in `before("agent.create")` appends instructions to `systemPrompt`. Decision cards come from a
  `addTimelineRenderer` of its own kind. UI: workspace panel, surface, sidebar item, Command Center
  entry, composer pills.
- Weaknesses: built on 0.9 APIs that are now deprecated (`server.on/before`, `addSurface`,
  `addSidebarItem`, `openSurface`, `context:"workspace"`). It reads `event.timeline`, which is now
  always empty, so **marker parsing is silently broken on 0.14+**. It mutates `input.request` in place.
  It swallows every error with no logging. Its "judge" spawns full Paseo agents, which is slow and
  costly. The model list casts the `waitForReady` snapshot to `unknown`. There is no notify path.

**Lessons for local-decider:** use `addHook` names and `requirements >=0.15.3`. Use `defineSettings` for
non-secret config. Use a short timeout and fail open on every waiting hook. Fetch text through
`timeline.refetch`. Return replacement requests. Log decisions to a JSONL file in the data dir with
redaction. Use `timeline.append` with a stable `id` for decision rows. Add rate limits on any
auto-follow-up. Use a thin HTTP client to `POST /v1/systemone` with no runtime deps.
