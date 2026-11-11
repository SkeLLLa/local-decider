# macOS engine measurements (M5 Pro)

Measured 2026-11-11 on a MacBook Pro M5 Pro (18 cores, 48 GB, macOS 26.7.1, Node 26.13, uv 0.13.7 via mise, LM Studio with `lms` installed).

Legend as in `engines.md`: **[verified]** means read in source or measured here. **[docs]** means stated by vendor documentation, not tested here. **[unverified]** means inference.

## Gateway and Strands 2B [verified]

On this Darwin/arm64 host, `engine install` selected the default `mlx` flavor. `engine install --no-download` created the environment in 83.89 s; the subsequent full `engine install` downloaded the default 2B model and completed in 140.41 s. The default model is `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610`.

The first decision after switching devices is the cold result: it includes model startup, warmup/compilation and the inference. Warm figures use `local-decider bench --sizes 256 --runs 4`; the benchmark's 256-token target produced 336 engine input tokens. The memory column is the Python process's `vmmap -summary` physical footprint after inference, with its reported peak.

| device | actual `strands-decider serve` device arg | first real permission decision | warm 256-target bench p50 / p95 | process physical footprint / peak |
|---|---|---:|---:|---:|
| MLX | `--device mlx` | 9.13 s | 66 / 132 ms | 5.0 / 5.7 GiB |
| MPS | `--device mps` | 7.90 s | 180 / 269 ms | 5.0 / 5.1 GiB |
| CPU | `--device cpu --no-warmup` | 5.34 s | 1,102 / 1,106 ms | 7.9 / 7.9 GiB |

The gateway's default `device: auto` does **not** select MLX. `serveArgs()` omits `--device` when the setting is `auto`; the installed `strands-decider serve --help` says omission auto-detects `cuda > mps > cpu` and that MLX is selected only when explicitly requested. The observed auto child command had no `--device` flag. Thus on this Apple host, auto selects MPS when available, while MLX requires explicit selection.

`policies eval permission policies/fixtures/permission.jsonl` sent 20 fixture decisions. Its first row returned `action=unavailable`; the other 19 returned decisions. Repeating that first input with `local-decider decide permission --input ...` later succeeded in 1.08 s. The CLI client maps non-2xx responses and fetch errors/timeouts to `null`, so the first row did not expose the underlying HTTP error.

### Gateway failure captured during the run [verified]

| command | exact failure | location |
|---|---|---|
| `node --conditions=source packages/gateway/src/cli.ts engine install` (first attempt) | `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/oleksandrku/dev/os/local-decider/packages/gateway/src/sqlite-log.ts' imported from '/Users/oleksandrku/dev/os/local-decider/packages/gateway/src/runtime.ts'` | The top-level `./sqlite-log.ts` import in `runtime.ts` was present before the concurrent storage change had created the new file. Once that file appeared, the CLI and install commands ran successfully. |

The gateway was run in the foreground on `127.0.0.1:8765`. LaunchAgent/service behavior was not measured.

## Static findings from the source [verified]

Code paths that matter on macOS:

- `engine-install.ts` `defaultFlavor()` returns `mlx` on darwin/arm64. `installStrandsEngine` runs `uv sync --project engines/strands-decider --frozen --extra mlx` with `UV_PROJECT_ENVIRONMENT=~/.local/share/local-decider/venvs/strands-decider`.
  - The `hf` and `python` binaries are taken from `venv/bin/`, which is correct on macOS.
  - `pyproject.toml` pins `requires-python >=3.11,<3.14`, which matches MLX's 3.11+ need.
  - The `cpu` extra only adds `torch>=2.7`. The `[tool.uv.sources]` CPU-index pin is Linux-only (`sys_platform == 'linux'`), so on macOS it pulls the PyPI wheel, which includes MPS. So `--device mps` needs the `cpu` or `mlx` flavor installed, not a separate extra. The installed MLX flavor also included PyTorch 2.15.0 because `strands-decider` core depends on `torch>=2.7`.
