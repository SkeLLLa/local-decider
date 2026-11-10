# Benchmarks

`local-decider bench --sizes 256,1024,2048,3800 --runs 5` against a running gateway: one
`choice` question (4 options, the turn-outcome question) over synthetic transcript state, after
one warm-up request per size. Latency is measured at the client, through the gateway.

## Linux PoC: AMD Ryzen AI 9 365, 61 GB, CPU only (2026-11-10)

`StrandsAgents/strands-decider-2B-qwen3.5-v1-2610`, `strands-decider serve --device cpu
--max-batch 8`, torch 2.15.0+cpu, fp32, strands-decider @ `846b69e`.

| target tokens | engine input tokens | p50 | p95 |
|---:|---:|---:|---:|
| 256 | 336 | 2,426 ms | 2,655 ms |
| 1,024 | 944 | 5,468 ms | 5,531 ms |
| 2,048 | 1,753 | 11,127 ms | 11,730 ms |
| 3,800 | 3,139 | 19,310 ms | 19,765 ms |

(A full 4,096-token state cannot be sent: the window is 4,096 tokens including the question.)

Roughly 2 s fixed plus 5.5 ms per token. Short real decisions (100–200 tokens) took 1.2–1.6 s.

What follows from it:

- On CPU the decider is a **shadow and asynchronous** tool: turn outcomes, routing hints and
  logging. It is too slow to gate every tool call synchronously; hooks give up after 1.5 s and
  fail open, while the gateway still finishes and logs shadow decisions.
- The default policies keep state small (`command-risk` 1,000 tokens, `routing` 1,500,
  `permission` 2,000, `turn-outcome` 3,000).
- Faster paths on this machine: the torch-free llama.cpp backend (Vulkan on the Radeon 880M) and
  encoder models (GLiClass measured 99 ms short / 455 ms at ~600 tokens on CPU); see
  [research/engines.md](research/engines.md).

## macOS (MLX)

Pending: to be run on the Apple M5 Pro (`--device mlx`). Upstream reports 113 ms at 222 tokens
for the 2B v19 model on an M4 Pro.
