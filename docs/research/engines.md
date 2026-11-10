# Decision-model engines: research notes

Researched 2026-11-10 for the `local-decider` TS gateway: `decide(state, questions) -> {answers, probs, confidence, latencyMs}`, with Strands Decider's `/v1/systemone` as the internal contract.

Dev box: Fedora 44 (kernel 7.2), Ryzen AI 9 365 (Zen 5, 10C/20T, AVX-512 incl. `avx512_bf16`/VNNI), Radeon 880M (RADV STRIX1, Vulkan 1.4), XDNA2 NPU (`/dev/accel/accel0`, `amdxdna` loaded), 61 GB RAM, no CUDA, no ROCm packages installed. `/usr/bin/flm` (fastflowlm-1.0.12-1.fc44) is installed, but it is broken: `libqwen3_5vl_flash.so` and 3 other libs are missing.

Legend: **[verified]** means I read it in the source or ran it here. **[docs]** means the vendor docs or README say it and I did not test it. **[unverified]** means my inference or a third-party claim.

---

## 1. strands-decider

Sources: repo `strands-labs/strands-decider` (main, cloned 2026-11-10), `src/strands_decider/{schema,server,cli}.py`, `docs/inference.md`, `deploy/lambda/`, and the three blog posts.

### Install

- Python `>=3.10`. MLX needs 3.11+ on darwin/arm64. Apache-2.0. **[verified pyproject]**
- Core deps: `torch>=2.7`, `transformers>=5.15,<6`, `peft>=0.21`, `fastapi`, `uvicorn[standard]`, `pydantic>=2.7`, `typer`, `numpy`, `safetensors`, `huggingface_hub>=1.5`.
- Extras on main: `cuda` (= `flash-linear-attention>=0.5`, Linux only; also needs `pip install causal-conv1d --no-build-isolation` against a local nvcc), `mlx` (`mlx>=0.32.2`, `mlx-lm>=0.32,<0.33`), `mps` = `cpu` = nothing extra, `vision` (`pillow`), `train`, `benchmark`, `dev`.
- PyPI: the README says 0.1.0 has only `train`/`dev`. The Gemma 4 blog says `pip install "strands-decider>=0.2.0"`. Gemma 4 support needs main or 0.2.0. **[docs, conflicting]** Install from main to be safe.
- CPU-only install, done here in a throwaway venv. Exit 0, and `serve --help` works. Resolved torch 2.15.0+cpu, transformers 5.22.2. **[verified]**

  ```sh
  uv venv --python 3.12 /tmp/ld-research/venv
  VIRTUAL_ENV=/tmp/ld-research/venv uv pip install --index-strategy unsafe-best-match \
    --extra-index-url https://download.pytorch.org/whl/cpu "torch>=2.7" \
    "git+https://github.com/strands-labs/strands-decider"
  ```

  (fish users: `set -x VIRTUAL_ENV /tmp/ld-research/venv` first. Inline `VAR=x cmd` also works in fish 3.1+.)
- Mac/MLX: `pip install -e ".[mlx]"` from a clone, then `--device mlx`. That runs 1.4 to 1.6x faster than MPS (v19 on an M4 Pro: 113 ms at 222 tokens). **[docs]**

### CLI

`strands-decider serve [OPTIONS] CHECKPOINT` (captured `--help`) **[verified]**:

| flag | default | notes |
|---|---|---|
| `CHECKPOINT` | required | local dir or HF id, e.g. `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610` |
| `--host` | `127.0.0.1` | no auth, at all |
| `--port` | `8000` | |
| `--device` | auto: cuda > mps > cpu | `cuda`, `mps`, `cpu`, `mlx` (mlx only when asked) |
| `--no-prefix-cache` | off | disables the shared-state KV fork |
| `--model-name` | checkpoint basename | the `model` value returned in responses |
| `--vision` | off | Qwen3.5 only; requests may carry `images` |
| `--max-batch` | 32 | questions per forward pass |
| `--max-batch-tokens` | unset | cap on the padded tokens of one forward |
| `--device-map` | unset | CUDA multi-GPU only |
| `--max-concurrency` | unset (40-thread pool) | `>=1` |
| `--warmup/--no-warmup` | warmup | runs every shape up to `--max-batch` before binding the port. `/health` fails until warmup finishes. |