- `engines/strands.ts` `serveArgs`: passes `--device` only when not `auto`. `--no-warmup` is added for `cpu` only. On MLX/MPS warmup stays on; first decision timings above include that startup/warmup cost. The Python CLI confirms that omitted device auto-detection does not include MLX.
- `models.ts`: the default 2B `latencyHint` now records the measured M5 Pro warm p50 values for CPU, MPS and MLX. `modelMemoryGb` already uses `gpuMemoryGb` for `mlx` and `mps`. The 48 GB budget (`MEMORY_BUDGET` 0.8, 38.4 GB) fits E2B, E4B and 12B (23 GB bf16) in bf16. 26B-A4B (51 GB) does not fit.
- `service.ts`: has a real `launchd` branch. `launchdPlist` uses `RunAtLoad` and `KeepAlive.SuccessfulExit=false`, and logs to `paths.logs/gateway.log`. `startLaunchd` uses `launchctl bootstrap gui/<uid>`.
  - Concerns **[unverified, not run]**:
    - the plist has no `EnvironmentVariables`, so the agent starts with launchd's minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`). `uv` and the mise `node` are then not on `PATH`. `process.execPath` is absolute, so the gateway itself starts, but `toolchain.ts` `onPath('uv')` fails.
    - the plist command is `process.execPath + process.execArgv + argv[1]`. From source that is `node --conditions=source .../cli.ts`, with a `cli.ts` path that is absolute only if argv[1] was.
    - the `systemd` unit's optional `EnvironmentFile` for tokens has no launchd equivalent.
    - `bootout` followed by `bootstrap` can race, and `bootstrap` can fail with `Bootstrap failed: 5: Input/output error` when the label was just booted out.
- `paths.ts`: honours `XDG_DATA_HOME` and `XDG_CONFIG_HOME`, and defaults to `~/.local/share` and `~/.config` on macOS too. This matches AGENTS.md. No change needed.
- `toolchain.ts`: `dirs.flmModels` defaults to `~/.config/flm/models`. That is harmless on macOS, since FLM is not used. The settings page still lists `tools.flm` as missing, which is noise but not an error.
- `cli.ts` `engine install --engine fastflowlm` calls `installFlm`. It should refuse cleanly on darwin. I did not read `flm-install.ts`, so **[unverified]**.
- Linux-only strings in the gateway sources: grep for `/proc`, `/dev/accel`, `amdxdna` and `win32` found none. The `process.platform` references are only in `service.ts` and `engine-install.ts`.
- The three plugins and `plugins/local-decider`: grep for `~/.local/share`, `XDG_`, `/proc`, `flm`, `systemctl`, `bin/hf` and `bin/python` found nothing. Shell scripts in the plugins were not enumerated. The plugin audit (step 6) is therefore only a negative grep, **[unverified]** beyond that.

## LM Studio and mlx-lm [verified]

For LM Studio, `lms get https://huggingface.co/mlx-community/Qwen3-1.7B-4bit --mlx --yes` downloaded 984 MB in 32.16 s. `lms server start --bind 127.0.0.1 --port 1234` took under 0.12 s; loading the model with `lms load qwen3-1.7b --gpu max --identifier qwen3-1.7b-b2 --yes` took 5.73 s and reported 938.43 MiB.

With `max_tokens: 1`, `logprobs: true`, and `top_logprobs: 5`, LM Studio's OpenAI-compatible chat and legacy completions routes returned HTTP 200 at temperature 0 and 1, but emitted zero completion tokens and `logprobs: null`. At `max_tokens: 8`, chat completions with the user prompt suffix `/no_think` returned token logprobs (about 100 ms at temperature 0 and 47 ms at temperature 1); the legacy completions endpoint generated text but still returned `logprobs: null`. The chat route without that suffix emitted reasoning text. `chat_template_kwargs: {"enable_thinking": false}` did not suppress it, and native `/api/v1/chat` rejected `reasoning: "off"` because this model does not expose reasoning configuration. The Responses route also returned logprobs at 8 output tokens, but not at 1.

`uvx --from mlx-lm mlx_lm.server` served the same small MLX model. Its first chat request took 1.06 s; warm requests were about 17–100 ms. Both `/v1/chat/completions` and `/v1/completions` returned `logprobs` and `top_logprobs` with `max_tokens: 1` at temperatures 0 and 1. Chat used the model template; setting `chat_template_kwargs: {"enable_thinking": false}` returned the answer token `Yes` with its logprobs at one token (22 ms at temperature 0, 59 ms at temperature 1). The default chat template instead returned the `<think>` token; `/no_think` alone did not reliably suppress thinking on this server.

