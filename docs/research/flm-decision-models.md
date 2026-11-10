# FastFlowLM decision models (d3) on the XDNA2 NPU: research notes

Researched 2026-11-10 for the gateway's `/v1/systemone` engines. Machine: Ryzen AI 9 365 (Strix
Point, XDNA2 NPU), Radeon 880M, 61 GB RAM, Linux, FastFlowLM (FLM) 1.0.12 portable build.
Nothing was run for this note: no `flm`, no gateway, no model download.

Legend: **[verified]** I read it in a doc, a repo, a model card or the model's own runtime code.
**[reported]** A third party's number (a leaderboard, a benchmark README, a blog post).
**[unverified]** My inference, or a claim I could not check.

Sources:

- FLM release notes: `gh release view v1.0.11 -R FastFlowLM/FastFlowLM` (2026-10-29) and v1.0.12
  (2026-11-05). The repo redirects to `ROCm/FastFlowLM`.
- FLM docs: <https://fastflowlm.com/docs/models/d3/> and
  <https://fastflowlm.com/docs/benchmarks/d3_results/>.
- HF model cards and runtime: `vllm-sr/d3-{edge,lite,nano,mini,flash,turbo,ultra}` and `vllm-sr/d3`.
  I read `d3_runtime.py`, `d3_server.py` and `decision_config.json` from `vllm-sr/d3-edge`.
- Leaderboards: the Jev Decision Index 0.4.1 data file (`multimodalart/jev-decision-index`,
  `data/index.json`, generated 2026-11-06), `LocalLLaMA/typed-decisions`,
  `harness-hub/safeagents-judge-bench` and `choyiny/decidebench`.

---

## 1. The d3 family

d3 ("Decision 3.0") is vLLM Semantic Router's decision model family, "the decision model vLLM
Semantic Router calls for routing, guardrails and tool selection" **[verified FLM docs]**.

How it works **[verified `d3_runtime.py`]**: a Qwen3.5 backbone whose full-attention layers run
non-causally; the prompt lists every option under a single-token answer code (`A`, `B`, ...
`AA` ...), and a 255-way FP32 readout scores those codes at the last position (softmax at the
package temperature, 1.0; no text generated, `output_tokens: 0`). Each question is its own forward
pass over state plus question: edge to flash have no shared-prefix KV fork like Strands Decider;
turbo and ultra ("prefix-bidirectional") encode the state once per request. All tags are
Apache-2.0 and ungated **[verified HF API]**. FLM ships Q4_K, GPTQ-calibrated on synthetic
questions with "no Decision Index data" **[verified FLM docs]**.

| FLM tag | HF id | backbone | params | FLM download | FLM peak memory | FLM ≥ |
|---|---|---|---|---|---|---|
| `d3:edge` | `vllm-sr/d3-edge` | Qwen3.5-0.8B cut to 12 layers | 0.59B (0.10B vision) | ~0.58 GiB | 2.0 GB after load, 4.8 GB at 32k | 1.0.12 |
| `d3:lite` | `vllm-sr/d3-lite` v3.1.3 | Qwen3.5-0.8B | 0.85B | ~0.72 GiB | not stated | 1.0.11 |
| `d3:nano` | `vllm-sr/d3-nano` v3.1.3 | Qwen3.5-2B | 2.2B | ~1.9 GiB | ~5.3 GB at 32k | 1.0.11 |
| `d3:mini` | `vllm-sr/d3-mini` v3.1.3 | Qwen3.5-4B | 4.5B | ~3.2 GiB | ~8.6 GB at 32k | 1.0.11 |
| `d3:flash` | `vllm-sr/d3-flash` | Qwen3.5-9B | 8.4B | ~5.7 GiB | 6.8 GB after load, 14.1 GB peak | 1.0.12 |
| `d3:turbo` | `vllm-sr/d3-turbo` v1.1 | Qwen3.5-27B, prefix-bidirectional | 26.1B | ~15.4 GiB | 17.4 GB (≤4k) to 26.3 GB (32k); plan for 28 GB | 1.0.11 |
| `d3:ultra` | `vllm-sr/d3-ultra` | newer fine-tune of turbo's architecture | 26.1B | ~15.4 GiB | 27.0 GiB at 32k | 1.0.11 |

