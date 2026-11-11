# Blueprint: engine registry + first-class macOS engines

## Context

The gateway has 3 engines (`strands-decider`, `fastflowlm`, `systemone-remote`). Each engine id is hard-coded as a string in about 12 places (audit: `docs/research/macos-engines.md` § Extensibility today). This makes adding an engine (LM Studio/mlx-lm, Laya) or a model expensive. It also leaves macOS a second-class platform:

- strands-decider's `--device auto` resolves cuda > mps > **cpu** and never picks MLX unless asked (`docs/research/engines.md` §1 CLI, [verified]). A Mac that ran `engine install` gets the `mlx` flavour (`engine-install.ts` `defaultFlavor`) and then serves on MPS.
- The Paseo settings show FLM and `mlx`/`mps` everywhere.
- The launchd plist has a minimal PATH.
- `bootout` followed by `bootstrap` races.

Goal:

1. One `EngineDescriptor` registry (`ENGINES`). Config schema, selection, state migration, `createEngine`, engine-control, CLI, settings routes, the Paseo UI and docs all derive from it.
2. MLX by default on darwin/arm64, plus an attach-only `openai-compatible` logprob engine (LM Studio, mlx-lm.server, llama-server, Ollama).
3. launchd fixes.
4. Plugin parity on macOS.

Constraints:

- Linux behaviour (FLM on the XDNA2 NPU, strands on CPU) is unchanged.
- Existing `config.yaml` files keep parsing.
- Every task below is one Conventional Commit that leaves `mise run check` green. Regenerate `schemas/config.schema.json` (`pnpm --filter local-decider schemas`) in every task that touches config.

Precondition: the uncommitted working-tree changes (log-filter, report-token, shadow, precedent …) land first. This blueprint is written against them.

---

## A. Engine registry

### Types (`packages/gateway/src/engines/descriptor.ts`)

```ts
import type { z } from 'zod';

export const DEVICES = ['auto', 'cpu', 'mlx', 'mps', 'cuda'] as const; // moved from config.ts, re-exported there
export type Device = (typeof DEVICES)[number];

export interface HostInfo {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly totalMemoryBytes: number;
}
export function hostInfo(): HostInfo; // engines/host.ts; injected in tests

export interface EngineContext {
  readonly paths: Paths;
  readonly tools: Toolchain;
  readonly host: HostInfo;
  readonly env: NodeJS.ProcessEnv;
}

export type Support = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** One catalogue entry, the same shape for every engine (replaces KnownModel). */
export interface ModelDescriptor {
  readonly id: string;              // fixed string; requests may only name catalogue/discovered ids
  readonly engine: string;          // descriptor id
  readonly label: string;
  readonly downloadGb: number | null;   // null: nothing to download (discovered models)
  readonly memoryGb: number | null;     // fp32/CPU or host memory
  readonly gpuMemoryGb?: number;        // bf16 on mlx/mps/cuda
  readonly latencyHint: string | null;
  readonly recommended?: boolean;
  readonly quality?: { readonly jevBench?: number; readonly brier?: number; readonly decisionIndex?: number };
  readonly source?: string;
  /** What the engine's download step fetches; engine-interpreted (strands: HF repos, adapter first). Was `hf`. */
  readonly artifacts?: readonly string[];
}

export interface EngineAvailability {
  readonly installed: boolean;
  readonly available: boolean;
  readonly detail: string | null;
}

export interface DownloadStep { readonly command: string; readonly args: readonly string[] } // fixed argv

export interface EngineValidation {
  readonly label: string;           // 'flm validate'
  readonly hint: string;            // 'Checks the NPU and driver; takes a few seconds.'
  readonly onStart: boolean;        // run once at bind() when installed
  run(ctx: EngineContext): Promise<Validation>;
}

export interface InstallOption { readonly type: 'string' | 'boolean'; readonly description: string }
export interface InstallContext {
  readonly paths: Paths; readonly host: HostInfo; readonly config: GatewayConfig; log(line: string): void;
}
export interface EngineInstaller {
  readonly usage: string;           // '[--flavor cpu|mlx|cuda] [--model ID] [--no-download]'
  readonly options: Readonly<Record<string, InstallOption>>; // fed to node:util parseArgs (strict)
  run(values: Readonly<Record<string, string | boolean | undefined>>, ctx: InstallContext): Promise<string>;
}

export interface EngineDescriptor<C extends { readonly type: string; readonly model: string }> {
  readonly id: C['type'];
  readonly label: string;           // 'Strands Decider'
  readonly description: string;     // one line, for the UI hint, the CLI `engine list` and docs
  /** z.strictObject({ type: z.literal(id), model, … }) with defaults; composed into config. */
  readonly configSchema: z.ZodType<C>;
  /** Selectable at runtime (settings page, POST /v1/engine, selection.engine). Remote: false. */
  readonly selectable: boolean;
  /** Config pins the engine (attach to engine.url): no runtime switching. Default: false. */
  pinned?(config: C): boolean;
  /** False with a reason hides it in the UI and refuses install (FLM: linux/x64 only). */
  supports(host: HostInfo): Support;
  /** A few characters for the sidebar: 'MLX', 'PyTorch', 'NPU', 'LLM'. */
  tag(config: C, host: HostInfo): string;
  /** Devices offered on this host; absent or [] = no device choice. */
  devices?(host: HostInfo): readonly Device[];
  /** False for engines whose probabilities are not trained for /v1/systemone (UI badge, docs). */
  readonly calibrated: boolean;
  readonly models: readonly ModelDescriptor[];
  /** Models the running server offers (openai-compatible: GET {url}/models). */
  discoverModels?(config: C, ctx: EngineContext, signal: AbortSignal): Promise<readonly ModelDescriptor[]>;
  create(config: C, ctx: EngineContext): Engine;
  availability(ctx: EngineContext, validation: Validation | undefined): EngineAvailability;
  /** Absent = every model is present (nothing to download). */
  modelsPresent?(models: readonly ModelDescriptor[], ctx: EngineContext): Promise<ReadonlyMap<string, boolean>>;
  /** Absent = no Download button. */
  downloadSteps?(model: ModelDescriptor, ctx: EngineContext): readonly DownloadStep[];
  readonly validation?: EngineValidation;
  /** Absent = `engine install --engine <id>` says there is nothing to install. */
  readonly install?: EngineInstaller;
}

export function defineEngine<C extends { type: string; model: string }>(d: EngineDescriptor<C>): EngineDescriptor<C>;
```

