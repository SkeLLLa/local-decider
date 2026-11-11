# macOS engines: research notes (PARTIAL: blocked by the sandbox)

Started 2026-11-11 on a MacBook Pro M5 Pro (18 cores, 48 GB, macOS 26.7.1, Node 26.13, uv 0.13.7 via mise, LM Studio with `lms` installed).

Legend as in `engines.md`: **[verified]** means I read it in the source or ran it here. **[docs]** means the vendor docs say it and I did not test it. **[unverified]** means inference.

**Status: nothing was installed, started or measured.** The agent ran in a Claude Code Bash sandbox that blocked every step that needs the machine. The sections below hold only what source reading and the probes could establish. Items 2 to 5 of the task (install, run, measure, evaluate LM Studio and mlx-lm, launchd) remain open.

## Blockers hit in the sandbox [verified]

| step | command | error | what is needed |
|---|---|---|---|
| runtime dirs | `mkdir -p ~/.local/share/local-decider` | `Operation not permitted` | write access to `~/.local/share/local-decider` (the venvs, logs, run dir) |
| HF cache | `mkdir -p ~/.cache/huggingface` | `Operation not permitted` | write access to `~/.cache/huggingface` (or `HF_HOME` somewhere writable) |
| launchd | write `~/Library/LaunchAgents/dev.local-decider.gateway.plist` | not attempted; `~/Library/LaunchAgents` is outside the write allowlist, and `launchctl` is likely blocked too | run `local-decider gateway start` outside the sandbox |
| gateway port | `node -e "net.createServer().listen(0,'127.0.0.1')"` | `EPERM` | `sandbox.network.allowLocalBinding: true` |
| `mise run setup` | `pnpm install --frozen-lockfile` | `ERR_PNPM_LOCKFILE_RESOLUTION_VERIFICATION`: 57 entries, e.g. `@babel/core@7.29.13 [TRUST_DOWNGRADE] ... missing time for version ... in metadata` | not a sandbox write error. It may come from the filtering proxy returning abbreviated registry metadata, or from the pnpm `trustPolicy`. I did not relax the policy. No `node_modules` exists, so the gateway cannot run from source yet. |

Network to `huggingface.co` works (HTTP 200 on the model API). `lms status` runs and reports the server OFF.

## Static findings from the source [verified]

Code paths that matter on macOS:

- `engine-install.ts` `defaultFlavor()` returns `mlx` on darwin/arm64. `installStrandsEngine` runs `uv sync --project engines/strands-decider --frozen --extra mlx` with `UV_PROJECT_ENVIRONMENT=~/.local/share/local-decider/venvs/strands-decider`.
  - The `hf` and `python` binaries are taken from `venv/bin/`, which is correct on macOS.
  - `pyproject.toml` pins `requires-python >=3.11,<3.14`, which matches MLX's 3.11+ need.
  - The `cpu` extra only adds `torch>=2.7`. The `[tool.uv.sources]` CPU-index pin is Linux-only (`sys_platform == 'linux'`), so on macOS it pulls the PyPI wheel, which includes MPS. So `--device mps` needs the `cpu` or `mlx` flavor installed, not a separate extra. Whether `mlx` also pulls torch is **[unverified]**: `strands-decider` core depends on `torch>=2.7`, so yes in principle.
- `engines/strands.ts` `serveArgs`: passes `--device` only when not `auto`. `--no-warmup` is added for `cpu` only. On MLX/MPS warmup stays on, so the first start is slower. Warmup cost on MLX is **[unverified]**.
- `models.ts`: the `latencyHint` strings for MLX (`~0.1 s`) come from the strands-decider README (M4 Pro, 113 ms at 222 tokens), not from this machine. `modelMemoryGb` already uses `gpuMemoryGb` for `mlx` and `mps`. The 48 GB budget (`MEMORY_BUDGET` 0.8, 38.4 GB) fits E2B, E4B and 12B (23 GB bf16) in bf16. 26B-A4B (51 GB) does not fit.
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

## LM Studio, mlx-lm, Laya, GLiClass on this Mac

Not run. What is known:

- `~/.lmstudio/models` holds `Qwen3.6-35B-A3B-MLX-4bit` and a GGUF `sweep-next-edit-1.5B`. The 35B-A3B model is a general chat model, not a calibrated decision model.
- `lms server start` was not attempted. Logprobs on `/v1/chat/completions` are **[unverified]** (`engines.md` §4: not confirmed; `/v1/responses` supports `top_logprobs` per a blog post).
- `@receptron/laya` (onnxruntime-node on CPU) is the lowest-effort in-process engine on Apple silicon (~140 ms for 3 questions on an Apple-silicon CPU, per its README) **[docs]**.

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

## Recommended plan, pending measurement [unverified]

1. Default: `strands-decider` 2B Qwen3.5 on `--device mlx` (installed with `--flavor mlx`). It is the exact contract, with README latency of about 0.1 s.
2. Fallback: the same model on `--device mps`, then `cpu` (3 to 9 s on an M3 Pro per the README).
3. Larger option: E4B or 12B Gemma 4 on MLX, since 48 GB allows them. Quality is much better (JevBench 187 and 200 of 231), and the latency is unmeasured.
4. Fast tier: Laya via ONNX on CPU.

Code changes suggested by source reading alone (priority order):

1. `service.ts` `launchdPlist`: add `EnvironmentVariables` with `PATH` (include the dirs of `uv` and `node`) and `HOME`, and handle the `bootout`/`bootstrap` race.
2. Run the install and the gateway outside the sandbox to find the real failures (this document should then be redone).
3. `cli.ts` and `flm-install.ts`: make `engine install --engine fastflowlm` fail with a clear message on darwin.
4. Docs: say in the README that `--flavor mlx` is the macOS default and that `mps` uses the `cpu` or `mlx` install.

## To finish this research

Run it outside the sandbox, or allow writes to `~/.local/share/local-decider`, `~/.cache/huggingface` and `~/Library/LaunchAgents`, plus `allowLocalBinding`. Then:

```sh
mise run setup
node --conditions=source packages/gateway/src/cli.ts engine install --flavor mlx
mise run gateway
```