**B4 recommendation:** use chat completions for the default API so chat templates are applied. Expose thinking controls as provider-specific `extraBody`: `chat_template_kwargs.enable_thinking=false` worked on mlx-lm, but not on LM Studio. Do not assume an OpenAI-compatible backend supports one-token logprobs just because it accepts the request; LM Studio needed more output budget and `/no_think`, and its legacy completions route did not return logprobs.

**B6 recommendation:** keep LM Studio lifecycle support optional. Starting its server is quick and loading took under six seconds, so lifecycle control can help users who already run LM Studio. The tested LM Studio route did not provide usable max-one-token logprobs or a working thinking-off body, so it is not a better default backend for this decision contract. Both LM Studio and mlx-lm servers were stopped and the LM Studio model was unloaded after measurement; downloaded model files remain in their allowed model caches.

`@receptron/laya` (onnxruntime-node on CPU) is the lowest-effort in-process engine on Apple silicon (~140 ms for 3 questions on an Apple-silicon CPU, per its README) **[docs]**; it was not run here.

## Extensibility today

Adding an engine (e.g. LM Studio, mlx-lm, Laya) or a model currently means editing many files by hand. There is no shared engine descriptor. Each engine id is hard-coded as a string in each of these places **[verified by grep, source not run]**:

| # | place | what to change | per-engine hard-coding |
|---|---|---|---|
| 1 | `gateway/src/engines/index.ts` `createEngine` | add an `if (config.type === ...)` branch | if-chain; strands is the fall-through default |
| 2 | `gateway/src/engines/<name>.ts` | new class (usually extends `SupervisedEngine`, with a `ServerSpec`) | the binary lookup, `serveArgs` and health path are written per engine |
| 3 | `gateway/src/config.ts` | new `z.strictObject` (`strandsSchema`, `flmSchema`), add to the `engineSchema` discriminated union, `EngineConfig` type, `engineDefaults()`; the `selection.engine` `z.enum([...])` (about line 194); the default `engine` block | engine ids repeated in the union, the enum and `engineDefaults`' parameter type |
| 4 | `gateway/src/models.ts` | extend `CatalogEngine`; add models to `KNOWN_MODELS` | `KnownModel` mixes shared fields with engine-specific ones (`hf` for strands, `gpuMemoryGb` for the strands devices) |
| 5 | `gateway/src/state.ts` (~line 26) | `sel['engine'] !== 'strands-decider' && ... 'fastflowlm'` | hand-written check duplicating the enum in 3 |
| 6 | `gateway/src/engine-control.ts` | `SWITCHABLE_ENGINES`; `#engines()` (the engine list returned to the UI, with `label`, `installed`, `devices`, `validation`); `#initialSelection`, `#engineConfig` (`type === 'strands-decider'` decides whether `device` applies); `validate()` (only `fastflowlm`); the constructor kicks off `validate('fastflowlm')` | the largest cluster; each engine is a hand-written entry |
| 7 | `gateway/src/toolchain.ts` | `PATH_KEYS`, `DEFS` (label, tool basename, auto-discovery), the `Toolchain` fields, `toolchain()` | one path key and one field per tool |
| 8 | `gateway/src/engine-install.ts`, `flm-install.ts`, `cli.ts` `engine()` | an installer function plus `--engine` branching and a `USAGE` line | `installStrandsEngine` and `installFlm` share no interface; `--flavor`/`--model` are strands-only; the FLM installer is Linux-only (`fastflowlm_<v>_linux.tar.gz`) |
| 9 | `gateway/src/downloads.ts` `downloadSteps` | a branch per engine mapping a catalogue model to argv | `if (model.engine === 'fastflowlm')`, else strands |
| 10 | `gateway/src/catalog-status.ts` | per-engine "is this model downloaded" check (`flm list`, HF cache) | FLM branch at ~line 92-99 |
| 11 | `gateway/src/settings-routes.ts`, `server.ts` | the routes (`/v1/engine`, `/v1/engines`, models, downloads, paths) are generic over the catalogue, but their payload shapes come from 6 | little extra code if 6 is done |
| 12 | `paseo-plugin/shared/engines.ts` | `ENGINE_TAGS` (`'fastflowlm': 'NPU'`, `'strands-decider': 'PyTorch'`) and the response types | a hard-coded label map |
| 13 | `paseo-plugin/client/settings-engines.tsx` | `FASTFLOWLM` constant; the FLM-specific panel (line ~220: finds the `fastflowlm` engine and renders its validation) | an engine-specific UI block; the rest of the list is data driven |
| 14 | docs | `docs/architecture.md` "Engines", `docs/research/engines.md`, README, config schema (`pnpm --filter local-decider schemas`) | manual |