**[verified FLM docs, HF cards and the Decision Index `served_params`]**

- `vllm-sr/d3` (27B, on a Qwen3.8-27B base per its card) is not an FLM tag.
- The vLLM Semantic Router HF org also publishes Decision 1.0 and 2.0 models, Vela encoders and
  ModernBERT classifiers. FLM serves none of them.

**Inputs** **[verified]**: all tags take text and images; turbo and ultra add videos (FFmpeg
shared libraries needed), `assets`, and `box` / `track` questions. ultra's `header-v1` layout lists
every question before the state, and its temperature is 1.046 for one question, 1.0 for more.

**FLM latency.** The test machine is a Ryzen AI MAX+ PRO 395 (Strix Halo) with 128 GB. One
question per request; edge and flash are measured over HTTP, the others at the engine
**[verified FLM benchmark page]**.

| tag | 128 tok | 330 tok | 1,024 | 2,048 | 4,096 | 32,768 | 4 q × 330 | 16 q × 330 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| edge | 60 ms | 83 ms | 263 ms | 467 ms | 1.0 s | 16.9 s | 291 ms | 1.05 s |
| lite | 109 ms | 151 ms | 430 ms | 765 ms | 1.6 s | 22.7 s | 536 ms | 2.07 s |
| nano | 210 ms | 252 ms | 584 ms | 1.16 s | 2.47 s | 28.4 s | 796 ms | 2.89 s |
| mini | 473 ms | 536 ms | 1.32 s | 2.60 s | 5.28 s | 66.5 s | 1.77 s | 6.58 s |
| flash | 846 ms | 983 ms | 2.34 s | 4.51 s | 9.01 s | 96.1 s | 3.14 s | 11.7 s |
| turbo | 2.85 s | 3.22 s | 6.86 s | – | 27.4 s | 314 s | 6.09 s | 9.52 s |
| ultra | 3.10 s @241 | – | 9.5 s @1,131 | – | 31 s @4,201 | ~5 min | – | 12.8 s |

Cost is linear in questions for edge to flash; only turbo and ultra amortise the state. From
1,536 tokens attention runs on the NPU (the first such request loads a kernel, ~0.1 s, and a
second hardware context) **[verified]**. **This machine is Strix Point, not Strix Halo.** FLM's
LFM2 page says Strix Point "is comparable to other Strix Point and Strix Halo systems" **[verified
quote]**, but the 27B tags stream 15 GiB of weights per pass and should be slower on the 365's
narrower memory bus **[unverified]**. Re-measure before trusting any row (§6). For scale, upstream
on one MI325X: d3-edge 6.6 ms and the 27B d3 54 ms per text request **[verified card,
vendor-measured]**.

**Training data.** The cards say nothing beyond "trained on AMD Instinct MI325X GPUs" **[verified:
absence]**; there is no arXiv report. A third-party PR titles the release "Towards Open Multimodal
Foundation Decision Models" (2026-10-10) **[reported]**.

---

## 2. Papers and reports behind decision ("System One") models