`strands-decider ask CHECKPOINT --state/-s TEXT [--noul Q]... [--choice "Q?=a,b,c"]... [--score "Q?=low,mid,high"]... [--image F]... [--device D] [--json]`. `--json` prints the raw API response. `strands-decider info CHECKPOINT` is defined in `cli.py`.

Gateway supervision notes:

- uvicorn runs with a single worker.
- The port binds only after model load plus warmup, so poll `/health` with a generous timeout. On CPU, warmup runs about 35 evaluations with the default `--max-batch 32`. Pass `--max-batch 8` or `--no-warmup` to start faster. On CPU there are no kernels to compile, so warmup buys little there. **[unverified]**
- The first run downloads the base weights.

### HTTP API ([verified] `schema.py`, `server.py`)

| route | method | notes |
|---|---|---|
| `/v1/systemone` | POST | main contract |
| `/invocations` | POST | same handler (SageMaker/AgentCore) |
| `/health` | GET | async, answers even when all worker threads are busy |
| `/ping` | GET | same as `/health` |

There is no `/v1/models`, no batch route, and no streaming.

Request (pydantic `SystemOneRequest`):

```jsonc
{
  "state": "string | object | array",          // required; may be "" ; objects rendered deterministically as JSON
  "model": "strands-decider-latest",            // optional, ignored by server
  "images": ["<base64 or data: URI>"],          // optional; only with --vision, else 422
  "questions": {                                // min 1 entry; key = your question id
    "is_urgent":  {"type": "noul",   "instructions": "Does this convey urgency?",
                   "criteria": {"true": "...", "false": "..."}},          // criteria optional, keys ⊆ {true,false}
    "department": {"type": "choice", "instructions": "Route it.",
                   "criteria": {"billing": "money", "technical": "bugs", "sales": null}},  // 2..255 options; desc may be str|obj|null
    "frustration":{"type": "score",  "instructions": "How frustrated?",
                   "criteria": ["Calm", "Frustrated", "Very angry"]}      // 2..10 levels, ascending
  }
}
```

`instructions` may itself be a string or structured content. Only these three types exist.

Response (`SystemOneResponse`, plus a `latency_ms` field the server adds):

```json
{
  "model": "strands-decider-2B-qwen3.5-v1-2610",
  "answers": {
    "is_urgent":   {"type": "noul", "noul": 0.8581},
    "department":  {"type": "choice", "choice": "billing",
                    "probabilities": {"billing": 0.773, "sales": 0.121, "retail": 0.106}, "confidence": 0.659},
    "frustration": {"type": "score", "score": 1.03, "legend": {"0": "calm", "1": "frustrated", "2": "depressed"},
                    "probabilities": {"0": 0.196, "1": 0.574, "2": 0.230}, "confidence": 0.509}
  },
  "usage": {"input_tokens": 86, "output_tokens": 1},
  "latency_ms": 489.01
}
```

