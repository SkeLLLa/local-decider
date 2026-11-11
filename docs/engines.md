# Engines

An engine turns a `/v1/systemone` request (state plus questions) into answer probabilities. The
gateway has a registry of engine descriptors; the config schema, `GET /v1/engines`, the CLI and
the Paseo settings page all read it. Decision architecture is in
[architecture.md](architecture.md); the reasoning behind the registry is in
[ADR-0008](adr/0008-engine-registry.md). Measurements behind the macOS notes are in
[research/macos-engines.md](research/macos-engines.md).

## 1. Engines

| id | Label | Platforms | Devices | Install | Calibrated | Models |
|---|---|---|---|---|---|---|
| `strands-decider` | Strands Decider (PyTorch) | all | Apple Silicon: `auto`, `cpu`, `mlx`, `mps`; Linux: `auto`, `cpu`, `cuda`; else `auto`, `cpu` | `local-decider engine install [--flavor cpu\|mlx\|cuda]` | yes | Catalogue in `engines/strands/models.ts`, downloaded from Hugging Face |
| `fastflowlm` | FastFlowLM (AMD NPU) | Linux (x86_64 for the installer) | none | `local-decider engine install --engine fastflowlm` | yes | Catalogue in `engines/fastflowlm/models.ts`, pulled with `flm pull` |
| `openai-compatible` | OpenAI-compatible | all | none | nothing to install: start your server | **no** | Discovered from the server's `/models` |
| `lmstudio` | LM Studio | macOS, Linux | none | nothing to install: `lms server start`, load a model | **no** | Discovered from the server's `/models`; defaults `api: chat`, `maxTokens: 8`, `promptSuffix: /no_think` |
| `systemone-remote` | SystemOne Remote | all | none | nothing to install | yes | none; not selectable, pinned to `engine.url` |

- **Selectable** engines (`strands-decider`, `fastflowlm`, `openai-compatible`) can be switched at
  run time with `local-decider engine use`, `POST /v1/engine` or the Paseo settings page.
  `systemone-remote` is configured in `engine:` only.
- **Calibrated** means the engine's probabilities were checked against the policy thresholds.
  `openai-compatible` scores one option token from a general-purpose model's logprobs, so its
  numbers are not calibrated: start in `shadow` mode, read `local-decider stats`, and set
  thresholds from your own data. The Paseo settings page shows an "uncalibrated" badge.
- An engine the host does not support (`fastflowlm` off Linux) is hidden in the engine picker
  unless it is already active, and `GET /v1/engines` reports `supported: false` with a reason.
- **Tags** are the short names in the sidebar and popover (`PyTorch`, `NPU`, `LLM`, `Remote`). The
  gateway sends the active one as `engineTag` in `/health`.

`local-decider engine list` prints the engines and models as the gateway sees them.

### Configure an OpenAI-compatible server

In Paseo, open the engine settings, enter the API base URL, choose **Find local servers** to
inspect common local endpoints, then **Find models** to query the selected URL. Select a returned
model or type its id, press **Save**, and press **Use** separately to activate the engine. Saving
does not change the active engine. LM Studio is the recommended local server to start with; choose
the dedicated `lmstudio` engine for its chat and logprob defaults.

The CLI provides the same save and activation steps, including when the gateway is stopped:

```sh
local-decider engine configure lmstudio --url http://127.0.0.1:1234/v1 --model qwen3-1.7b
local-decider engine use lmstudio qwen3-1.7b
```

Use `openai-compatible` for other compatible servers. If a server needs authentication, pass
`--token-env NAME` (or set the optional token environment variable in Paseo). Only the environment
variable **name** is stored; never put the token itself in the form or config. Omitting
`--token-env` clears a previously saved name.

The effective default file is `~/.config/local-decider/config.yaml`; `LOCAL_DECIDER_CONFIG_DIR`
can select another config directory. Connection edits are validated and applied by a running
gateway as soon as the file changes, so no restart is needed. When an engine id matches
`engine.type`, the connection belongs in the primary `engine:` block, which takes precedence over
`engines.<id>:`. Otherwise it belongs under `engines.<id>:`. The saved `selection` determines which
engine and model are active; use `local-decider engine use` to change it.

## 2. How an engine plugs in