| work | id / URL | what it says that matters here |
|---|---|---|
| vLLM Semantic Router: Signal Driven Decision Routing for Mixture-of-Modality Models | arXiv:2603.04444 | The router architecture: signals (keyword, embedding, domain classifier, ...) composed by Boolean rules into decisions, then per-decision plugin chains. It predates d3 and has no d3 numbers **[reported, search summary]** |
| When to Reason: Semantic Router for vLLM | arXiv:2510.08731 | Routing reasoning vs. non-reasoning mode: +10 pt on MMLU-Pro with about 50% fewer tokens **[reported]** |
| Workload-Router-Pool vision paper | arXiv:2603.21354 | Architecture vision, no decision-model accuracy **[reported]** |
| Narrow Decision Models: A System-1 Architecture for Calibrated, Typed Decisions | arXiv:2610.25553 | Training with proper scoring rules through a curriculum, calibration and abstention **[reported, abstract]** |
| Benchmarking System One decision models against trained classifiers and LMs for decision gates | arXiv:2610.00346 | See below **[reported, abstract]** |
| TypedBench | arXiv:2610.11392 | Hosted model "systematically underconfident". Decoders (0.8B–9B) lose accuracy as options grow and are weakest on policy questions. Judge models jointly on policy adherence, wording robustness and probability quality **[reported, abstract]** |
| Laya | preprint doi:10.20944/preprints202611.0781.v1; arXiv:2503.23303, 2510.01237 (precursors); independent reproduction arXiv:2609.33843 | ModernBERT encoder plus a head trained with RLCD (proper-scoring-rule RL). Base checkpoint 0.362 on typed-decisions (prior 0.470); 0.766 after fine-tuning on its train split **[reported]** |
| GLiClass | arXiv:2508.07662 | GLiNER-style joint label+text encoding: one pass, embedding-class speed **[verified abstract]** |
| decidecall | <https://zenodo.org/records/23470228> (doi:10.5281/zenodo.23470228) | Claude Code plugin: cache → rules → local decision model (strands-decider / OpenJev / JevK5 via systemone, or ollama) → cheap cloud model → strong model → person. Stops at the first link whose calibrated confidence clears 0.95; two agreeing links settle a less sure answer. Its `bench` reports ECE and coverage per link **[verified record]** |
| Strands Decider | HF cards `StrandsAgents/*` | 2B: JevBench 180/231, Brier 0.280, ECE 0.072. E4B: 187/231, Brier 0.243, ECE 0.037, Decision Index 0.2.1 balanced skill 39.42. One temperature per primitive, fitted on held-out short tasks; long multi-step documents are the weak spot **[verified cards]** |

arXiv:2610.00346 in more detail **[reported, abstract]**: a fine-tuned DeBERTa-v3-large beats every
decision model on labelled tasks; swapping yes and no flips 50.5 answers in 100 for the hosted Jev
and ≥ 16.8 for generic LLMs, against ≤ 6.5 for fine-tuned decision checkpoints; an intent-trained
first stage escalating to Gemma-4-31B reached the large model's accuracy at about Jev's price.

The awesome lists (AnotiaWang/awesome-decision-models, raullenchai/awesome-system-one,
Haple/system-one) are indexes, not evidence. They point at the leaderboards in §3 and at
Laya/Clef/Kev ports, including llama.cpp `llama-server` serving decision models at
`/v1/systemone` **[verified READMEs]**.

**Model size against accuracy.** The sources agree: on typed-decisions, the Decision Index and
DecideBench, accuracy climbs steeply from 0.6B to 4B, then flattens. Rule-following and arithmetic
stay weak even at 27B (DecideBench `rollout_gate`: no decision model above 74%, Opus 4.8 100%), and
encoders (Laya, GLiNER-Decide) are near chance on DecideBench v2 (26–41% vs 25% random)
**[reported]**.

---

## 3. d3 against Strands Decider, Laya and others; calibration

**Jev Decision Index 0.4.1** (community board, RTX PRO 6000, generated 2026-11-06)
**[reported; extracted from `data/index.json`]**. *Balanced* is the headline chance-corrected
skill, *public* the public-suite skill, *tools* the tools-area skill (closest to permission and
routing); ECE takes "the probability placed on the chosen option" as confidence, over 32
benchmarks.