(The noul block is a real response from the README. The choice and score values come from the README's CLI example and are shown in API form.)

How the probabilities and confidence are computed:

- A pointer head scores every option. A temperature-calibrated softmax over the options gives the probabilities.
- `noul`: P(true) only, with no confidence field. The docstring says confidence would just be |2p−1|. The gateway should derive `confidence = |2p−1|` or use `max(p, 1−p)`.
- `choice`: `confidence = (N·p_max − 1)/(N − 1)`, so uniform = 0 and one-hot = 1, independent of N.
- `score`:
  - `score` = the expected level index.
  - `confidence = (σ_max − σ)/(σ_max − σ_floor)`, where σ is the std over level indices, σ_max = (L−1)/2, and σ_floor = √ordinal_smoothing.
  - A spread over adjacent levels is therefore not read as doubt.
- Routing convention: act at confidence ≥ 0.9, confirm in about the 0.6 to 0.9 band. At ≥ 0.9, answers are right about 95% on unseen short tasks. **[docs]**

Errors:

- A ValueError from the engine, or a prompt longer than the window, returns **HTTP 422** with a `detail` that names the context window.
- Validation errors are FastAPI 422s.
- An `images` field on a non-vision server returns 422.

### Batching, context, concurrency

- **Shared-prefix cache.** The state is encoded once, the KV/recurrent state is forked per question, and each question sees only the state plus its own suffix.
  - Example: 1 vs 6 questions on a ~640-token state took 219 vs 217 ms on GPU.
  - With 1 question the prefix path is skipped.
  - The cache and plain batching are numerically identical in fp32. **[docs]**
- Questions go through in chunks of `--max-batch` (32).
- Window: `max_length` is 4,096 tokens for the v1 models. Gemma 4 trained at 4,096 and can run at 32,768 with `--max-batch 4 --max-batch-tokens 34000`.
- `/health` reports `max_length`.
- Concurrency: "Behaviour under concurrent requests is not verified". There is a known race on option offsets (#9).
  - MPS serializes requests. CUDA and CPU do not.
  - Recommendation: the gateway should send **one request at a time per engine** and batch questions into that request.
- Prompt sensitivity: the Amazon blog saw JSON key order shift probabilities by up to 0.19. The gateway should **sort keys** in structured state. **[docs, blog]**

### CPU feasibility, and latency to expect here

The engine casts the torso to fp32 on CPU. bf16 on CPU was about 2x slower on an M3 Pro.

Measured numbers from the docs:

| setup | measurement | source |
|---|---|---|
| 2B on Xeon 8375C, 8 threads | 1.6 s per short `ask` (v21); conv 0.49 s at 3,000 tokens | **[docs]** |
| 2B on M3 Pro CPU, fp32 | 3.25 s (256 tok, 1 question); 9.2 s (256 tok, 8 questions); 5.4 s (1,024 tok); 8.3 GB peak RSS | **[docs]** |
| 2B, llama.cpp Q8_0, Lambda Graviton3, 6 vCPU | 1.6 s (196 tok, 3 questions); 15.2 s (2,264 tok); 28.6 s (4,061 tok); peak 5.6 GB | **[docs]** |
| Gemma 4 on CPU, 16 threads each, 4 models sharing one 64-vCPU host | 4.9 s (E2B), 7.2 s (E4B), 13.5 s (12B), 7.8 s (26B-A4B) per JevBench question | **[docs]** |
| Gemma 4 RAM, fp32 CPU | ~19 GB (E2B), ~30 GB (E4B), ~46 GB (12B), ~101 GB (26B-A4B) | **[docs]** |

- On RAM, E2B and E4B fit this box, 12B is tight, and 26B-A4B does not fit.
- The GPU reference is RTX 3090: 115 ms median. H100: E2B 102 ms, E4B 139 ms.
- **Estimate for this Ryzen AI 9 365 [unverified, not run]:**
  - The 2B on torch CPU should take roughly 1 to 3 s for a short state and 5 to 15 s at 2k tokens.
  - E4B should take about 5 to 10 s per question.
  - That is usable for async or background decisions, but not as a per-tool-call guard.
- I did not download the 2B base model: Qwen3.5-2B-Base is 4.55 GB, which is over the 1 GB cap.

### ROCm / AMD GPU

- The repo has no mention of ROCm, HIP or AMD. **[verified grep]**
- With a ROCm build of torch, the device is called `cuda`, so `--device cuda` would select it.
  - Without `fla`, the Gated DeltaNet and conv fall back to the transformers reference paths.
  - The `cpu_kernels.py`/`mps_kernels.py` replacements are keyed to the cpu/mps devices.
  - So expect it to be slow and possibly fragile.
  - On this box ROCm is not installed, and gfx1150 (880M) support in official ROCm/torch wheels is uncertain. **[unverified]**
- **The better AMD route is llama.cpp (Vulkan).** The repo already ships a torch-free engine:
  - `src/strands_decider/hidden_engine.py` (`HiddenStateEngine` plus `Backend` protocol): tokenizer, prompt render and fit, and the pointer head in numpy.
  - `deploy/lambda/function/{shim.c,backend.py}`: llama.cpp produces the final-norm hidden states through `llama_get_embeddings_ith`, with `llama_memory_seq_cp` forking the state per question.
  - `deploy/lambda/scripts/prepare_model.py` merges the LoRA, writes the `Qwen3_5ForCausalLM` torso, then runs `convert_hf_to_gguf.py --outtype f16` and `llama-quantize ... Q8_0` (~2 GB), plus `save_assets()`.
  - The Lambda image pins llama.cpp `6184e92c57dcd34de8a3e381d7641a5e75250d5f`.
  - Parity: Q8_0 vs torch fp32 differs by ≤ 0.026 in probability, with no choice flips.
  - **Qwen3.5 torsos only.** `prepare_model.py` refuses Gemma.
  - **[verified source]**
- llama.cpp master's Vulkan backend implements `GGML_OP_GATED_DELTA_NET` and `GGML_OP_SSM_CONV`, and has an `LLM_ARCH_QWEN35` arch. **[verified grep]** So a build of `shim.c` against llama.cpp with `-DGGML_VULKAN=ON` (and no ARM flags) *should* run the decider on the Radeon 880M.
  - Whether it does is **[unverified]**: shim rebuild, the op coverage at the pinned rev, and the speed are all unknown.
  - It needs a ~30-line FastAPI or stdin wrapper around `HiddenStateEngine.from_assets(dir, LlamaBackend(lib, gguf, threads)).evaluate(req)`. The Lambda `handler.py` is the template.

---

## 2. StrandsAgents models on Hugging Face

`curl "https://huggingface.co/api/models?author=StrandsAgents&full=true"`, plus per-repo `?blobs=true`. **[verified 2026-11-10]**

All repos are `gated: false` and Apache-2.0. They are adapters only: a LoRA, the pointer head, the tokenizer and evals. The base model downloads separately at first load. All the bases are ungated Apache-2.0 too. Mirrors are at `amazon/<same-name>` (the five v1 models plus hobson-v21).

| repo | adapter repo size | base model | base safetensors | JevBench /231 | Brier | GPU (bf16) |
|---|---|---|---|---|---|---|
| `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610` (reference) | 235 MB | `Qwen/Qwen3.5-2B-Base` | 4.55 GB | 180 | 0.280 | ~5 GB |
| `StrandsAgents/strands-decider-2B-hobson-v21` | 92 MB | `Qwen/Qwen3.5-2B-Base` | 4.55 GB | 176 | 0.323 | ~5 GB |
| `StrandsAgents/strands-decider-2B-hobson-v19` | 92 MB | `Qwen/Qwen3.5-2B-Base` | 4.55 GB | 167 (w3072) | 0.342 | ~5 GB |
| `StrandsAgents/strands-decider-E2B-gemma4-v1-2610` | 332 MB | `google/gemma-4-E2B-it` | 10.25 GB | 180 | 0.313 | ~9 GB |
| `StrandsAgents/strands-decider-E4B-gemma4-v1-2610` | 467 MB | `google/gemma-4-E4B-it` | 15.99 GB | 187 | 0.243 | ~15 GB |
| `StrandsAgents/strands-decider-12B-gemma4-v1-2610` | 843 MB | `google/gemma-4-12B-it` | 23.92 GB | 200 | 0.173 | ~23 GB |
| `StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610` | 273 MB | `google/gemma-4-26B-A4B-it` | 51.61 GB | 207 | 0.162 | ~51 GB |

- The loader drops Gemma's vision and audio towers. The Gemma 4 models are text only.
- Only the Qwen3.5 models support `--vision`.
- E2B uses eager attention, which fixes a CUDA SDPA bug.
- Revisions are tagged `YYMMDD`. To pin one: `hf download <repo> --revision YYMMDD --local-dir v1`.
- Amazon production (blog): E4B on `ml.g5.xlarge` (A10G, 24 GB), ~19 GiB, ~640 ms per request, one choice question with 20 labels plus "none", ~2,000 input tokens. **[blog]**

---

## 3. Laya and GLiClass (encoder-class, small, fast)

### Laya (Convai Innovations): `convaiinnovations/laya`, Apache-2.0, ungated

- A ModernBERT encoder plus a decision head, trained with RLCD.
- HF files:
  - `model.safetensors` (843 MB, English, 512-token `max_len`)
  - `typed-decisions/` (843 MB, 1,024 ctx)
  - `multilingual/` (644 MB, up to 8,192 tokens)
  - DecideBench lists typed-decisions as 421M params.
- Python: `pip install laya` (Python ≥ 3.10). Extras: `laya[serve]`, `[onnx]`, `[mcp]`, and others.
- **Server:** `laya-serve` (e.g. `LAYA_HOST=127.0.0.1 LAYA_MODELS=english laya-serve`; the default binds `0.0.0.0:8000`; `LAYA_DEVICE=cuda LAYA_PRELOAD=1`).
  - It exposes **`POST /v1/systemone`**, `POST /v1/systemone/batch`, `POST /v1/route`, and a health probe, with an optional bearer token. **[verified source `laya/serve.py`]**
  - Newer versions (0.4.23+) also bundle "vegaml", a 0.8B Qwen3.5 reader with conformal sets and `abstain`/`route` fields. That is heavier and goes beyond the contract.
- Answer shape: the same `choice`/`score`/`noul`/`probabilities`, plus `answer_confidence` (= max p, on every type).
  - Laya's `confidence` on choice and score means **1 − normalized entropy**, which differs from Strands' formula.
  - The gateway must normalize `confidence` per engine.
- Latency **[docs]**:
  - T4: p50 32.8 ms for 1 question, 72 ms for 10, 337 ms for 50.
  - Ryzen 9 6900HX CPU (AVX2, WSL2), one question in-process: 910 ms at 1 intra-op thread. More threads speed it up. With `torch.set_num_threads(8); torch.set_num_interop_threads(1)`, a 3-question HTTP call took 783 ms, against 9.4 s with the defaults.
  - **Pin inter-op threads to 1.**
- Quality: DecideBench v2 gives typed-decisions 39.1%. Strands is not listed by that exact name; "Decider-2B" there scores 31.8% and may be the Mapika `decider-2b`, not Strands **[unverified]**. Laya is fine for easy routing and triage, and weak on rule-following.

**Node/ONNX: `@receptron/laya`** (MIT, v0.2.0, Node ≥ 20). **[verified README/package.json]**

- `npm install @receptron/laya`. Deps: `onnxruntime-node ^1.22`, `@huggingface/tokenizers`.
- Weights: the HF repo `receptron/laya-onnx` holds a fp32 bundle of about 1.7 GB, with `laya.onnx` plus `laya.onnx.data`.
  - It downloads on first `Laya.load()` into `~/.cache/receptron-laya` (`LAYA_CACHE`).
  - Prefetch with `node -e 'import("@receptron/laya").then((m) => m.ensureBundle())'`.
- API (in-process, systemone shape, parity with Python to 4 dp):

  ```ts
  import { Laya } from "@receptron/laya";
  const laya = await Laya.load({ executionProviders: ["cpu"], sessionOptions: { intraOpNumThreads: 4 },
                                 subfolder: "multilingual" /* optional */, revision: "main", modelDir: "./onnx" /* optional */ });
  const r = await laya.systemOne(state, { department: { type: "choice", instructions: "...", criteria: { billing: "...", support: "..." } } });
  r.answers.department.probabilities; r.answers.department.answer_confidence; r.usage.input_tokens;
  await laya.close();
  ```

- Limits:
  - ≤ 192 tokens for each question's options (`head_max_len`). Fewer than about 20 options is recommended.
  - The state is truncated to 512 tokens (English).
  - Temperatures are clamped to [0.5, 5].
- Latency: about 140 ms for a 3-question call on an Apple-silicon CPU. A warm load from cache takes about 4 s on an M4. **[docs]**
- There is also an official `laya-ts` package (npm `laya-ts`). It uses split `encoder.onnx` plus `head.onnx` and has optional `onnxruntime-node ^1.31.1` / `onnxruntime-web` peer deps. **[docs]**
- **Verdict:** this is the easiest in-process Node engine. It has no Python and ships a systemone-compatible answer shape. Not run here, because the bundle is over 1 GB.

### GLiClass v4-edge (Knowledgator): `knowledgator/gliclass-v4-edge`, Apache-2.0, ungated

- 0.4B, on a DeBERTa-v3-large base. Instruction-following zero-shot classification in one pass. Calibrated scores, with the raw score kept as `initial_score`.
- HF files:
  - `model.safetensors` 882 MB
  - **`onnx/model.onnx` 1.76 GB (fp32)**
  - **`onnx/model_q8.onnx` 647 MB**
  - `onnx/tokenizer.json`
- Python: `pip install gliclass` (0.1.22 resolved here), Python 3.10+.
  - `ZeroShotClassificationPipeline(model, model_id, classification_type="single-label"|"multi-label", max_length=2048, device=...)`
  - Call: `pipe(text, labels, prompt=..., return_hierarchical=True)`.
- **systemone:** the model card ships a ~90-line `jev_api.py` FastAPI server with `POST /v1/systemone` and `GET /v1/models`. Run it with `uvicorn jev_api:app --port 8765`.
  - The mapping: choice = softmax over the option descriptions; noul = `["true","false"]` labels using the `criteria` descriptions (default `yes`/`no`); score = expected index.
  - `confidence` = p_max.
  - It refuses inputs over `MAX_LENGTH` (16,384) with 422.
  - It runs **one forward per question**, so there is no state sharing.
  - The repo's own Ray Serve server (`gliclass/serve`, `/v1/process`) is *not* systemone.
- **Measured on this box [verified]**, torch 2.15 CPU fp32, `gliclass` pipeline, single-label, 3 options:

  | state | 8 threads p50 | 16 threads p50 |
  |---|---|---|
  | ~15 tokens | 99.5 ms | 109 ms |
  | ~600 tokens | 455 ms | 505 ms |

  - 8 threads beat 16, so stay on physical cores.
  - Sample output on "Help! My payouts have been failing for 3 days.":
    - urgency yes 0.975
    - team billing 0.487 / technical 0.489 / sales 0.025
    - frustration calm 0.09 / frustrated 0.72 / very angry 0.19
  - On GPU the vendor reports 11 ms median (RTX PRO 6000). Decision Index public skill is 47.5.
- **Node:** the ONNX graph exists, but there is no published JS pre/post-processor. You would need to port GLiClass's tokenization, `<<LABEL>>` packing and `<<SEP>>` logic to TS (cf. the GLiNER JS ports). The ONNX q8 run on `onnxruntime-node` is plausible but **[unverified]**. Running it behind the Python `jev_api.py` is the practical way today.

### Other engines with a systemone server worth knowing about (from the awesome lists, [docs/unverified])

- **jevos** (`feder-cr/jev`): MiniCPM5-1B with 17 layers, GGUF q4_k_m at 619 MB on llama.cpp CPU, about 54 ms per short request, noul only.
- **jev-style**: 0.8B, torch, MLX or llama.cpp.
- **Kev**: 0.8B, 4B or 9B.
- **JevK5**, **Lev**, **OpenJev**, **jiwo** (0.8B/4B), **OpenThai-SystemOne** (0.8B, in Ollama).
- **decidecall** (Zenodo 23470228): a Claude Code plugin that cascades exact cache → rules → a local decision model (strands-decider, OpenJev or JevK5 "through the systemone protocol", or ollama) → a cheap cloud model → a strong model → a person. The act gate is 0.95. Its design is close to this gateway's, and worth reading.
- **DecideBench v2** (`choyiny/decidebench`): 450 items, Opus 4.8 at 99.3%. Small open decision models (≤ 2B) score 27 to 40% there, while 4B+ fine-tunes reach 64 to 79%. Expect weak rule-following and numeric checks from 2B-class engines. Push arithmetic into gateway code.

---

## 4. OpenAI-compatible LLM servers as a fallback engine (logprob scoring)

The idea: turn any instruct LLM into a choice/noul/score engine by reading the next-token distribution over option labels.

| server | top-k logprobs on `/v1/chat/completions` | on `/v1/completions` | output constraints | status |
|---|---|---|---|---|
| **llama.cpp `llama-server`** | yes: `"logprobs": true, "top_logprobs": N`. N maps to `n_probs` and defaults to 20 when omitted. `top_logprobs` without `logprobs` → 400. No cap below vocab size (issue #29456). | yes (OpenAI `logprobs: int`); native `/completion` takes `n_probs`, `post_sampling_probs` | `grammar` (GBNF), `json_schema`, `response_format` (`json_object` or `json_schema`), `logit_bias` (`[[id, bias]]`, `[[id,false]]` bans, `{"tok": bias}` OAI form; string keys allowed) | **[verified source+README]** |
| **Ollama** (latest v0.40.16) | yes: `logprobs: bool`, `top_logprobs: 0..20` (native `/api/chat` and `/api/generate` too) | yes (`logprobs: int`) | `format` = `"json"` or a JSON schema. No grammar. No `logit_bias` support documented. | **[verified api/types.go, openai/openai.go]** |
| **LM Studio** | not confirmed for chat completions | n/a | `response_format` json_schema **[docs]** | `/v1/responses` supports `top_logprobs` with `"include": ["message.output_text.logprobs"]` **[blog]** |
| **FastFlowLM** (`flm serve`, port 52625) | PR #834 "logprobs and top_logprobs on /v1/chat/completions" merged 2026-10-26, so probably in v1.0.12 (2026-11-05). Top-k is raised to 100. | unknown | unknown | **[verified PR state; release content unverified]** |
| **Lemonade** (port 13305) | `logprobs: bool` documented, `top_logprobs` not documented | `logprobs: true or int` | `response_format` json_object | **[docs]** It proxies to llama-server (GGUF) or `flm serve`, so behaviour is per backend and extra fields may pass through **[unverified]**. Linux backends: llamacpp (CPU/Vulkan/ROCm builds) and `flm:npu` (`lemonade backends install flm:npu`). `ryzenai-llm` is Windows only. |

**Recipe: option-token scoring (llama.cpp, the best-supported path):**

1. Render a prompt with single-token option labels. Use `A`/`B`/`C`... or `yes`/` no` for noul, and `0`..`9` for a score (≤ 10 levels, which matches the Strands cap). Put the option descriptions in the prompt and end with `Answer:` (or an assistant prefix with thinking disabled via `chat_template_kwargs: {"enable_thinking": false}`).
2. Request: `{"max_tokens": 1, "temperature": 0, "logprobs": true, "top_logprobs": 20, "messages": [...]}`. Optionally add `logit_bias` that bans or boosts tokens, or a grammar `root ::= "A" | "B" | "C"`.
   - Note: the `n_probs` values are computed by softmax over the **raw logits** before samplers (and probably before the grammar). So reading the top-k *without* a grammar, then renormalizing, is the cleanest way. **[docs + unverified for grammar interaction]**
3. Read `choices[0].logprobs.content[0].top_logprobs[]`. Each entry is `{token, logprob, bytes}`; llama.cpp also returns `id`.
   - For each option, sum `exp(logprob)` over its token variants (`"A"`, `" A"`, `"a"`). If an option is missing from the top-k, give it the floor `exp(min_logprob)`.
   - Renormalize: `p_i = m_i / Σ m`.
   - Report `coverage = Σ m` (mass on valid options before renormalizing) as an engine-health signal. Low coverage means the model is not answering the format.
4. Map to systemone:
   - noul = p(yes)
   - choice = argmax plus the Strands confidence `(N·pmax−1)/(N−1)`
   - score = `Σ i·p_i`, plus the σ-based confidence
5. Calibration: raw LLM token probabilities are over-confident. Fit a per-engine temperature on a small labelled set (as Strands/Laya do), and randomize or sort option order to measure position bias.
6. For multi-token labels, use llama.cpp's native `/completion` with `n_probs` and a forced prefix, scoring each label's continuation (one request per option, `cache_prompt: true`). This is slower. **[unverified]**

---

## 5. AMD XDNA2 NPU on Linux: feasibility

- **Ryzen AI Software 1.9 (Linux)** **[docs]**:
  - Strix Point and newer, XDNA2/aie2p.
  - Officially **Ubuntu 24.04 only**, kernel ≥ 6.10, Python 3.12.x, 64 GB RAM recommended.
  - Installs XRT and the amdxdna plugin `.deb`s, then `ryzen_ai-1.9.0.tgz` (12.9 GB) via `./install_ryzen_ai.sh -a yes -p <venv>`. Check with `xrt-smi examine` and `quicktest.py`.
  - Linux runs **NPU flows only** (no iGPU EP): CNN INT8/BF16, **NLP encoders (BERT-class) in BF16** through the VitisAI EP (VAIML compiler), and an NPU-only LLM flow.
  - Fedora is not supported, so it would have to run in a container.
- **PjSalty/linux-ryzen-ai-npu** **[docs]**:
  - Runs the 1.9.0 stack in a **rootless podman Ubuntu-24.04 container** on any distro (tested on Arch, HX 375), using the in-tree `amdxdna` (6.14+) and distro firmware, and passing only `/dev/accel/accel0`.
  - Costs about 50 GB of disk (a 28 GB image), and needs `memlock unlimited`.
  - **Static input shapes** are required. fp32 ONNX is compiled to BF16.
  - BF16 SigLIP-2 and Depth Anything ran fully on the NPU, but the **iGPU was faster** (6.8 ms vs NPU). The NPU wins on energy.
  - The "performance" power mode needs root and gives about 3x speed.
  - AMD's quicktest can report success while silently falling back to CPU. Verify with the NPU busy counter.
  - This box meets the prerequisites: kernel 7.2, `amdxdna` loaded, `/lib/firmware/amdnpu/17f0_*` present. **[verified]**
- **iron-ep** (RyzenAI-SW#356, closed): an open-source VitisAI-EP replacement built on IRON/MLIR-AIE/XRT. It offloads only `MatMul`/`MatMulInteger`/`Gemm`, giving about 3x over CPU on INT8 matmuls (HX 375, Fedora 43). It is a research prototype, not a full encoder path. **[docs]**
- **FastFlowLM** (`ROCm/FastFlowLM`, v1.0.12) **[docs]**:
  - XDNA2-only LLM runtime (Strix included), with a Linux release since 2026-03 (`.deb`, tar, Fedora rpm installed here).
  - The CLI/orchestration is MIT. The NPU kernels are a proprietary but free binary license.
  - OpenAI-compatible `flm serve <tag>` on port 52625, with embedding models too.
  - It only runs **its own pre-converted model families**: Llama 3.x, Qwen3/3.5, Gemma 3/4, gpt-oss and others. It **cannot load the Strands LoRA, pointer head or hidden states**, so the Decider cannot run on it.
  - Usable only as a logprob-scoring LLM engine (§4), once `top_logprobs` ships.
  - The local install is currently broken (missing `.so`s). Reinstall the rpm before testing.
- **Lemonade**: on Linux, NPU means FLM (`flm:npu`). The VitisAI `ryzenai-llm` and OGA path is Windows only. **[docs]**

**Feasibility summary:**

| target | on NPU here? | effort | payoff |
|---|---|---|---|
| Laya / GLiClass (encoder, BF16) via VitisAI EP in the PjSalty container | plausible: BERT-class BF16 is a supported Linux flow. Needs static-shape ONNX export (fixed seq len, e.g. 512) and a 28 GB image. ModernBERT/DeBERTa op coverage untested. | high | energy, not latency. iGPU/CPU is likely as fast. |
| Strands Decider (Qwen3.5 hybrid with Gated DeltaNet, or Gemma 4) on the NPU | **no** practical path: no VitisAI or FLM support for a custom LoRA, pointer head or hidden-state readout | n/a | n/a |
| LLM logprob engine via FLM | yes, once `top_logprobs` lands (merged upstream) | low-medium | a slow and less calibrated fallback |
| Decider via llama.cpp **Vulkan on the 880M iGPU** | not NPU, but the best accelerator path here | medium (rebuild `shim.c`) | likely several-fold faster than CPU **[unverified]** |

---

## Recommended engine plan for the Linux dev box

1. **MVP engine A (correctness reference): `strands-decider serve` on CPU.** This is the exact contract. Run `strands-decider serve StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 --device cpu --port 8099 --max-batch 8` from a uv venv with CPU torch. The gateway supervises it: spawn, poll `/health`, one request at a time. Expect a few seconds per request; first start downloads 4.8 GB.
2. **MVP engine B (fast tier): Laya in-process via `@receptron/laya`** (onnxruntime-node, CPU) for sub-second easy decisions, normalizing `confidence` to Strands semantics. GLiClass v4-edge (measured at ~100 ms here) works through its `jev_api.py` if a Python sidecar is acceptable.
3. **Next: a llama.cpp Vulkan backend for `HiddenStateEngine`.** Q8_0 GGUF of the 2B torso on the Radeon 880M, behind a small `/v1/systemone` wrapper. This is the most promising latency win on this machine.
4. **Later: logprob adapter** for llama-server, Ollama or FLM (§4) as a generic engine. The NPU (VitisAI BF16 encoders) is a research spike only.
