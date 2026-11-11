# ADR-0008: One descriptor per engine, one registry

Status: accepted (2026-11-11)

## Context

Each engine id was written as a string in about a dozen places: the config schema and its
`selection` enum, `createEngine`, the switching and install code, the download and "is it
present" checks, the plugin's tag map and a special case for FastFlowLM in the settings page.
Adding an engine or a model meant editing all of them, and macOS (MLX, LM Studio, `mlx_lm.server`)
was an afterthought.

## Decision

- Every engine is a `defineEngine({...})` descriptor (`packages/gateway/src/engines/descriptor.ts`)
  that carries its id, label, description, tag, strict config schema, host support, devices,
  calibration flag, model catalogue, download and presence checks, optional validation and a
  `create` function.
- `engines/registry.ts` holds the list `ENGINES`. The config's `engine` union, the `engines:`
  options map, the selectable ids, `createEngine`, `engineDefaults`, the model catalogue,
  `GET /v1/engines` and the install and switch checks are all derived from it.
- `GET /v1/engines` and `/health` carry what the UI needs (`tag`, `description`, `calibrated`,
  `capabilities.validate`, `supported`, `unsupportedReason`, `engineTag`). The Paseo plugin renders
  from them and parses them leniently, with defaults for an older gateway.
- A fourth engine, `openai-compatible`, scores one option token from any OpenAI-style server's
  logprobs. It has no managed install and no download; its models are discovered from `/models`,
  and it is marked uncalibrated.
- A test fails when an engine id is missing from the table in [engines.md](../engines.md).

## Consequences

- Adding an engine is one directory plus one line in `ENGINES`; the settings page needs no change.
- Engine-specific behaviour (device lists, installers, validation) stays inside the engine's
  descriptor, not in shared code that checks ids.
- `openai-compatible` probabilities are not calibrated against the policy thresholds, so policies
  using it should stay in `shadow` until measured. The gateway does not manage LM Studio's
  lifecycle; the user starts the server.
- **Automatic selection (2026-11-11).** `selection.mode: auto` opts in to ranking and fallback;
  the default stays manual. `engines/selector.ts` ranks registry engines on the ladder NPU, CUDA,
  MLX, MPS, CPU from cached capability probes (`unknown` is not available) and skips uncalibrated
  engines. Only in auto mode does an infrastructure failure of the active engine move the gateway
  to the next installed candidate, with a per-candidate cooldown that doubles and resets after
  sustained health. A manual selection always wins and never falls back.
  `GET /v1/engines` reports `recommendation`, `active.selectionMode` and `active.fallback`.
- LM Studio's MLX models return `null` logprobs; only the GGUF `qwen3-4b-instruct-2507` is usable,
  and the engine stays uncalibrated and never auto-selected.
- The registry is compile-time. There is no plugin loading of third-party engines.