| entry | params | balanced | public | ECE | acc / mean conf | tools |
|---|---:|---:|---:|---:|---|---:|
| d3-ultra | 26.1B | 70.18 | 71.57 | 0.067 | 0.81 / 0.88 | 0.88 |
| d3-turbo v1.1 | 26.1B | 67.31 | 71.62 | 0.052 | 0.80 / 0.85 | 0.87 |
| d3-flash | 8.4B | 54.27 | 57.79 | 0.056 | 0.74 / 0.78 | 0.76 |
| d3-mini | 4.5B | 49.97 | 54.90 | 0.056 | 0.73 / 0.78 | 0.72 |
| LiquidAI d1-2B | 1.9B | 34.39 | 51.10 | 0.012 | 0.72 / 0.72 | 0.75 |
| d3-nano | 2.2B | 34.30 | 42.22 | 0.112 | 0.65 / 0.76 | 0.59 |
| GLiClass v4 edge | 0.44B | 31.21 | 47.49 | 0.089 | 0.68 / 0.76 | 0.58 |
| vela3-fast (vLLM-SR encoder) | 0.38B | 29.27 | 50.36 | 0.121 | 0.68 / 0.79 | 0.74 |
| d3-lite | 0.85B | 26.16 | 36.93 | 0.094 | 0.61 / 0.70 | 0.56 |
| **Strands Decider 2B** (hobson-v21 per a third party) | 1.9B | 20.72 | 25.41 | 0.044 | 0.54 / 0.58 | 0.44 |
| d3-edge | 0.59B | 17.69 | 28.82 | 0.141 | 0.55 / 0.69 | 0.43 |
| Laya | 0.42B | 9.21 | 6.19 | 0.140 | 0.38 / 0.52 (coverage 0.76) | 0.06 |

Strands E4B is not on the 0.4.1 board; its card gives 0.2.1 balanced 39.42, an older edition that
is not comparable **[verified card]**.

**typed-decisions** (`LocalLLaMA/typed-decisions`, 400 cases / 2,000 decisions, zero-shot;
includes an `agent_trace_observability` suite) **[reported]**:

| model | acc | Brier | ECE |
|---|---:|---:|---:|
| d3-turbo | 0.736 | 0.162 | 0.069 |
| d3-mini | 0.743 | 0.123 | 0.047 |
| d3-flash | 0.717 | 0.131 | 0.031 |
| d3-nano | 0.629 | 0.211 | 0.113 |
| d3-lite | 0.531 | 0.244 | 0.130 |
| d3-edge | 0.425 | 0.456 | 0.341 |
| prior (ignores the input) | 0.470 | 0.189 | 0.088 |

Strands is not listed; Laya reaches 0.766 only when fitted on `train`. **d3-edge is below the
prior and badly calibrated here.**

**safeagents judge bench v0** (`harness-hub/safeagents-judge-bench`) **[reported]**: 562 real
coding-agent tool calls (523 block, 39 allow) plus scanner findings, asked as a noul "block?" and a
7-way category choice; the closest public set to `command-risk` and `permission`. At P(block) ≥
0.5, d3-mini scores balanced accuracy 0.692, AUROC 0.975, recall 1.0 and **false-block rate
0.615**. AUROC: nano 0.878, lite 0.793, edge 0.849, flash 0.953, turbo 0.991, ultra 0.994;
false-block rates 0.44–0.62 across tags. The scores rank calls well but 0.5 is the wrong cut-off:
tune thresholds per policy (39 allow rows make the false-block rate noisy).

**DecideBench v2** lists d3 only as the hosted 26B FP8 `s1-pro`: 91.6% overall, 98% on both
`agent_routing` and `action_review`. "Decider-2B" there scores 31.8%. I could not confirm it is
Strands; it may be `Mapika/decider` **[reported / unverified identity]**. No JevBench result
exists for d3 **[unverified: none found]**.

**Is d3 calibrated?** Mostly yes from mini up: ECE about 0.03–0.07 on typed-decisions and the
Decision Index **[reported]**; lite and nano are fair (0.09–0.13), edge is poor. Those are BF16
upstream numbers. FLM's Q4_K builds agree with BF16 on top-1 for 90.5% (lite), 93.8% (edge), 96.5%
(nano), 97% (mini, flash) and 98.9% (turbo) of answers, with Decision Index sample scores within
±1–2.6 pt **[verified FLM benchmark page]**. No calibration numbers exist for the NPU builds
themselves **[unverified]**.

### Confidence definitions differ, and this matters for the gateway

| server | `choice` confidence | `score` confidence | `noul` |
|---|---|---|---|
| Strands Decider | (N·p_max − 1)/(N − 1) | (σ_max − σ)/(σ_max − σ_floor) | `noul` only, no confidence |
| d3 runtime (`d3_runtime.py`, `_confidence`), so FLM, whose answers are "byte-identical to the upstream runtime" | **1 − H(p)/ln N** (one minus normalised entropy) | the same entropy formula | `noul` only, no confidence |
| vLLM `/v1/systemone` serving d3 (card) | p_max | – | adds `probabilities: {yes, no}` and `confidence = p(yes)` |
| Laya | 1 − normalised entropy, plus `answer_confidence = p_max` | same | – |