### Registry (`packages/gateway/src/engines/registry.ts`)

```ts
export const ENGINES = [strandsEngine, remoteEngine, fastflowlmEngine, openaiEngine] as const; // order keeps the JSON Schema stable
export type AnyEngine = (typeof ENGINES)[number];
export type EngineId = AnyEngine['id'];
export type EngineConfig = z.output<AnyEngine['configSchema']>;
export const engineSchema = z.discriminatedUnion('type', ENGINES.map((e) => e.configSchema) as Schemas<typeof ENGINES>);
export const SELECTABLE_IDS = ENGINES.filter((e) => e.selectable).map((e) => e.id); // for selection.engine z.enum
export function engineDescriptor(id: string): AnyEngine | undefined;
export function isSelectableEngine(id: unknown): id is EngineId;
export function engineDefaults(id: EngineId, model?: string, options?: object): EngineConfig; // configSchema.parse
export function allModels(engines = ENGINES): ModelDescriptor[];
export function createEngine(config: EngineConfig, ctx: EngineContext): Engine; // the one cast to EngineDescriptor<typeof config>
```

Cycle rule: engine files only `import type` from `config.ts`. Each engine's zod schema lives in its own engine file, and `config.ts` imports `engineSchema` and `SELECTABLE_IDS` from the registry.

Layout: one directory per managed engine, with `index.ts` exporting the descriptor. A simple engine is one file.

- `engines/strands/{index.ts, server.ts (from strands.ts), install.ts (from engine-install.ts), models.ts, mlx.ts}`
- `engines/fastflowlm/{index.ts, server.ts, install.ts (from flm-install.ts), status.ts (parseFlmList, summariseValidate, flm list/version cache), models.ts}`
- `engines/remote.ts`
- `engines/openai/{index.ts, logprob.ts}`
- Shared, unchanged: `supervised.ts`, `lazy.ts`, `http.ts`, `log-filter.ts`, `types.ts`

What derives from `ENGINES`:

| Place | Now |
|---|---|
| `config.ts` | `engine: engineSchema`, `selection.engine: z.enum(SELECTABLE_IDS)`, new optional `engines` map (task B5) |
| `engines/index.ts` `createEngine` | `registry.createEngine` |
| `state.ts` `selectionEdits` | `isSelectableEngine` |
| `models.ts` | generic helpers only (`catalogModel(id, engine?)`, `modelFits`, `modelMemoryGb`, `MEMORY_BUDGET`) over `allModels()` |
| `downloads.ts` | `descriptor.downloadSteps` |
| `catalog-status.ts` | generic per-engine TTL cache over `descriptor.modelsPresent` / `validation.run` |
| `engine-control.ts` | `parseSelection`, `#engines()`, `#initialSelection`, `#engineConfig`, `validate`, `bind` |
| `cli-engine.ts` (new, split from `cli.ts`) | `engine install/list/use`, USAGE lines |
| `server.ts` | `/health` adds `engineTag`; `/models` uses `allModels()` |
| `paseo-plugin/shared/engines.ts` | tag, capabilities and support come from the payload; `ENGINE_TAGS` and `FASTFLOWLM` are deleted |

Deliberate non-goal: tool paths (`toolchain.ts` `PATH_KEYS`/`DEFS`, `config.tools`) stay a static table. A `PathDef` only gains an `engine?: EngineId` field, so the Paths section hides the tools of unsupported engines. Adding an engine with a **managed binary** therefore also adds one `PathDef` plus one `tools.<key>` config key. Revisit when a third managed binary appears (open question 7).

### `GET /v1/engines` engine entry (additive; old fields kept)

```jsonc
{ "id", "label", "description", "tag", "supported": true, "unsupportedReason": null,
  "installed", "available", "detail", "devices": ["auto","mlx","mps","cpu"], "calibrated": true,
  "capabilities": { "download": true, "dynamicModels": false,
                    "validate": { "label": "flm validate", "hint": "…" } | null,
                    "install": "local-decider engine install --engine fastflowlm" | null },
  "validation": {…} | null }
```

Models gain `"discovered": false`.

### Tasks A

