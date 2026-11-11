# Benchmarks

All numbers were measured on one machine: an AMD Ryzen AI 9 365 with 61 GB RAM, on 2026-11-10.
Your hardware and models will give different numbers.

Method: `local-decider bench --sizes 256,1024,2048,3800 --runs 5` against a running gateway.
One `choice` question (4 options, the turn-outcome question) over synthetic transcript state,
after one warm-up request per size. Latency is measured at the client.

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

## Other paths

- **macOS (MLX):** not measured yet. Upstream reports 113 ms at 222 tokens for the 2B v19 model
  on an M4 Pro.
- **Encoder models:** GLiClass measured 99 ms on a short state and 455 ms at about 600 tokens on
  this CPU. There is no engine adapter for it; it can be reached as a `systemone-remote` server.