Not engine-specific, so no change: `paths.ts`, `decider.ts` (it talks to `Engine`), `engines/types.ts` (`Engine`/`EngineHealth`), `engines/http.ts`, the `/v1/systemone` client in core.

Duplicated or hard-coded per engine:

- The engine id appears as a string literal in about 12 files with no single source of truth.
- Capabilities are expressed as `engine === 'strands-decider'` checks (does it have devices? can it be validated? does it need a download step?) instead of descriptor fields.
- Install, download, "is it installed" and "is the model present" are four separate per-engine code paths that must agree.
- `engine install` flags (`--flavor`, `--model`) assume strands.
- A catalogue-only engine that just points at an OpenAI-compatible URL (LM Studio, mlx-lm server) would still need steps 1, 3, 5, 6 and 12 even though it has nothing to install or download. The existing `systemone-remote` type covers the `/v1/systemone` case but not the logprob adapter (`engines.md` section 4).

Suggested shape, so adding an engine is one file plus one registry line **[proposal, unverified]**:

```ts
interface EngineDescriptor {
  id: string;                       // single source for the enum, the union and ENGINE_TAGS
  label: string; tag: string;       // UI strings (replaces #engines() entries and ENGINE_TAGS)
  platforms: NodeJS.Platform[];     // hide on unsupported OSes (FLM = linux only)
  configSchema: z.ZodType;          // composed into engineSchema/selection automatically
  devices?: readonly string[];      // replaces the strands-only `device` checks
  create(config, paths, tools): Engine;
  install?(opts): Promise<void>;    // `engine install --engine <id>`; opts are descriptor-declared
  installed(tools): boolean;        // feeds #engines()
  validate?(): Promise<Validation>;
  download?(model: KnownModel, tools): [string, string[]][];
  modelPresent?(model, tools): Promise<boolean>;
  models: KnownModel[];             // the catalogue lives next to the engine
}
```

`createEngine`, `engineSchema`, `selection.engine`, `SWITCHABLE_ENGINES`, `#engines()`, `downloadSteps`, the CLI `engine install` dispatch and the plugin's tag map would all iterate a `ENGINES: EngineDescriptor[]` registry. The plugin UI would render devices, validation and install hints from the `/v1/engines` payload instead of the `FASTFLOWLM` special case. This also gives macOS a clean place to say "FLM: linux only; MLX: darwin only".

## Measured recommendation

1. Default: `strands-decider` 2B Qwen3.5 with `--device mlx`. It was the fastest tested path here: 66 ms warm p50 for a 256-token target (336 engine tokens).
2. Compatibility fallback: explicit `--device mps` (180 ms warm p50). `auto` chooses MPS on this Apple host; it does not select MLX. CPU worked at 1.10 s warm p50 and is the slow fallback.
3. E4B or 12B remain candidates, not measured results. E4B's catalog download is 16.5 GB, so it was not a quick add-on to this pass.
4. Laya remains a docs-only option until measured.

Code changes suggested by source reading alone (priority order):

1. `service.ts` `launchdPlist`: add `EnvironmentVariables` with `PATH` (include the dirs of `uv` and `node`) and `HOME`, and handle the `bootout`/`bootstrap` race.
2. `cli.ts` and `flm-install.ts`: make `engine install --engine fastflowlm` fail with a clear message on darwin.
3. Docs: say in the README that `--flavor mlx` is the macOS default and that `mps` uses the `cpu` or `mlx` install.

## Remaining checks

E4B/12B and LaunchAgent behavior were not measured. The foreground gateway, LM Studio server and mlx-lm server were stopped after the run; downloaded models remain cached.