Each engine is one `defineEngine({...})` descriptor (`packages/gateway/src/engines/descriptor.ts`),
listed in `ENGINES` in `engines/registry.ts`. Nothing else names the id.

| Field | Read by |
|---|---|
| `id`, `configSchema` | The `engine:` discriminated union and the `engines:` per-engine options map in `config.yaml`, and the generated JSON Schema. The schema is a `z.strictObject` with `type: z.literal(id)` and a required `model`. |
| `label`, `description`, `tag(config, host)` | `GET /v1/engines`, the Paseo settings page, `/health` (`engineTag`) |
| `selectable`, `pinned(config)` | Switching: `selection`, `POST /v1/engine`, `engine use`. A pinned engine ignores `selection`. |
| `supports(host)` | `supported` and `unsupportedReason` in `GET /v1/engines`; `engine install` refusing an unsupported host; which tool paths are listed |
| `devices(host)` | The device picker and `--device` |
| `calibrated` | The "uncalibrated" badge |
| `models`, `modelsPresent`, `downloadSteps` | The model list, the installed check and the Download button. An engine with no `downloadSteps` has no Download action. |
| `validation` | `capabilities.validate`, the Validate button and `POST /v1/engines/validate`; `onStart` also runs it when the gateway starts |
| `create(config, ctx)` | Builds the `Engine` object the decider talks to |

The gateway's `/v1/engines` payload carries these fields and the Paseo plugin reads them, so a
new engine appears in the settings page without a plugin change. An older gateway that lacks the
new fields is read with defaults (tag = id, supported, calibrated).

## 3. Adding an engine

1. Create `engines/<id>/index.ts` exporting `defineEngine({...})`. The `configSchema` must be a
   `z.strictObject` with `type: z.literal('<id>')` and defaults for every field except `model`.
2. Add it to `ENGINES` in `engines/registry.ts`.
3. Run `pnpm --filter local-decider schemas` to regenerate the JSON Schemas.
4. Add a row to the table in section 1. A test fails if an `ENGINES` id is missing from it.
5. Add tests next to `test/registry.test.ts` and `test/engines/`.

Rules: command-line arguments come only from validated config, never from a request. Bind
spawned servers to `127.0.0.1`. Fail open. Runtime data goes under
`~/.local/share/local-decider/`. A managed binary also needs a path entry in `toolchain.ts` so the
settings page can show and override it.

## 4. Adding a model

Append a `ModelDescriptor` to the engine's `models.ts`: `id`, `engine`, `label`, `downloadGb`,
`memoryGb` (host or CPU memory), optional `gpuMemoryGb` (used for `mlx`, `mps` and `cuda`),
`latencyHint`, `recommended`, optional `quality` and `source`. `artifacts` is interpreted by the
engine: for `strands-decider` it lists Hugging Face repos, adapter first. A model that does not fit
within 80% of the machine's memory is listed but cannot be selected.

## 5. macOS and Linux defaults

- **Apple Silicon.** `engine install` picks the `mlx` flavour. With `device: auto` the gateway
  passes `--device mlx` when the managed venv contains `mlx_lm`; otherwise it omits the flag and
  strands-decider picks `cuda`, then `mps`, then `cpu`. Set `device: mps` or `cpu` to force
  either; `mps` works with the `mlx` or `cpu` flavour. Measured warm p50 for the 2B model on an M5
  Pro: MLX 66 ms, MPS 180 ms, CPU 1.1 s.
- **Memory.** On a 48 GB Mac the default budget (80%, 38.4 GB) fits models up to 12B in bf16 but
  not 26B-A4B.
- **Linux.** `auto` lets strands-decider pick `cuda` or `cpu`. FastFlowLM needs an AMD XDNA2 NPU
  and is not offered elsewhere.
- **launchd.** On macOS `local-decider gateway start` installs a LaunchAgent with `PATH`, `HOME`
  and the data-directory variables set, and reads tokens from `~/.config/local-decider/env` if it
  exists. Restarting uses `launchctl kickstart -k`.

## 5a. Automatic selection and fallback

`selection.mode: auto` lets the gateway choose the engine. Without it, the `selection` you saved
(or `engine.type` and `model`) is what runs, and nothing switches on its own.

```yaml
selection: { mode: auto }
```

