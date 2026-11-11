# Plan: prefer accelerated, power-efficient engines

Status: proposed (architect review, 2026-11-11). Rule from the user: always prefer accelerated
and power-efficient engines. On Linux, FastFlowLM NPU, then Vulkan/CUDA, then CPU. On macOS,
the same idea.

## Policy

Quality eligibility first, acceleration second. One gateway-owned selector feeds install, runtime
selection and UI recommendations. Explicit configuration and selection always win.

| Platform | Automatic preference |
|---|---|
| Linux with a supported AMD NPU | FLM NPU → eligible GPU backend → CPU |
| Linux with NVIDIA | CUDA → eligible Vulkan backend → CPU |
| Linux with another GPU | eligible Vulkan backend → CPU |
| Apple Silicon | MLX → MPS → CPU |
| Other hosts | validated accelerator → CPU |

- An accelerated but uncalibrated engine (`lmstudio`, `openai-compatible` with a general chat
  model) never outranks an eligible calibrated CPU engine automatically. Those stay explicit
  shadow choices.
- There is no Strands Vulkan device. Don't add a cosmetic `vulkan` option. Vulkan enters the
  ladder only with a validated, calibrated decision-model adapter. Until then the Linux fallback
  is effectively NPU → CUDA → CPU.
- `calibrated` is too coarse for automatic cross-model fallback. Eligibility belongs to the
  engine, model and backend combination and the policy thresholds.

## Detection

A new asynchronous `host-capabilities.ts` beside `engines/host.ts`. `HostInfo` stays cheap and
deterministic. `toolchain.ts` resolves executables, and capabilities are probed separately.

| Capability | Evidence and confirmation |
|---|---|
| AMD NPU | `/dev/accel/accel*` correlated with the sysfs driver and device. `amdxdna` alone is not enough. After install, `flm validate` and model readiness |
| NVIDIA | `/dev/nvidia*`, bounded `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`, then `torch.cuda.is_available()` in the selected environment |
| Apple | `darwin/arm64` makes it a candidate. Then MLX import and Metal, then MPS, in the selected environment |
| Vulkan | Optional bounded `vulkaninfo --summary`, excluding software devices. Also needs a compatible backend and model |

Probes use resolved executables, literal argv, `shell: false`, bounded output, 1–2 s timeouts
under a shared deadline, and fixed `python -I -c` scripts. Results are cached and invalidated on
tool or config changes. Any failure means unknown, and selection continues downward. The slow
`flm validate` never runs inside catalog requests or decisions.

## Where it applies

- **Config:** add an explicit automatic mode to `selection`. Existing selections keep manual
  semantics, and existing configs never switch engines silently.
- **Install:** CLI flags, then explicit config, then the automatic recommendation. Fresh installs
  pick FLM on a supported NPU, MLX on Apple Silicon, CUDA on NVIDIA, otherwise CPU. Install
  prepares and does not activate.
- **Models:** recommend Strands 2B and FLM `d3:mini`. Reject models that don't fit, including
  VRAM on discrete GPUs, rather than substituting.
- **`device: auto`:** resolve and pass the real device. Probe the environment of the resolved
  Strands executable, not always the managed venv.
- **Runtime fallback (automatic mode only):** descend through installed, eligible candidates after
  an infrastructure or startup failure. Never download during a decision, fail open while a
  replacement loads, use cooldown and backoff, run one model at a time, and clear decision caches
  on changes. Low confidence is not a failure.
- **UI and CLI:** the gateway supplies ordered candidates, the recommended target with a reason,
  readiness and the effective device. Paseo shows the recommendation separately from the active
  selection.
- **Health:** `requestedDevice`, `resolvedDevice` and the backend (`MLX`, `MPS`, `CUDA`, `CPU`,
  `NPU`). Today `strands/index.ts` hard-codes the tag `PyTorch`, which is wrong on MLX.

## Slices

| Slice | Anchors | Acceptance |
|---|---|---|
| P1 Device resolution and reporting | `strands/mlx.ts`, `strands/server.ts`, `types.ts`, `engine-control.ts` | Launch argv, memory checks and health agree on the resolved device. MLX no longer shows `PyTorch`. A custom executable uses its own environment |
| P2 Capability probes | `engines/host.ts`, `toolchain.ts`, new `host-capabilities.ts` | Fixtures cover absent tools, inaccessible devices, software Vulkan, timeouts and custom environments. The catalog never blocks on long validation |
| P3 Pure ranking | `engines/descriptor.ts`, `registry.ts`, new selector | The platform matrix produces the ladder. Explicit choices win. Uncalibrated candidates are never automatic defaults |
| P4 Install planning | `cli-engine.ts` `planInstall`, `engine-install.ts` `defaultFlavor`, `cli.ts` | Fresh NPU, Mac, NVIDIA and CPU plans pick the right engine, flavor and model. Overrides and `--no-download` keep their meaning. Install does not activate |
| P5 Automatic runtime fallback | config schema, `engine-control.ts`, supervised and lazy engines | Fake-engine tests prove bounded fail-open, preserved manual selection, cooldown, cache invalidation and one model at a time |
| P6 Presentation and docs | Paseo `shared/engines.ts`, `settings-engines.tsx`, engine and install docs, ADR-0008 | Ordering and recommendation render leniently against old gateways. Schemas regenerated. `mise run check` passes |

## Hardware acceptance

- **Mac:** actual child argv and backend under `auto`, MLX unavailable → MPS → CPU, explicit
  devices, a custom environment, launchd, and warm and cold latency.
- **tuxbox:** XDNA generation, permissions and `flm validate`, a fresh automatic FLM install,
  `d3:mini` against `d3:nano`, FLM failure falling back to CPU, recovery without oscillation, and
  concurrent hooks.
- CUDA needs NVIDIA hardware. tuxbox's AMD GPU can't validate it.

## Open choices

- FLM's automatic recommendation becomes `d3:mini` (recommended).
- FLM `pmode`: benchmark `balanced` against today's `performance`, then pick the lowest-power
  mode that meets hook p95 latency.