| # | Commit | Files | Tests |
|---|---|---|---|
| A1 | `refactor(gateway): engine descriptors and registry for config and createEngine` | new `engines/descriptor.ts`, `engines/host.ts`, `engines/registry.ts`. Strands, FLM and remote schemas move into their engine files with `defineEngine` descriptors (create, schema, selectable, pinned, supports, tag, devices = today's `DEVICES` for now). `config.ts` composes `engineSchema` and `selection.engine` from the registry and re-exports `DEVICES`, `Device` and the per-engine config types. `engines/index.ts` delegates. | new `test/registry.test.ts`: ids unique, `engineDefaults(id)` parses for every engine with a default model, `SELECTABLE_IDS` = `['strands-decider','fastflowlm']`. Existing `config.test.ts` and `schemas.test.ts` must pass with a **byte-identical** checked-in schema (proves backward compatibility). |
| A2 | `refactor(gateway): model catalogue lives with each engine` | `KnownModel` becomes `ModelDescriptor` (`hf` becomes `artifacts`, nullable numbers). STRANDS and D3 arrays go to `engines/*/models.ts`. `models.ts` keeps the helpers over `allModels()`. `CatalogEngine` becomes `EngineId`. Touches `server.ts` `/models` and the engine-control imports. | registry test: every model's `engine` matches its descriptor; ids unique per engine. Existing engine-control and server tests unchanged. |
| A3 | `refactor(gateway): downloads, presence and validation through descriptors` | `downloadSteps`, `modelsPresent` (HF cache for strands, `flm list` for FLM) and `validation` move into the descriptors. `CatalogStatus` becomes a generic `Map<EngineId, {at, value}>` TTL cache. `hfCached` goes to `engines/strands/index.ts`. `parseFlmList` and `summariseValidate` go to `engines/fastflowlm/status.ts`. | move the existing cases to `test/engines/strands.test.ts` and `test/engines/fastflowlm.test.ts`. A downloads test asserts `openai`-style descriptors without `downloadSteps` give a 400 `DownloadError`. |
| A4 | `refactor(gateway): engine control derives engines, selection and validation from the registry` | `EngineControlOptions.engines?` (default `ENGINES`) and `host?` (default `hostInfo()`). `#engines()` maps descriptors to the payload above. `#initialSelection` and `#engineConfig` use `descriptor.devices`. `validate(id)` uses `descriptor.validation`. `bind()` validates every installed engine whose validation has `onStart`. `switchable` = `descriptor.selectable && !pinned(config)`. To stay under the `cccc.toml` ceilings, payload building splits out to `engine-catalog.ts` (`describeEngine`, `describeModel`). `state.ts` uses `isSelectableEngine`. | `engine-control.test.ts`: inject a **fake descriptor** (`test/fakes/fake-engine.ts`) and assert it appears, switches, downloads and validates with no gateway change. This test is the proof that adding an engine takes one file plus one registry line. Assert the new payload fields. |
| A5 | `feat(cli): engine install/list/use from the registry; refuse unsupported hosts` | new `cli-engine.ts`: `parseInstallArgs(argv, engines, host)` (two-pass `parseArgs`: `--engine` first, then strict with the descriptor's options), `installUsage(engines)` generates the USAGE lines, `engine list` prints id, supported, installed and description, and `engine use <id> <model> [--device]` POSTs `/v1/engine`. The default `--engine` is the configured engine type. An unsupported host exits 2 **before any network**, for example `fastflowlm runs on Linux x86_64 with an AMD XDNA2 NPU; on macOS use strands-decider (MLX) or openai-compatible`. An engine without `install` exits 2 with `nothing to install for openai-compatible: start your server and set engines.openai-compatible.url`. `installFlm` keeps its own guard and adds an `x64` check. | new `test/cli-engine.test.ts`: parse matrix, darwin+FLM refusal, `--flavor` rejected for FLM, the usage text includes every installer. |
| A6 | `feat(paseo-plugin): engine tags, capabilities and support from the gateway` | `shared/engines.ts`: lenient parsing of `tag`, `description`, `supported`, `calibrated` and `capabilities`, with old-gateway fallbacks (tag → id, validate → `validation !== null`). `engineOptions` hides `supported:false` engines unless one is active. `engineTag` reads `/health` `engineTag`. `ENGINE_TAGS` is deleted. `client/settings-engines.tsx`: `FASTFLOWLM` is deleted, and `ValidationCard` renders for the **picked** engine when `capabilities.validate` is set, using its label and hint. An "uncalibrated" badge shows when `calibrated:false`. `server.ts` `/health` adds `engineTag`. | `paseo-plugin/test/engines.test.ts` (new fields, defaults, hiding), `test/server.test.ts` (`engineTag`). |
| A7 | `docs: engines page and ADR-0008 engine registry` | new `docs/engines.md` (spec below), `docs/adr/0008-engine-registry.md`, `docs/architecture.md` Engines section links to it, README link. | new `test/docs-engines.test.ts`: every `ENGINES` id appears in the `docs/engines.md` engine table (drift guard). |

### `docs/engines.md` outline

1. **Engines.** One table: id, label, platforms, devices, install command, calibrated, models source.
2. **How an engine plugs in.** The `EngineDescriptor` fields and what reads each one (config, `/v1/engines`, CLI, Paseo UI).
3. **Adding an engine.**
   - Create `engines/<id>.ts` (or `engines/<id>/index.ts`) exporting `defineEngine({...})`. The `configSchema` must be a `z.strictObject` with `type: z.literal('<id>')` and defaults for everything but `model`.
   - Add one line to `ENGINES` in `registry.ts`.
   - Run `pnpm --filter local-decider schemas`.
   - Add a row to the table here.
   - Copy `test/fakes/fake-engine.ts` as the test template.
   - Rules: argv only from validated config, never from requests. Bind to 127.0.0.1. Fail open. Runtime data goes under `~/.local/share/local-decider/`. A managed binary also needs a `PathDef` and a `tools.<key>` config key.
4. **Adding a model.** Append a `ModelDescriptor` to `engines/<id>/models.ts`. Required fields, memory fields (`memoryGb` fp32/host, `gpuMemoryGb` bf16), `artifacts` semantics per engine, and where `latencyHint` figures should come from (measured, with the machine named).
5. **macOS / Linux defaults** (from B).
6. **openai-compatible: prompt mapping and accuracy caveats** (from B4).

---

## B. macOS engines

### Platform defaults (no host-dependent schema defaults)

The schema defaults stay static, so the checked-in JSON Schema does not depend on the machine that generates it:

- `engine.type` = `strands-decider`
- `device` = `auto`

Host awareness lives in the descriptors:

- **strands `devices(host)`:**
  - darwin/arm64: `auto, mlx, mps, cpu`
  - linux: `auto, cpu, cuda`
  - otherwise: `auto, cpu`
- **strands `auto` resolution** (`engines/strands/mlx.ts` `resolveDevice(device, host, venv)`): on darwin/arm64, when the venv has MLX (`<venv>/lib/python3.*/site-packages/mlx_lm` exists), `auto` becomes `--device mlx`. Otherwise `--device` is still omitted, so strands picks cuda > mps > cpu as today. This also works for installs made before the change, with no marker file. On Linux nothing changes.
- **strands `tag`:** `MLX` when the resolved device is mlx, `MPS` for mps, otherwise `PyTorch`.
- **First run:**
  - macOS: `engine install` (mlx flavour, already the default) then `gateway start` serves the 2B model on MLX.
  - Linux: unchanged.
  - FLM stays opt-in via `engine install --engine fastflowlm`.
  - No automatic engine switching.

### openai-compatible engine

Config (`engines/openai/index.ts`):

```ts
z.strictObject({
  type: z.literal('openai-compatible'),
  url: z.url().default('http://127.0.0.1:1234/v1'),     // LM Studio; Ollama :11434/v1, llama-server :8080/v1, mlx_lm.server :8080/v1
  model: z.string().min(1).max(300).regex(/^[^-\s][^\s]*$/),  // server model id; no leading '-' (argv-safe for lms)
  api: z.enum(['chat', 'completions']).default('chat'),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(), // only sent over https/loopback (tokenAllowed)
  topLogprobs: z.number().int().min(2).max(20).default(20),   // Ollama caps at 20
  maxOptions: z.number().int().min(2).max(20).default(10),     // more options → question unanswered
  minCoverage: z.number().min(0).max(1).default(0.5),
  temperature: z.number().min(0.1).max(10).default(1),         // calibration: p ∝ m^(1/T)
  maxStateChars: z.number().int().min(1000).max(400_000).default(24_000),
  extraBody: z.record(z.string(), z.json()).default({}),       // e.g. {chat_template_kwargs:{enable_thinking:false}}
  requestTimeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
  manage: z.enum(['none', 'lms']).default('none'),             // B6
})
```

Descriptor:

- `selectable: true`, `calibrated: false`, `tag: 'LLM'`, `supports`: any host, no `install`, no `downloadSteps`.
- `models: []`. `discoverModels` = `GET {url}/models`, with a 15 s cache and `downloadGb: null`, `memoryGb: null`, `discovered: true`.
- `availability`: `available` = server reachable. Otherwise `detail` = `no server at <url>; start LM Studio (lms server start), ollama serve, llama-server or mlx_lm.server`.

Engine `OpenAICompatibleEngine implements Engine`:

- **`start()`:** `GET {url}/models`, then one probe call (`max_tokens:1`, `logprobs`). It fails with a clear `detail` when the server returns no `top_logprobs` (`server returned no logprobs; LM Studio: try api: completions, or use llama-server/Ollama/mlx_lm.server`). The probe also JIT-loads the model on LM Studio, so the `lazy` lifecycle works.
- **`decide()`:** questions run **sequentially** (ADR-0002: one in flight). The identical state prefix comes first, so server prompt caches (llama.cpp `cache_prompt`, LM Studio, mlx-lm) reuse it. Usage is summed. `signal` is honoured. A transport or HTTP error throws `EngineError`, and the decider fails open. A per-question failure omits that answer, and `normaliseAnswers` drops it (no decision).
- **Response size:** responses are limited to 1 MiB via the shared `readLimited`.

Mapping `/v1/systemone` to logprob prompts (pure, in `engines/openai/logprob.ts`):

| question | labels | prompt tail | wire answer |
|---|---|---|---|
| `noul` | `yes`, `no` | `Options:\nyes: {criteria.true ?? "it is true"}\nno: {criteria.false ?? "it is false"}\nAnswer yes or no.` | `{type:'noul', noul: p(yes)}` |
| `choice` (≤ `maxOptions`) | `A`,`B`,… in criteria order | `A. {id}: {desc}` lines, `Answer with one letter (A–C).` | `{type:'choice', choice: argmax id, probabilities: {id: p}}` |
| `score` (≤ 10 levels) | `0`..`L-1` | `0: {level}` lines, `Answer with one digit (0–N).` | `{type:'score', score: Σ i·pᵢ, probabilities: {"i": pᵢ}, legend}` |

Prompt structure and request:

- **System message:** `You are a precise classifier. Read the state, then answer with exactly one option label and nothing else.`
- **User message:** `<state>\n{state as text, already sorted and redacted by the decider, truncated to maxStateChars with core's truncation}\n</state>\n\nQuestion: {instructions}\n{tail}`
- **Chat request:** `{model, messages, max_tokens:1, temperature:1, top_p:1, logprobs:true, top_logprobs, stream:false, ...extraBody}`. `temperature: 1` is deliberate, because some servers report post-temperature probabilities, and at 0 they come back one-hot. The token that gets sampled is ignored; only the distribution is read.
- **`api:'completions'`:** the same text plus `\nAnswer:` as `prompt`, with `logprobs: topLogprobs`.

Scoring:

- **Token aggregation:** normalise each top-logprob token (trim; strip leading `(`, trailing `.):`; letters upper-case; `yes/y/true` and `no/n/false` lower-case), then sum `exp(logprob)` per label. A label missing from the top-k gets the floor `exp(min logprob)`.
- **Coverage and calibration:** `coverage = Σ m` before flooring. Below `minCoverage` the question is omitted, and the engine `detail` records `low option coverage 0.04 (thinking model? set extraBody)`. Probabilities come from `pᵢ ∝ mᵢ^(1/T)`, renormalised.
- **Confidence:** none is reported. The gateway computes Strands' formulas (ADR-0002).

Accuracy caveats (docs/engines.md, install.md, UI badge):

- General chat LLMs are not trained for this contract. Their token probabilities are over-confident and uncalibrated, so Strands' 0.9–0.95 thresholds do not transfer. Keep policies in `shadow`, read `local-decider stats`, then tune per-policy thresholds.
- Position and label bias (`A` and `yes` are favoured). Options keep their criteria order for reproducibility, so the bias is not hidden.
- The top-k cap (20 on Ollama) under-counts mass on rare labels. Choices above `maxOptions` go unanswered.
- Thinking models (Qwen3.x) must have thinking off (`extraBody`, `/no_think`, or the server setting). Otherwise coverage is about 0 and no decision is made (fail open, not a wrong decision).
- Latency is one request per question; prefix caching reduces it. A 35B-A3B model at 4-bit uses about 20 GB, which competes with the user's work. Context and truncation limits apply. 4-bit quantisation shifts probabilities.

### Tasks B

| # | Commit | Files | Tests |
|---|---|---|---|
| B1 | `feat(gateway): host-aware strands devices; auto uses MLX on Apple silicon` | `engines/strands/mlx.ts` (`resolveDevice`, `venvHasMlx`). `serveArgs` takes the resolved device. `devices(host)`, `tag`. engine-control rejects a device not offered on the host (400), and a saved invalid device falls back to `auto`. The strands label drops "(PyTorch)". | `test/engines/strands.test.ts`: resolve matrix (darwin+mlx venv → mlx; darwin without → omitted; linux → omitted), using a tmp fake venv and an injected host. `engine-control.test.ts`: `mlx` on a linux host → 400. |
| B2 | `docs(research): measured macOS engines` (no code) | Run **outside the sandbox** on the M5 Pro: `engine install` (mlx), `gateway start`, `local-decider bench`, for 2B, E4B and 12B on mlx vs mps. Check LM Studio `/v1/chat/completions` and `/v1/completions` logprobs (and whether they come back one-hot at temperature 0 vs 1), the same for mlx_lm.server, and the thinking-off switch for Qwen3.6. Update `docs/research/macos-engines.md` and the `latencyHint`s with the machine named. | none. B4's defaults (`api`, `extraBody`) are fixed from these results. |
| B3 | `refactor(gateway): shared JSON POST/GET helpers` | `engines/http.ts`: `postJson(url, body, {token, signal, maxBytes})` and `getJson`. `postSystemOne` is built on them. | `test/http.test.ts`: size limit, auth header, error text. |
| B4 | `feat(gateway): openai-compatible logprob engine` | `engines/openai/logprob.ts` (`renderPrompt`, `optionMasses`, `toWireAnswer`, `parseTopLogprobs` for chat and completions shapes), `engines/openai/index.ts` (engine and descriptor), one `ENGINES` line, regenerated schema. Usable via `engine: {type: openai-compatible, model}`. | `test/engines/logprob.test.ts`: label variants, floor, coverage cut, temperature, `maxOptions` omit, score expectation, completions shape. `test/engines/openai.test.ts` against a fake loopback HTTP server: start probe ok and no-logprobs, decide end-to-end through `normaliseAnswers`, token only to loopback/https, 1 MiB cap, abort. |
| B5 | `feat(gateway): per-engine options and runtime switching to discovered models` | `config.engines`: optional `partialRecord` of each descriptor's schema without `type`, built from `ENGINES`. `#engineConfig(sel)` uses `config.engine` when the type matches, else `engineDefaults(id, sel.model, config.engines?.[id])`. `allowedModels` adds discovered models (async in `#checkSelectable`). `applyConfig` re-applies when `engines[active]` changes. The plugin lists discovered models with no Download button. | `engine-control.test.ts`: a strands config with `engines.openai-compatible.url` set to the fake server, switched via `select`, persisted in `selection`, unknown model → 400. `config.test.ts`: old configs parse, and `engines` with an unknown key fails. |
| B6 (optional, only if B2 shows LM Studio gives logprobs) | `feat(gateway): optional lms lifecycle for LM Studio` | `manage: 'lms'`. `PathDef 'tools.lms'` (auto: `~/.lmstudio/bin/lms`, PATH; `engine: 'openai-compatible'`). On start, if the server is unreachable: `lms server start`, then `lms load <model> --yes`. `stop()` (lazy idle unload) runs `lms unload <model>`. All fixed argv via `probe`; the model comes from config or discovery and passes the leading-'-' regex. | `test/engines/openai-lms.test.ts` with a fake `lms` script in tmp that records argv. |
| B7 | `docs: macOS install and the openai-compatible engine` | `docs/install.md`: an Apple Silicon section (MLX default, `device: mps` / `cpu` fallback, mps needs the mlx or cpu flavour, 48 GB fits up to 12B bf16 but not 26B-A4B), LM Studio, Ollama, llama-server and mlx_lm.server recipes with `engines.openai-compatible`, and the caveats. `docs/engines.md` §5–6. `docs/security.md`: state goes to the configured URL; the token only goes over https/loopback; `lms` argv is fixed. | `docs-engines.test.ts` covers the new id. |

---

## C. macOS service and FLM

| # | Commit | Files | Tests |
|---|---|---|---|
| C1 | `fix(gateway): launchd agent gets PATH, HOME and data-dir env` | `service.ts`: `launchdEnv(env, execPath, tools)` (pure) gives `PATH` = dedupe of [dirname(node), dirname(uv) if found, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`], `HOME`, and pass-through of `LOCAL_DECIDER_HOME`, `LOCAL_DECIDER_CONFIG_DIR`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `HF_HOME` and `HF_HUB_CACHE` when set. **Never tokens.** `launchdPlist(command, paths, env)` emits `EnvironmentVariables`. `gatewayCommand` adds `--env-file-if-exists=<config>/env` (Node ≥ 22.9) to the plist command only, as the launchd counterpart of systemd's `EnvironmentFile=-`. Systemd is untouched. | new `test/service.test.ts`: plist XML has the env dict, escapes values, contains no `LOCAL_DECIDER_TOKEN` even when set, has an absolute script path, and the env-file flag. |
| C2 | `fix(gateway): launchd restart without the bootout/bootstrap race` | `startLaunchd(command, paths, restart, deps = defaultLaunchctl)` with an injected `{run, tryRun, sleep, uid}`. Loaded, unchanged and restart → `kickstart -k`. Plist changed → `bootout`, then poll `launchctl print` until unloaded (≤ 5 s, 100 ms steps), then `bootstrap` with up to 3 retries on exit 5 / `Input/output error`, 500 ms apart. Not loaded → `bootstrap`. `stopService` waits for the unload the same way. | `service.test.ts`: fake launchctl transcripts for each branch, including one EIO retry and a give-up message. |
| C3 | `fix(gateway): hide FastFlowLM tools and paths on unsupported hosts` | `toolchain.ts`: `PathDef.engine?` and `resolveAll(config, paths, env, host)` drop entries whose engine `supports(host)` is false. `parsePathUpdate` still accepts every key. (A5 already gives a clean install refusal.) | `toolchain.test.ts`: darwin host → no `tools.flm`/`dirs.flmModels`; linux → unchanged. |

---

## D. Plugins (macOS parity)

| # | Commit | Files | Tests |
|---|---|---|---|
| D1 | `fix(paseo-plugin): launchd start and restart tolerate the loaded/unloaded state` | `server/service.ts`: `ServiceCommand.fallback?`. On launchd, `start` = `bootstrap` with fallback `kickstart` when the output matches `/already|in progress|Input\/output error/` or the exit code is 5 or 37. `restart` = `kickstart -k` with fallback `bootstrap` when the service is not loaded (exit 113 / "Could not find service"). The argv stays fixed per action. `serviceInfo` shows both commands. | `paseo-plugin/test/service.test.ts`: each fallback path; the fallback does not run on unrelated errors. |
| D2 | `fix(plugin): hooks find node when the harness starts from the macOS GUI` | new `plugins/local-decider/hooks/run-hook.sh` (POSIX sh): tries `command -v node`, then `$HOME/.local/share/mise/shims/node`, `/opt/homebrew/bin/node`, `/usr/local/bin/node`. With none found it exits 0 silently (fail open). It `exec`s `node "$root/dist/hook.mjs" "$@"`. `hooks.json` and `codex-hooks.json` call the shim. README: macOS note. | `plugins/local-decider/tests`: run the shim with `PATH=/usr/bin:/bin` and a fake node dir, and with no node (exit 0, empty stdout). shellcheck runs in `mise run check`. |
| D3 | `docs(paseo-plugin): macOS engines in the settings overview` | `packages/paseo-plugin/OVERVIEW.md`/`README.md`: engines and devices come from the gateway, the uncalibrated badge, discovered models, and the Paths section by host. The skills in `plugins/local-decider/skills` need no change (they name no engine), apart from a pointer to `docs/engines.md` in `local-decider-settings`. | none beyond check. |

The Claude Code mod (`register.mjs`) and `packages/hooks` talk HTTP only and need no change.

---

## Open questions (with my recommendation)

1. **The `engines:` per-engine options map (B5).** Recommend **yes**. Without it, openai-compatible can only be used by making it `engine.type`, and the settings page cannot switch to an LM Studio or Ollama URL. It is additive and backward compatible.
2. **Unsupported engines in the payload.** Recommend listing them with `supported:false` and a reason (useful for `engine list` and support), and **hiding** them in the Paseo select unless active.
3. **`auto` → MLX on Apple silicon changes the device for existing Mac users** (MPS → MLX, 1.4–1.6× faster per the README). Recommend **yes**. It only happens when MLX is installed, and `device: mps` stays available.
4. **Hard safety cap for uncalibrated engines** (for example forcing `shadow`). Recommend **no cap**. Policies already start in shadow, and the `calibrated:false` badge plus the docs warning are enough. Revisit if stats show over-confident auto-allows.
5. **LM Studio support depends on B2.** If chat completions return no usable logprobs, recommend documenting mlx_lm.server or llama-server (llama.cpp's Metal build) as the macOS openai-compatible path and dropping B6.
6. **The D2 node shim.** Recommend **yes**. It is tiny, fails open, and fixes Claude Code desktop and Codex launched from Finder or the Dock.
7. **Deriving `toolchain`/`config.tools` from descriptors.** Recommend **not now** (two managed binaries). Revisit at a third.
8. **Laya (in-process ONNX).** Out of scope. With the registry it becomes one descriptor file later.

## Verification

- Every task: `mise run check` (lint, typecheck, md, workflow lint, shellcheck, cccc, fallow, build, test).
- Backward compatibility: A1 keeps `schemas/config.schema.json` byte-identical. `config.test.ts` parses today's documented example config (install.md § Configuration) unchanged after every task.
- Linux unchanged: `engine-control.test.ts` and `cli-engine.test.ts` with an injected linux/x64 host keep today's engine list, devices `auto,cpu,cuda`, FLM install and validation.
- macOS end to end, run outside the Claude sandbox (it blocks `~/.local/share`, `~/Library/LaunchAgents` and local binding):
  1. `mise run setup`
  2. `local-decider engine install` and check `engine list`
  3. `gateway start`, then `gateway status`
  4. `gateway restart` twice quickly (C2)
  5. `local-decider decide turn-outcome lastMessage="All tests pass"` and check the `engine-strands-decider.log` argv shows `--device mlx`
  6. `local-decider bench`
  7. `lms server start`, set `engines.openai-compatible.url`, `local-decider engine use openai-compatible <model>`, then `decide` and `stats`
  8. Paseo settings: engine select without FLM, devices `mlx/mps/cpu`, the LLM badge, discovered models
  9. Claude Code desktop: hook fires (gateway shadow log gains a `claude-code` row)
- `engine install --engine fastflowlm` on macOS exits 2 with the platform message and no network call.