**The ladder.** The gateway probes the host (AMD XDNA NPU, NVIDIA, Apple MLX and MPS) and ranks
the candidates, best first: AMD NPU (`fastflowlm`), NVIDIA CUDA, Apple MLX, Apple MPS, CPU.
Only calibrated engines are eligible, so `openai-compatible` and `lmstudio` are never chosen
automatically. A probe that cannot tell reports `unknown`, which does not count as available. The
ranking appears as `recommendation` in `GET /v1/engines`, apart from the active engine, and
`engine install` uses it to pick what to install and print why.

**Fallback.** In auto mode only, an infrastructure failure of the active engine (it fails to
start or dies, not a low-confidence answer) moves the gateway to the next installed, eligible
candidate:

- The failed engine is stopped before the replacement starts, so one model is loaded at a time.
- Nothing is downloaded during a decision. A candidate whose model is missing is skipped.
- Decisions fail open while the replacement loads. Decision caches are cleared on every switch.
- The failed candidate cools down for 30 s, doubling per repeated failure up to 15 min. A
  candidate that stayed healthy for 5 min starts again from 30 s. When the cooldown ends the
  gateway retries the higher-ranked engine, so it recovers without flapping.
- `GET /v1/engines` reports `active.selectionMode` (`auto` or `manual`) and, while a fallback is
  in effect, `active.fallback` with the `reason` and `retryAt`.

**A manual selection always wins.** Choosing an engine with `engine use`, `POST /v1/engine` or the
settings page saves a manual `selection` and leaves auto mode. A manual selection never falls
back. Setting `selection: { mode: auto }` in `config.yaml` turns auto mode back on.

## 6. openai-compatible: prompt mapping and caveats

The engine asks an OpenAI-style server to answer with exactly one option label, then reads the
probability of each option's first token from the response logprobs and normalises them into the
`/v1/systemone` answer. Anything that returns `top_logprobs` works: LM Studio, Ollama,
llama-server and `mlx_lm.server` (recipes in [install.md](install.md#openai-compatible-servers)).

- `api: chat` (default) sends a system and a user message and sets `logprobs: true` with
  `top_logprobs`. `api: completions` sends a plain prompt with `logprobs: <topLogprobs>`.
- `maxTokens` defaults to 1. Servers that emit no logprobs for one token need 8 plus a
  `promptSuffix`.
- `topLogprobs` defaults to 10 (2 to 20). `mlx_lm.server` rejects values above about 10.
- `extraBody` is merged into the request body first, so the engine's own fields win. Use it for
  server-specific switches, for example `chat_template_kwargs: { enable_thinking: false }` on
  `mlx_lm.server`.
- Options whose tokens are missing from the top logprobs make the engine refuse to answer when
  covered probability falls under `minCoverage` (default 0.5); the decision then fails open.
  `maxOptions` caps how many options one question may have.
- The token named by `tokenEnv` is sent only over `https` or to a loopback host. Redirects are
  refused. Error text has the token masked.
- Models are not downloaded by the gateway. `GET /v1/engines` lists the model ids the server
  reports at `/models`, with no sizes, and the configured model first. If the server is down, only
  the configured model is listed.
- **Accuracy.** The probabilities come from a general model's next-token distribution, not a
  tuned decision head. Treat them as uncalibrated, and measure with `local-decider stats` before
  you let a policy `act` on them.

Measured on an M5 Pro with Qwen3-1.7B 4-bit:

| Server | Result |
|---|---|
| `mlx_lm.server` | Chat and completions return logprobs at `max_tokens: 1`. The default template starts a `<think>` block; `chat_template_kwargs.enable_thinking: false` fixes it. `/no_think` alone does not. |
| LM Studio | With `max_tokens: 1` the chat and completions routes return `logprobs: null`. Chat needs `maxTokens: 8` and `promptSuffix: "/no_think"`. The completions route generated text but still no logprobs. `enable_thinking: false` did not suppress reasoning. |

**LM Studio limitation.** Only the GGUF build of `qwen3-4b-instruct-2507` gave usable logprobs
here. MLX models served by LM Studio return `null` logprobs, so the decision fails open. Load that
GGUF model, or use `mlx_lm.server` for MLX models.

The gateway does not start or stop LM Studio; start the server yourself.
