# Benchmarks

All numbers were measured on one machine: an AMD Ryzen AI 9 365 with 61 GB RAM, on 2026-11-10.
Your hardware and models will give different numbers.

Method: `local-decider bench --sizes 256,1024,2048,3800 --runs 5` against a running gateway.
One `choice` question (4 options, the turn-outcome question) over synthetic transcript state,
after one warm-up request per size. Latency is measured at the client.

## Benchmark your machine

Numbers below are one machine's. Measure yours: a run times every installed model on every
runtime, one at a time, with short, typical and long prompts, and saves the results for the
recommendation.

**In the Paseo plugin.** Settings, Local decider, **Benchmark this machine**. Run benchmark, Cancel,
Finish benchmark (measures only what is missing) and Run again live on the card; the results are
grouped by model family with a Use fastest button each. See the
[plugin overview](../packages/paseo-plugin/OVERVIEW.md#benchmarks).

**On the command line.** The gateway must be running.

```fish
local-decider bench
local-decider bench --installed
local-decider bench --family vllm-sr/d3-mini
local-decider bench --engines fastflowlm:d3:mini,llama-vulkan:d3-mini-q4_k_m
local-decider bench --engines strands-decider:StrandsAgents/strands-decider-2B-qwen3.5-v1-2610@cuda
local-decider bench --installed --missing --sizes 256,1024,3800 --runs 5 --json
```

| Flag | Meaning |
|---|---|
| none | Benchmark the engine that is running now (the result is saved too). |
| `--installed` | Every installed, downloaded model that fits, on every runtime. Custom servers (OpenAI-compatible, LM Studio) are skipped. |
| `--family ID` | The same, restricted to one model family. |
| `--engines ENGINE:MODEL[@DEVICE],...` | Explicit targets, at most 32. The model is everything after the first `:`, so `fastflowlm:d3:mini` is model `d3:mini`. `@DEVICE` (`cpu`, `mlx`, `mps`, `cuda`) is read only when it is a real device; strands-decider needs one. |
| `--missing` | Drop targets that already have a fresh, ranked result. |
| `--sizes 256,1024,3800` | Prompt sizes in tokens, whole numbers from 64 to 8,192, at most 6. 1,024 is always measured. |
| `--runs 5` | Timed runs per size, 1 to 20. One or two runs are saved as provisional and do not rank anything. |
| `--json` | Print only the final job as JSON. |

Use at most one of `--installed`, `--family` and `--engines`; mixing them is a usage error.

The command prints a header (`bench <url> targets=<n> sizes=<...> runs=<n>`) and one line per
target (`fastflowlm d3:lite (NPU)`). Then, as each target finishes, it prints that target's name
again with its load time and one line per size
(`1024 tok (engine 978): p50 532 ms, p95 541 ms, answer=done`, with `provisional` added when
the run count is under 3), or `failed: <error>` for a target that did not work. A target that was
interrupted reads `not measured (cancelled)` and one the job never reached reads `not run`. At the
end it prints `restored <engine> <model>` or `restore failed: <error>`, then `cancelled (<reason>)`
or `benchmark failed: <error>` when the job ended that way. With `--json` nothing is printed until
the job ends, then only the final job.

A run calls the engine directly, past the decision cache, queue and shadow log, so its numbers can
be a little lower than the older figures below, which went through `/v1/systemone`.

| Exit code | When |
|---:|---|
| 0 | The job finished and at least one target succeeded. |
| 1 | Every target failed, the job failed, someone else cancelled it or a selection change preempted it, a benchmark was already running or the request was refused (409 or 401), or the gateway was not reachable. |
| 2 | Usage error. |
| 130 | Ctrl-C. |

**Ctrl-C** cancels the job on the gateway and waits up to 30 s for it to end, then exits with
130 either way; what finished is kept. A second Ctrl-C exits at once and leaves the gateway to
finish the cancel.

**While it runs**, decisions fail open (`engine benchmark running`), so hooks and agents carry on
without an answer, and the previous engine is restored afterwards. A run takes minutes, longer on
the CPU and when engines must load. Results are from this machine only; see
[engines](engines.md#5b-model-families-and-the-recommendation).

**API.** All three routes are control routes: they need the control token (the
`x-local-decider-control` header, or the bearer token when `LOCAL_DECIDER_TOKEN` is set).

| Route | Does |
|---|---|
| `GET /v1/benchmark` | The job's state, phase, targets and results, and a preview of what the next run would do. |
| `POST /v1/benchmark` | Starts a job; 202 with its view. Fields are all optional: `scope` (`installed`, `family`, `active`), `family`, `targets`, `only: "missing"`, `sizes`, `runs`, `client`. 400 for a bad body, 409 when a job is running or nothing is left to measure. |
| `POST /v1/benchmark/cancel` | Cancels the running job; 202. 409 when none runs. |

**Where results are kept.** `~/.local/share/local-decider/benchmarks.json`, a 0600 file in a 0700
directory, written atomically, at most 500 records (the oldest are dropped first). A file that is
too large, damaged or from an unknown version is moved aside as `benchmarks.json.corrupt-<time>`
and the store starts empty. Delete the file to forget all results.

## Strands 2B on CPU

`StrandsAgents/strands-decider-2B-qwen3.5-v1-2610`, `strands-decider serve --device cpu
--max-batch 8`, torch 2.15.0+cpu, fp32, strands-decider @ `846b69e`.

| Target tokens | Engine input tokens | p50 | p95 |
|---:|---:|---:|---:|
| 256 | 336 | 2,426 ms | 2,655 ms |
| 1,024 | 944 | 5,468 ms | 5,531 ms |
| 2,048 | 1,753 | 11,127 ms | 11,730 ms |
| 3,800 | 3,139 | 19,310 ms | 19,765 ms |

- Roughly 2 s fixed plus 5.5 ms per token. Short real decisions (100–200 tokens) took 1.2–1.6 s.
- A full 4,096-token state cannot be sent: the window is 4,096 tokens including the question.
- On CPU the decider is a shadow and background tool. Hooks give up after 1.5 s and fail open;
  the gateway still finishes and logs shadow decisions.
- The default policies keep state small: `command-risk` 1,000 tokens, `routing` 1,500,
  `permission` 2,500, `turn-outcome` 3,000.

## FastFlowLM 1.0.12 on the XDNA2 NPU

Same machine and benchmark, `flm serve --decision <model>` (portable build, `--pmode
performance`), measured directly against FLM's `/v1/systemone`.

| Target tokens | Engine tokens | d3:lite p50 / p95 | d3:nano p50 / p95 | Strands 2B CPU p50 |
|---:|---:|---:|---:|---:|
| 256 | 370 | 228 / 237 ms | 325 / 346 ms | 2,426 ms |
| 1,024 | 978 | 532 / 541 ms | 764 / 887 ms | 5,468 ms |
| 2,048 | 1,787 | 929 / 960 ms | 1,351 / 1,379 ms | 11,127 ms |
| 3,800 | 3,173 | 1,646 / 1,678 ms | 2,367 / 2,400 ms | 19,310 ms |

- 7–11× faster than the 2B on CPU at every size. A lazy model load takes about 5 s.
- Through the gateway (redaction, state shaping, queue, rules), a short decision took 250 ms on
  d3:nano and about 600 ms on d3:mini.
- d3:mini answered all six integration cases correctly with p ≥ 0.91 (turn outcome done and
  needs_input, command risk dangerous and safe, permission allow and deny). That includes
  `cat README.md` at p(allow) = 0.97, above the 0.95 auto-allow bar the 2B missed (0.93).
- d3:mini is the recommended FastFlowLM model and d3:nano the fast one.

## GPU (Radeon 880M iGPU) against the NPU

Measured on 2026-11-12 on the same machine with `local-decider bench --sizes 256,1024,2048,3800
--runs 5` through the gateway, after `local-decider engine use <engine> <model>`. llama.cpp
b12110 (v0.9.0) Vulkan build from mise. Strands ran on `torch 2.14.1+rocm7.2` in a scratch venv,
measured directly against `strands-decider serve --device cuda`. Every number is p50.

| Target tokens | Vulkan d3-lite Q8_0 | NPU d3:lite | Vulkan d3-mini Q4_K_M | Vulkan d3-mini Q8_0 | NPU d3:mini | NPU d3:nano | Strands 2B ROCm | Strands 2B CPU |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 256 | 141–184 ms | 208–232 ms | 817 ms | 701 ms | 721 ms | 335 ms | 596 ms | 2,426 ms |
| 1,024 | 394–529 ms | 482–555 ms | 2,307 ms | 2,008 ms | 1,687 ms | 760 ms | 1,419 ms | 5,468 ms |
| 2,048 | 977 ms | 934 ms | 4,316 ms | 3,863 ms | 3,038 ms | 1,345 ms | 2,658 ms | 11,127 ms |
| 3,800 | 1,550–1,991 ms | 1,509–1,693 ms | 8,717 ms | 7,745 ms | 5,322 ms | 2,353 ms | 4,915 ms | 19,310 ms |

Ranges come from interleaved runs (Vulkan, NPU, Vulkan, NPU) under the same load.

- **d3-lite:** the Vulkan GPU is 15–35% faster on short states. From about 2k tokens the GPU and
  NPU are level. GPU p95 is noisier, because the integrated GPU is shared with the desktop
  compositor and Electron apps. The NPU is not shared and its p95 stays close to its p50.
- **d3-mini:** the NPU is faster than Vulkan Q4_K_M at every size, by 1.1× at 256 tokens and 1.6×
  at 3,800.
- **Q8_0 against Q4_K_M on Vulkan:** d3-mini Q8_0 is about 13–14% faster than Q4_K_M at 256 and
  1,024 tokens, and about 11% faster at 2,048 and 3,800. Its p95 is noisy, up to 10.6 s at 3,800
  tokens. The NPU d3:mini is still faster from 1,024 tokens up.
- **llama.cpp builds:** b12110 and b12318 gave the same `llama-bench` prompt throughput on d3-lite
  Q8_0 (about 2,370 tokens/s at pp512).
- **Strands 2B on ROCm:** about 4× faster than on the CPU. Setting
  `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1` improved long states by about 25%. The engine has
  no ROCm flavour yet; this ran outside `engine install`.

## Other paths

- **macOS (MLX):** not measured yet. Upstream reports 113 ms at 222 tokens for the 2B v19 model
  on an M4 Pro.
- **Encoder models:** GLiClass measured 99 ms on a short state and 455 ms at about 600 tokens on
  this CPU. There is no engine adapter for it; it can be reached as a `systemone-remote` server.