**[verified: Strands from engines.md; d3 from source and docs]**

FLM's own example matches the entropy formula: `route` 0.996 / 0.001 / 0.003 reports 0.977
(entropy ≈ 0.975, Strands would give 0.994); `anger` 0.209 / 0.525 / 0.266 reports 0.073 (entropy
0.074). The entropy definition is much stricter in the middle of the range. With 4 options at
0.7 / 0.1 / 0.1 / 0.1, Strands gives 0.60 and d3 gives 0.32.

`packages/core/src/systemone.ts` uses `wire.confidence ?? choiceConfidence(...)` (and the same for
score) **[verified]**. With FLM as the engine, every `minConfidence` rule in `policies/*.yaml`
would therefore be read on the entropy scale and would rarely fire. **Recompute confidence from
`probabilities` in the gateway and ignore the engine's field.** Keep the engine's value only as
`rawConfidence` for logging.

---

## 4. API compatibility: FLM `/v1/systemone` against the Strands contract

Request and response, quoted from the FLM d3 page **[verified]**:

```sh
curl -s http://127.0.0.1:52625/v1/systemone -H "Content-Type: application/json" -d '{
  "state": "The order arrived damaged yesterday. The customer has a receipt and asks for a replacement today.",
  "questions": {
    "route":   {"type": "choice", "instructions": "Which team should handle this?",
                "criteria": {"returns": "Refunds, replacements and damaged deliveries",
                             "billing": "Payments, invoices and charges",
                             "general": "Anything else"}},
    "urgent":  {"type": "noul", "instructions": "Does this need a reply today?"},
    "anger":   {"type": "score", "instructions": "How upset is the customer?", "criteria": ["calm", "annoyed", "angry"]}
  }
}'
```

```json
{"model":"d3-lite","answers":{
  "route":{"type":"choice","choice":"returns","probabilities":{"returns":0.996,"billing":0.001,"general":0.003},"confidence":0.977},
  "urgent":{"type":"noul","noul":0.766},
  "anger":{"type":"score","score":1.057,"probabilities":{"0":0.209,"1":0.525,"2":0.266},"confidence":0.073,"legend":{"0":"calm","1":"annoyed","2":"angry"}}},
 "usage":{"input_tokens":342,"output_tokens":0}}
```

```sh
curl -s http://127.0.0.1:52625/v1/systemone/models
# {"object":"list","data":[{"id":"d3:lite","object":"model","api":"systemone","max_input_tokens":32768,
#  "modalities":["text","image"],"image_max_pixels":1638400}]}
```

The two contracts side by side:

| aspect | Strands `strands-decider serve` | FLM d3 | gateway impact |
|---|---|---|---|
| routes | `POST /v1/systemone`, `/invocations`, `GET /health`, `/ping` | `POST /v1/systemone` (alias `/v1/decisions`), `GET /v1/systemone/models`; port 52625 **[verified]** | probe `/v1/systemone/models` for health and `max_input_tokens`. FLM `/health` is **[unverified]**. Upstream `d3_server.py` uses `/health` and `/v1/models` instead |
| `state` | required | optional, any JSON | none |
| `instructions` | required | optional (the docs' second example omits it) | none |
| `criteria` | choice 2..255, score 2..10, noul keys ⊆ {true,false} | same limits; noul criteria may only be `true`/`false` **[verified source]** | none |
| unknown fields | pydantic | 422 `{"detail": ...}`; nothing runs **[verified]** | send only `state`, `questions` and optionally `model` |
| malformed question | 422 | 422 `{"detail": {"invalid_questions": {"<id>": "<reason>"}}}` | map to an engine error |
| input too long | **422 for the whole request**, 4,096-token window | **200 with a per-question answer `{"type", "error": "max_length_exceeded", "message"}`**, 32,768 tokens per question, nothing truncated. Other questions are still answered | `normaliseChoice` would call `argmax(undefined)`: **treat an answer that has `error` as missing** |
| other per-question errors | – | `invalid_question` / `invalid_model_output` with `reason` codes (`question_malformed`, `question_tokens`, `model_output`, ...) **[verified]** | same handling |
| `usage` | `output_tokens: 1`, server adds `latency_ms` | `output_tokens: 0`; the docs' example has no `latency_ms` | measure latency in the gateway (it already does) |
| `confidence` | Strands formulas | 1 − normalised entropy | recompute (§3) |
| multi-question cost | shared-prefix KV fork | one pass per question (edge–flash); state once (turbo/ultra) | keep one question per policy, as now |
| concurrency | one request at a time recommended | NPU serves one request at a time. A decision queued behind a chat completion on the same server waited 12.7 s against 146 ms alone. A second `flm serve` contends for the NPU **[verified]** | keep one in flight; put synchronous hook policies ahead of asynchronous ones |
| auth | none | none documented for FLM. Upstream `d3_server.py` supports `DECISION_API_KEY` | bind 127.0.0.1 |
| images | `--vision` only | `images` (data URLs ≤ 8 MB); the first image request loads the vision tower | not used |

---

## 5. Generic FLM chat models as logprob engines

FLM support **[verified 1.0.11 notes]**: `logprobs` / `top_logprobs` (0–100) on
`/v1/chat/completions`, taken before penalties and constraints; `continue_final_message: true` with
`max_tokens: 1` scores an answer through the chat template (refused on gpt-oss and the single-turn
`*-flash` models); the prefix cache keeps up to 8 prompts, so a fixed policy system prompt is reused.

Prefill speed for small NPU models. FLM measured these on a Ryzen AI 7 350 (Kraken Point); the
LFM2 page also lists Strix Point at about the same speed **[verified FLM benchmark pages]**:

| FLM tag | prefill tok/s @1k | ≈ time to first token @1k | prefill @4k |
|---|---:|---:|---:|
| `llama3.2:1b` | 1,686 | 0.6 s | 2,339 |
| `lfm2:1.2b` | 1,537 | 0.65 s | 2,521 |
| `qwen3:0.6b` | 1,494 | 0.67 s | 2,165 |
| `lfm3:1.7b` | 1,092 | 0.9 s | 1,467 |
| `gemma3:1b` | 1,004 | 1.0 s | 1,546 |
| `qwen3:1.7b` | 956 | 1.05 s | 1,434 |
| `qwen3.5:0.8b` | 851 | 1.2 s | 1,744 |
| `qwen3.5:2b` | 626 | 1.6 s | 1,198 |
| `qwen3:4b` / `qwen3.5:4b` | 509 / 322 | 2.0 / 3.1 s | 615 / 543 |

`qwen3.5-flash:2b` reaches a 0.49 s time to first token at 1k, but cannot use
`continue_final_message` **[verified 1.0.12 notes]**.

**Verdict: not worth it as a primary engine** **[unverified judgement, from the numbers]**. d3 is
as fast or faster (lite 0.43 s, edge 0.26 s at 1k) and was trained for exactly this readout. Raw
LLM option logprobs are uncalibrated and order-sensitive (arXiv:2610.00346: ≥ 16.8 flips per 100
on a yes/no swap), and an untuned base loses accuracy (Qwen3.8-27B zero-shot 0.661 on
typed-decisions vs d3-turbo 0.736 **[reported]**). Keep `llm-logprobs` as a cross-check or
fallback (`qwen3:0.6b` or `llama3.2:1b` with a fitted temperature). `gpt-oss-safeguard` is in FLM's
catalog, but it is a generative policy reasoner, too slow for a hook, and gpt-oss refuses
`continue_final_message` **[verified notes; judgement unverified]**.

---

## 6. Recommendation for this machine

Constraints: hooks fail open after 1.5 s (Paseo routing ~2 s); the NPU runs one request at a time;
FLM serves one `--decision` model per server; real states are usually well under the `maxTokens`
caps (commands and permission requests 150–600 tokens, routing prompts 100–800 **[unverified
estimate]**).

| policy | caps / timing | pick | why | alternative |
|---|---|---|---|---|
| `command-risk` | 1,000 tok, synchronous `PreToolUse` | **`d3:mini`** | ~0.5–0.6 s at 300 tokens and 1.3 s at 1k (Strix Halo). Best small AUROC on the safeagents bench (0.975 vs nano's 0.878). Calibrated (ECE ~0.05). The policy only adds friction | `d3:nano` if p95 > 1.5 s here |
| `permission` | 2,000 tok, synchronous; auto-allow at p ≥ 0.95 | **`d3:mini`**, state cut to ~1,000 tokens | An auto-allow needs the best-calibrated tag that fits the budget. 2k tokens on mini (2.6 s) busts 1.5 s | `d3:nano` with a stricter allow threshold |
| `routing` | 1,500 tok, ~2 s budget, cached 10 min | **`d3:mini`** | Tools-area skill 0.72 vs nano 0.59; ~1.3–2 s at 1–1.5k | `d3:flash` would be better (0.76) but takes 2.3–3.5 s |
| `turn-outcome` | 3,000 tok, asynchronous | **`d3:mini`** (~4 s at 3k) | Accuracy matters more than latency here. `d3:flash` (~6.5 s at 3k) would hold the NPU long enough to starve the synchronous hooks behind it | `d3:flash` only on a separate server or if turn-outcome becomes the only active policy |

**Default: `d3:mini`.** It is the smallest tag with good calibration (Decision Index ECE 0.056,
typed-decisions 0.047) and a big step over nano (balanced 50.0 vs 34.3), downloads ~3.2 GiB and
needs under 9 GB of RAM. Short states take ~0.5 s on the NPU, roughly 5× faster than
strands-decider 2B on this CPU (2.4 s at 336 tokens, docs/benchmarks.md), and it is more accurate.
`d3:nano` is the latency fallback. Avoid `d3:edge` for policy decisions (typed-decisions accuracy
below the prior, ECE 0.34) and turbo/ultra here (3–30 s per request, 28 GB RAM).

**Two decision models at once: possible, not sensible.** Two `flm serve --decision` processes on
different ports fit in memory (mini 8.6 GB plus nano 5.3 GB), but FLM says they "contend for the NPU
and both slow down" **[verified]**, and each holds one or two NPU hardware contexts (the device
limit here is **[unverified]**). Prefer one model with per-policy `maxTokens` trimmed to the budget,
and switch tags by restarting the engine as `POST /v1/engine` does today (27B tags take 13–85 s to
"ready"; small tags **[unverified]**). Keep FLM chat traffic off the NPU while decision hooks run.

**What to evaluate locally.** Build 40–60 hand-labelled items per policy, kept as gateway fixtures
rather than the shadow log, which stores only hashes:

- `command-risk`: safe/caution/dangerous commands. Seed from `harness-hub/safeagents-judge-bench`
  (Apache-2.0; map block/allow to our labels) plus our own deny-rule near misses.
- `permission`: real Paseo/Claude requests with 3–5 turns of context. Include 10+ true `allow`
  items so the false-block rate is measurable.
- `routing`: 40 task prompts labelled fast/standard/deep by the tier that actually succeeded.
- `turn-outcome`: 60 tail transcripts. The `agent_trace_observability` suite of typed-decisions
  is a related public source.

Run each set on `d3:nano`, `d3:mini` and `d3:flash`, with strands-decider 2B on CPU as the
baseline. Measure accuracy and the confusion matrix; Brier and ECE with confidence recomputed by
the Strands formula; a threshold sweep for every `minConfidence` / `minProbability` rule; latency
p50/p95 through the gateway at real state sizes and at each `maxTokens`; flips under option-order
reversal (upstream d3 has an off-by-default `permutation_average`; FLM support **[unverified]**).

**Gateway changes this implies:**

1. Recompute `confidence` from `probabilities` for every engine.
2. Treat an answer that has `error` (`max_length_exceeded`, `invalid_question`,
   `invalid_model_output`) as missing.
3. Add an FLM engine: attach to `:52625`, check health through `GET /v1/systemone/models`, read
   `max_input_tokens`.
4. Prioritise synchronous hook policies over asynchronous ones in the per-engine queue.
