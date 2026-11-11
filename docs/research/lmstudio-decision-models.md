# Decision models that work through LM Studio's chat API with token logprobs: research notes

Researched 2026-11-11 for the planned `lmstudio` engine (the `openai-compatible` engine with LM
Studio defaults). Machine target: Apple Silicon Mac, 48 GB. Nothing was run for this note: no
model download, no gateway run. The only local command was `lms get --help`; `lms ls` tried to wake
the LM Studio daemon and timed out.

Legend: **[verified]** I read it in a model card, a repo file, the HF API or this repo's code.
HF pages were read through a summarising fetch tool, so quoted strings are close paraphrases of
the page; re-check an exact string before putting it in a prompt template. **[reported]** A third
party's claim (a paper, an issue, a README). **[unverified]** My inference, or something I could
not check.

## 0. Summary

1. **The decision models that fit LM Studio's chat API are the "letter readout" family**, not
   Strands or d3. JevK5 (`alibiserikbay`) and Jev-Style v1/v2 (`chaoliangUNSW`) are plain
   `lm_head` models. The verdict is the next token (`A`, `B`, ...), calibration is fitted into the
   weights or a published temperature, and a third party has run one of them through LM Studio's
   `/v1/chat/completions` with `max_tokens: 1` **[reported]**. They take our contract unchanged:
   state, question, options in, one probability per option out. Strands and d3 cannot run here
   (§3.6).
2. **Safety guards are generative but cover only `command-risk` and `permission`.** Granite
   Guardian 4.1 is the best fit: bring-your-own-criteria yes/no, and the guardian block lives in
   the user message, so a plain chat call can drive it. Qwen3Guard-Gen offers a three-level
   `Safe / Controversial / Unsafe` verdict. Neither can rate `turn-outcome` or `routing`.
3. **The runtime matters more than the model.** LM Studio's llama.cpp (GGUF) runtime returns
   chat `top_logprobs`; its MLX runtime returned HTTP 200 with an empty `logprobs.content`
   **[reported, §1]**. "MLX preferred" is therefore backwards for this engine. Our earlier
   "`logprobs: null` at `max_tokens: 1`" measurement on Qwen3-1.7B may have been the MLX build
   **[unverified]**; it is the first thing to re-test (§7, step 0).
4. **The adapter needs per-model profiles** (§6). The generic prompt reads only the first usable
   output position, so any model whose verdict follows a prefix (`Safety: `, `<score>`) needs an
   anchor.

## 1. How LM Studio serves logprobs, and what our adapter assumes

- **GGUF works, MLX does not [reported].** nowledge-co/community issue #929: a Jev-style 2B
  decision model as a Q8_0 GGUF in LM Studio's server returned top-1 `" B"` at logprob -0.08
  (about 92%, matching its model card). The same model as an MLX bf16 build returned HTTP 200 with
  empty `logprobs.content`: "silently unusable". The request was one user message ending in
  `Answer:`, `max_tokens: 1`, `temperature: 0`, `logprobs: true`, `top_logprobs: 20`.
  <https://github.com/nowledge-co/community/issues/929>. The issue is about 47 days old, so a
  newer LM Studio MLX runtime may differ.
- **`/v1/completions` gives no candidate logprobs in LM Studio [reported]**: the Jev-Style client
  says so, and it matches our own measurement (`docs/engines.md` §6).
- **`lms get` [verified, `lms get --help`]**: `lms get [name]` takes a catalog name, `name@quant`,
  or a full Hugging Face URL; `--mlx` / `--gguf` restrict the format; `--select` opens variant
  selection; `-y` auto-approves. `lms get user/repo` is not documented for arbitrary HF repos, so
  the commands below use the URL form. Whether the URL form takes `@quant` is **[unverified]**;
  use `--select` and pick the file by hand.
- **What our adapter does today [verified, `packages/gateway/src/engines/openai/`].**
  - **Prompt.** `renderPrompt` sends a fixed system message ("You are a precise classifier ...")
    and a user message of `<state>`, the question and the option list. The label scheme is
    `yes` / `no` for `noul`, `A`, `B`, ... for `choice`, `0`, `1`, ... for `score`.
  - **Request.** `lmstudio` defaults are `api: chat`, `maxTokens: 8`, `promptSuffix: /no_think`;
    `logprobs: true`, `top_logprobs: 10` by default.
  - **Position.** `parseChatPositions` takes the single logprob position if there is one,
    otherwise the first position whose sampled token is non-blank and not `<think>` / `</think>`.
  - **Matching.** `canonicalToken` trims, strips `(`, `.`, `)`, `:`, lower-cases for yes/no and
    upper-cases single letters. Option mass is summed over token variants.
  - **Normalising.** Missing options get the smallest returned probability as a floor. The
    distribution is `p^(1/T)` normalised, which equals `softmax(logit/T)` over the options, so a
    model's published calibration temperature goes straight into `temperature`. The answer is
    refused (fail open) when the covered mass is below `minCoverage` (0.5).
  - **Contract.** `noul` returns `P(true)`; `choice` the argmax plus probabilities; `score` the
    expected level plus probabilities.
- **Gaps for verdict-after-prefix models.** A model that writes `Safety: Safe` or
  `<score>yes</score>` has its verdict at position 3 or later. The first-usable-token rule picks
  `Safety` or `<score>`, covers none of the options, and the engine refuses. The system message is
  also wrong for guards: Llama Guard's template rejects a `system` role **[unverified]**, and
  Qwen3Guard's template builds its own policy prompt around the user message **[unverified]**.

## 2. Candidate table

"LM Studio read" is how the verdict reaches a logprob. "Policies" lists what the model can serve
without a second model. Sizes are download sizes from the repo pages unless marked.

| Family | Repo(s) | License / gating | LM Studio format available | Verdict token(s) | Policies |
|---|---|---|---|---|---|
| **JevK5** 4B / 9B | `alibiserikbay/JevK5-GGUF` (4B v0.3 Q8_0 4.48 GB, Q5_K_M 3.07 GB, Q4_K_M 2.71 GB; 9B v0.3.3 Q8_0 9.53 GB); bf16 `alibiserikbay/JevK5` | Apache-2.0, ungated; training data caveats (§3.1) | GGUF; no MLX found | `A`..`P` next token | all four |
| **Jev-Style v1** 2B | `chaoliangUNSW/Jev-Style-Qwen3.5-2B-Decision-GGUF` (Q8_0 2.1 GB, Q4_K_M 1.3 GB); MLX bf16 `...-MLX-bf16` | Apache-2.0, ungated; archived, trained on SST-2/MNLI/AG News/BoolQ/SST-5 | GGUF (works [reported]); MLX (no logprobs [reported]) | letters, pass-through template | all four, weak OOD |
| **Jev-Style v2** 2B | `chaoliangUNSW/Jev-Style-Qwen3.5-2B-Decision-v2-GGUF` (Q8_0 2.01 GB) | Apache-2.0; archived | GGUF | letters `A`..`Z`; prompt capped at 1,024 tokens | routing, `command-risk`; too short for `turn-outcome` |
| **Granite Guardian 4.1** 8B | `ibm-granite/granite-guardian-4.1-8b-GGUF` (Q4_K_M 5.12 GB, Q8_0 8.91 GB, BF16 16.8 GB); MLX `darthcrawl/granite-guardian-4.1-8b-mlx-4bit` (community) | Apache-2.0, ungated; English only | GGUF (official) | `yes` / `no` inside `<score>` | `command-risk`, `permission`; yes/no only |
| **Granite Guardian 3.3** 8B | `ibm-granite/granite-guardian-3.3-8b-GGUF` (Q4_K_M 4.94 GB, Q8_0 8.68 GB) | Apache-2.0 | GGUF (official) | `yes` / `no` inside `<score>`; criteria picked by `guardian_config` | same; BYOC needs the template kwarg, so 4.1 is easier |
| **Granite Guardian 3.1 / 3.2** | `ibm-granite/granite-guardian-3.2-5b` + `ibm-research/granite-guardian-3.2-5b-GGUF`; 3.1 2B/8B have community GGUFs only | Apache-2.0 | GGUF | `Yes` / `No` as the **first** token; 3.2 adds `<confidence>` | fixed risk list, first-token read |
| **Qwen3Guard-Gen** 0.6B / 4B / 8B | `Qwen/Qwen3Guard-Gen-{0.6B,4B,8B}`; GGUF `mradermacher/Qwen3Guard-Gen-{0.6B,4B,8B}-GGUF`; MLX `mlx-community/Qwen3Guard-Gen-0.6B-MLX`, `abnormalmapstudio/Qwen3Guard-Gen-{4B,8B}-mxfp4-mlx` | Apache-2.0, ungated | GGUF, MLX | `Safe` / `Unsafe` / `Controversial` after `Safety:` | `command-risk` (3 levels), `permission` |
| **Llama Guard 3** 1B / 8B | `meta-llama/Llama-Guard-3-{1B,8B}`; GGUF `QuantFactory/Llama-Guard-3-1B-GGUF`, `mradermacher/Llama-Guard-3-8B-GGUF`; MLX `mlx-community/Llama-Guard-3-1B-chat-mlx-4bit` | Llama 3.x licence, gated upstream | GGUF, MLX | `safe` / `unsafe` first token | `command-risk`, loosely |
| **Llama Guard 4** 12B | `meta-llama/Llama-Guard-4-12B`; GGUF `DevQuasar/meta-llama.Llama-Guard-4-12B-GGUF` | Llama licence, gated; multimodal | GGUF | as above | as above, heavier |
| **ShieldGemma** 2B / 9B / 27B | `google/shieldgemma-{2b,9b,27b}`; GGUF `legraphista/shieldgemma-2b-IMat-GGUF`, `QuantFactory/shieldgemma-2b-GGUF` | Gemma terms, gated | GGUF only | `Yes` / `No` first token | `command-risk` with a custom guideline |
| **Nemotron Content Safety** 4B | `nvidia/Nemotron-3.5-Content-Safety`, `nvidia/Nemotron-Content-Safety-Reasoning-4B`; GGUF `mradermacher/Nemotron-3.5-Content-Safety-GGUF`, `DevQuasar/nvidia.Nemotron-Content-Safety-Reasoning-4B-GGUF` | NVIDIA open model licence + Gemma terms | GGUF | `safe`/`unsafe` after `User Safety:`; `harmful`/`unharmful` after `Prompt harm:` | `command-risk` via a custom policy |
| **WildGuard** 7B | `allenai/wildguard` | Apache-2.0, **gated** | none official; `mradermacher/Wildguard-Qwen3-4b-GGUF` is a different model | `yes`/`no` after `Harmful request:` | no |
| **gpt-oss-safeguard** 20B / 120B | `openai/gpt-oss-safeguard-20b`; `lmstudio-community/gpt-oss-safeguard-20b-GGUF`, `...-MLX-MXFP4` | Apache-2.0 | GGUF, MLX | JSON/label after reasoning | any policy, but reasoning (§3.5) |
| **Arch-Router** 1.5B | `katanemo/Arch-Router-1.5B`; GGUF `katanemo/Arch-Router-1.5B.gguf`; MLX `mlx-community/Arch-Router-1.5B-mlx-8Bit` | Katanemo licence | GGUF, MLX | route name inside `{"route": "..."}` | routing only |
| **RouteLLM `causal_llm`** 8B | `routellm/causal_llm_gpt4_augmented` | not checked | no GGUF/MLX found | `[[1]]`..`[[5]]` special tokens | strong-vs-weak routing only |

HF ids, downloads, gating and `gguf` / `mlx` tags come from the HF API (`/api/models?search=`),
**[verified]** on 2026-11-11. The API data has no `gated` field for most rows, so the gating column
comes from model cards where I read them (Llama Guard 3, ShieldGemma, WildGuard) and is
**[unverified]** elsewhere.

## 3. Per-model notes

### 3.1 JevK5 (alibiserikbay): best generic fit

- **What it is [verified card].** Qwen3.5-4B with a rank-16 LoRA on attention projections, merged.
  A 9B build and a v0.2 2B exist. The prompt and readout are adapted from SemIf (MIT).
- **Readout [verified].** A softmax over the answer letters' next-token logits, one forward pass,
  zero generated tokens, one temperature: **1.22** for 4B v0.3 (all three quants), 1.316 for 9B
  v0.3.3. More than 16 options are scored by knockout (`knockout_temperature` 0.93); one pass
  covers up to 16 letters (`LETTERS = "ABCDEFGHIJKLMNOP"`).
- **Prompt [verified `jevk5/prompt.py` at v0.3.3, GGUF card].** ChatML. System: "Apply the
  supplied criterion to the supplied evidence. Choose exactly one listed option. Respond with only
  its uppercase letter, with no explanation or reasoning." User: `json.dumps({"evidence": state,
  "criterion": criterion, "options": [{"letter": "A", "description": "<key>: <text>"}, ...]})`.
  `noul` uses option keys `true` / `false` (in that order), `choice` uses the criteria keys, and
  `score` uses the level index as the key. The assistant turn is prefilled with
  `<think>\n\n</think>\n\n`, and the llama.cpp client tokenises with `parse_special`.
- **Runtime used by the authors [verified card].** `llama-server` `/tokenize` plus native
  `/completion` with `n_predict: 1`, `n_probs: 40`. They say they "have not checked whether LM
  Studio's API returns the answer-letter log-probabilities". The OpenAI chat route is untested by
  them.
- **Calibration [reported, card, authors' own runs].** ECE 0.035 on held-out teacher questions
  (0.050 before calibration); JevBench hard-tier ECE 0.054; standard 0.057; easy 0.018.
  Accuracy: easy 1.000, standard 0.944, hard 0.784 (untrained base 0.613; the hard-tier gain is
  not significant, p = 0.30). Q8_0 gives the same answer as bf16 on 229/231 items, Q5_K_M on
  224/231, Q4_K_M on 221/231. The 4B Q8_0 is the sweet spot on a 48 GB Mac.
- **Weak spots [reported].** Dates and numbers (0.47), judging answers on the hard tier, more than
  16 options, `score` questions on bev-decision (0.409). English only. Trained on inputs up to
  2,048 tokens and refuses over 16,384, so our `turn-outcome` budget (3,000 tokens) is outside the
  trained range. **[unverified]** whether quality holds there.
- **Provenance.** About 14k teacher questions were generated by an OpenAI model under OpenAI's
  terms; replay data includes CC BY-SA sets; two dev variants were withheld over non-commercial
  data **[reported]**. Fine for a local experiment; review before shipping it as a default.
- **LM Studio risk [unverified].** Whether the GGUF's embedded Qwen3.5 chat template prefills the
  empty think block the model was trained on. If it does not, the first generated token may be
  `<think>`, and the adapter's position selection (§1) will have to skip it. Test with a raw probe
  before trusting accuracy.

### 3.2 Jev-Style v1 / v2 (chaoliangUNSW): the known-good plumbing check

- **v1 [verified card, client code].** Qwen3.5-2B-Base fine-tuned on 22k examples converted from
  SST-2, MNLI, AG News, BoolQ and SST-5; no Jev outputs used. The calibration temperature is
  folded into the final RMSNorm weight, so the runtime temperature is 1. ECE 0.017 on its own five
  tasks, 0.075 on unseen task types (base 0.155). Accuracy 82.3% on its 1,500 held-out items, but
  only 53.4% on the 2,000 "typed decisions" cited on the v3 card (v2 73.5%, v3 79.2%). The repo
  is archived. Files: Q8_0 2.1 GB, Q4_K_M 1.3 GB, BF16 3.9 GB. The repo ships a **pass-through
  chat template**, so a chat endpoint sends the user message verbatim.
- **Prompt [verified `jev_style_client.py`].** One user message, no system message:

  ```text
  You are a decision function. Read the state, then answer the question by choosing exactly one option.

  [State]
  {state}

  [Question]
  {question}

  [Options]
  A. {option 1}
  B. {option 2}

  Answer:
  ```

  Boolean questions use the options `yes` and `no` and return P(yes). Score questions use ordered
  levels and return the expected index. The client sends `max_tokens: 1`, `temperature: 0`,
  `logprobs: true`, `top_logprobs: 20`, reads `choices[0].logprobs.content[0].top_logprobs`,
  matches `token.strip() == letter`, and floors a missing letter at `min(top) - 5`. It uses the
  chat route because "LM Studio does not return candidate log-probs on `/v1/completions`".
  The page limits `top_logprobs` readout to 20 options.
- **v2 [verified card].** Same prompt, letters `A` to `Z`, 2 to 26 options, prompt up to 1,024
  tokens, macro accuracy 81.2% (v1 76.7%, Laya 75.1%), Q8_0 matches the CUDA bf16 choice on 99.2%
  of 500 items. The documented client uses llama.cpp's native `/completion`; LM Studio chat use
  is not documented. The card recommends v4 instead.
- **v3, v4, v4.2 are not usable here [verified card].** The v4.2 GGUF reads verdict hidden states
  dotted with the tied yes/no embedding difference, needs the custom `jev-score` binary built
  against a pinned llama.cpp, and says the LM Studio button "loads the GGUF as a chat model and
  does not produce decisions". The 0.8B v3 card says the same. v4 distils soft labels from the
  hosted Jev API.

### 3.3 Granite Guardian (IBM): best safety guard, BYOC yes/no

- **Output [verified cards, README].**
  - 3.0 / 3.1: the first generated token is `Yes` (risky) or `No`. 3.2 appends
    `<confidence> High </confidence>`.
  - 3.3 and 4.1: a hybrid think / no-think model. In no-think mode the output is an empty
    `<think>\n</think>` block followed by `<score>yes</score>` or `<score>no</score>`. The card's
    parser takes the last `<score>` match and lower-cases it.
- **Probability recipe [verified, IBM tutorial and evaluation README via search].** Request top-20
  logprobs, sum `exp(logprob)` of tokens that decode (stripped, lower-cased) to the risky token and
  to the safe token, then softmax over the two. The paper's improved variant sums every top-k
  token containing `yes` / `no`. Our `optionMasses` already does the equivalent for `noul`.
- **4.1 prompt [verified card].** The text under judgment goes in the preceding messages; the
  **final user message** is the guardian block:

  ```text
  <guardian>{mode instruction}
  ### Criteria: {criteria text}
  ### Scoring Schema: {schema}
  ```

  The first line sets the mode: it starts with `<no-think>As a judge agent, assess whether the
  provided text meets the given ...` and ends "Output empty <think>\n</think> tags followed by
  your score in <score></score> tags." (the middle of that string was truncated in my fetch, so
  copy it from the card). The schema for a user message reads "If the last user's text meets the
  criteria, return 'yes'; otherwise, return 'no'." The 4.1 chat template has no guardian logic (it
  is the stock Granite 4.1 template), so **bring-your-own criteria works through any plain chat
  call**. The 3.3 template instead selects criteria from `guardian_config` (its `criteria_id`
  bank: `harm`, `jailbreak`, `social_bias`, `violence`, `profanity`, `sexual_content`,
  `unethical_behavior`, `groundedness`, `answer_relevance`, `context_relevance`, `function_call`,
  `evasiveness`, `harm_engagement`) and defaults to `harm`; LM Studio did not honour
  `chat_template_kwargs` in our earlier test, so 3.3 would be stuck on `harm`.
- **Size and calibration.** 4.1-8B is Apache-2.0, 8B parameters, GGUF Q4_K_M 5.12 GB / Q8_0
  8.91 GB **[verified]**. Benchmarks **[reported, card]**: OOD safety F1 0.79 (no-think), function
  calling 0.79, IFEval multi-constraint BYOC 0.844, InfoBench BYOC 0.71 to 0.73. Calibration
  **[reported, arXiv:2511.10665]**: Granite Guardian 3.1 had ECE 0.047 (2B) and 0.087 (8B) before
  robustness training, against 0.26 to 0.28 for Llama Guard 3. A different paper
  (arXiv:2609.36477) reports Llama-Guard-3 ECE 0.013 and WildGuard 0.004 on clean inputs. Guard
  calibration results disagree across studies and metrics; measure on our own data.
- **Caveats [verified card].** "Must only be used strictly for the prescribed scoring mode";
  custom criteria "require testing"; English only; think-mode traces may be unfaithful.
- **Fit.** `command-risk` and `permission` as yes/no questions ("does this command send
  credentials off the machine, delete data irreversibly or change the whole system?"). A
  three-level `choice` needs two or three calls (§5). It cannot meaningfully rate `turn-outcome`.

### 3.4 Qwen3Guard-Gen, Llama Guard, ShieldGemma, Nemotron, WildGuard

- **Qwen3Guard-Gen [verified README, card].** Output `Safety: Safe|Unsafe|Controversial`, then
  `Categories: ...`; response moderation adds `Refusal: Yes|No`. The reference parser is
  `Safety: (Safe|Unsafe|Controversial)`. Prompt moderation passes a user message only; response
  moderation passes user plus assistant. The template builds the policy prompt, so the user
  message must be the raw text to judge. "Controversial" means harm is "context-dependent or
  subject to disagreement", which maps naturally to our `caution`. Fixed taxonomy (Violent,
  Non-violent Illegal Acts, PII, ... Jailbreak); no custom policy. The model is trained for strict
  and loose modes, not for logprob thresholds; I found no documented probability recipe
  **[verified: absence]**. Whether `Safe` / `Unsafe` / `Controversial` are single tokens in the
  Qwen vocabulary is **[unverified]**; check the returned `top_logprobs` strings.
- **Llama Guard 3 [verified card].** The card endorses first-token scoring: "we look at the
  probability for the first token, and use that as the 'unsafe' class probability". The template
  bakes in the 14 MLCommons categories (S1 to S14, including S14 Code Interpreter Abuse). The
  upstream repos are gated under the Llama licence. 1B has MLX (`mlx-community/Llama-Guard-3-1B-chat-mlx-4bit`)
  and many GGUFs. The category list is the fixed part: a shell command's destructiveness
  (`rm -rf ~`) is not one of them, so expect weak `command-risk` recall **[unverified]**.
- **ShieldGemma [verified card].** Scoring mode: softmax over the `Yes` / `No` logits at the last
  position, P(Yes) is the score. The prompt takes a policy ("guideline") string, so a custom
  command-risk policy is possible. Gemma terms, gated. The card warns it is "highly sensitive to
  how the safety principle is worded". Calibration is the weakest in the studies above (ECE 0.142
  to 0.325 **[reported]**). GGUF only.
- **Nemotron Content Safety [verified cards].** 4B fine-tunes of Gemma-3-4B-it. 3.5 outputs
  `User Safety: safe|unsafe` (optional `Response Safety`, `Safety Categories`) and takes
  `request_categories`, `enable_thinking` and `custom_policy` as template kwargs, which LM Studio
  will not pass. `Nemotron-Content-Safety-Reasoning-4B` takes a custom taxonomy in the prompt
  and a `/no_think` suffix, and answers `Prompt harm: harmful|unharmful`. Harmful-F1 0.85 on the
  vanilla suite, 0.857 custom **[reported]**. NVIDIA licence plus Gemma terms. Second-tier: needs
  an anchor and a Gemma-terms review.
- **WildGuard [verified card].** 7B Mistral, three lines (`Harmful request: yes`, `Response
  refusal: ...`, `Harmful response: ...`), Mistral `[INST]` wrapper. Gated; no official GGUF. Not
  pursued.

### 3.5 gpt-oss-safeguard and routers

- **gpt-oss-safeguard [verified card, cookbook].** 21B (3.6B active), Apache-2.0, in LM Studio's
  catalog; MLX MXFP4 and GGUF builds exist under `lmstudio-community`. The policy goes in the
  system message (harmony format), with `Reasoning: low|medium|high`, and the output is whatever
  you define (`0/1`, JSON with a category). The cookbook says not to cap output tokens tightly,
  because reasoning comes first. Our `lmstudio` schema caps `maxTokens` at 32, and the verdict
  tokens would sit after an unbounded analysis channel, so it does not fit the logprob contract
  without engine changes **[unverified]**. Park it.
- **Arch-Router-1.5B [verified card].** Qwen2.5-1.5B fine-tune, answers `{"route": "<name>"}`
  against a route list in `<routes>` / `<conversation>` tags. Official GGUF and a community MLX
  8-bit exist. Route names are free text, so the first-token probability over names works only if
  the names begin with distinct tokens **[unverified]**. Routing only; `routing-task-kind` is the
  one policy it could serve.
- **RouteLLM `causal_llm` [reported, Anyscale blog, HF listing].** Llama-3-8B classifier that
  emits one of five label tokens (`[[1]]`..`[[5]]`, added special tokens) and derives a win
  probability from their logits. No GGUF or MLX build found; skipped.

### 3.6 Strands, d3 and the other vllm-sr models: no generative variant

- **Strands Decider [verified, `docs/research/engines.md` §2 and the GGUF card].** LoRA adapters
  plus a pointer head over hidden states. The community GGUFs
  (`ArminBurkhardt/strands-decider-2B-qwen3.5-v1-2610-GGUF`,
  `fabricant451/strands-decider-2B-hobson-v19-GGUF`) are served by `llama-server --embeddings`
  plus a `decide.py` shim, and the card says the model "is not a chat model". Not usable through
  chat completions.
- **vLLM Semantic Router d3 and Decision 1.0 / 2.0 [verified HF API, cards].** All carry the
  `zero-shot-classification` tag; the Decision-2.0 cards say they return "a probability for every
  answer, without generating text" via `AutoModel(trust_remote_code=True).system_one`.
  `vllm-sr/d3-edge` has a llama.cpp conversion, `ggml-org/vllm-d3-edge-GGUF` (Q8_0 806 MB), meant
  for "the `/v1/systemone` API" via llama.cpp PR #30383. That is a custom llama.cpp server route,
  not LM Studio's chat API. It is worth knowing about because the gateway's `systemone-remote`
  engine could point straight at such a `llama serve`. The only generative vllm-sr model is
  `vllm-sr/qwen3_generative_classifier_r16`, a Qwen3-0.6B LoRA that writes an MMLU-Pro domain name
  (14 labels, multi-word, 65 to 70% accuracy); irrelevant here.
- **Other decision GGUFs.** `Mapika/decider-2b-GGUF` says it reads "the logits of option-letter
  tokens at each answer slot of a prompt built by `decider.prompt`" and that loading it in LM
  Studio "gives a text-continuation model, which ... is not how decider-2b is used". The prompt
  layout is not on the card, so it cannot be driven through chat without reading the `decider-ai`
  source **[unverified]**. `perplexity-ai/pplx-decider-flash-gguf-v1.2` says "stock `llama-server`
  does not implement this checkpoint's protocol v3" (joint readout at `<|fim_suffix|>` markers).
  Both are out.

## 4. Which policy each model can serve

| Policy (`policies/`) | Question shape | Letter-readout (JevK5, Jev-Style) | Granite Guardian 4.1 | Qwen3Guard-Gen / Llama Guard / ShieldGemma | Routers |
|---|---|---|---|---|---|
| `command-risk` | `choice`: safe / caution / dangerous | yes | yes, as yes/no questions | partly; a fixed taxonomy is the wrong notion of "risky command" | no |
| `permission` | `choice`: allow / ask / deny | yes | partly (`deny` only) | no | no |
| `turn-outcome` | `choice`: done / needs_input / stuck / failed, 3,000-token state | yes; keep the budget in mind (§3.1) | no | no | no |
| `routing`, `routing-task-kind`, `routing-budget` | 3 to 5 option `choice` | yes | no | no | Arch-Router for task kind |

The safety models answer "is this harmful" and nothing else. Only the letter-readout models take
an arbitrary question with arbitrary options, which is what all four policies need, so they are
the only candidates for `turn-outcome` and routing.

## 5. Mapping onto question → options → probabilities

- **Letter-readout models** map one to one. `choice` options become letters in YAML key order,
  `noul` becomes two options (`true`, `false`; for Jev-Style the texts `yes` / `no`), `score`
  becomes ordered levels. Probability per key = `softmax(letter logprob / T)` with the model's own
  `T`. Our `optionMasses` already does this once the label scheme and prompt layout are switched
  to the model's native ones.
- **Guards, binary (`noul`).** The state goes in as the text under judgment; the question's
  instructions or `criteria.true` text becomes the criterion. `P(true) = P(yes) / (P(yes) +
  P(no))`, which is what `optionMasses` computes.
- **Guards, `choice`.** Two options: one yes/no call. Three ordered options (command-risk):
  ask "is it at least caution?" and "is it dangerous?", then
  `P(dangerous) = d`, `P(caution) = max(c - d, 0)`, `P(safe) = 1 - c`, with `c` clamped at or above
  `d`. Two calls per question, each short. Qwen3Guard-Gen does it in one call: `Safe` → `safe`,
  `Controversial` → `caution`, `Unsafe` → `dangerous`.
- **Calibration.** Guards are binary classifiers tuned for recall on harm and tend to be
  overconfident [reported]. Do not reuse `command-risk`'s `minConfidence: 0.7` as-is; stay in
  `shadow`, then fit thresholds from `local-decider stats`.

## 6. Adapter changes per model

The engine keeps its generic prompt. A `profile` field on the `lmstudio` config (default
`generic`) would select the following. Everything else stays: `maxTokens`, `topLogprobs`,
`temperature`, `minCoverage`, `extraBody`.

| Profile | Messages | Label scheme | Position rule | Other |
|---|---|---|---|---|
| `generic` (today) | system + user | `yes`/`no`, letters, digits | first usable token | none |
| `jev-style` | user only, the template in §3.2 | letters `A`.. for all three types (`noul` → options yes/no; `score` → ordered levels) | the first (only) position | `maxTokens 1`, no `promptSuffix`, `topLogprobs 20`, `temperature 1`, cap 20 options |
| `jevk5` | system + user JSON (§3.1) | letters, but option keys `true`/`false` for `noul`, `0..n` for `score`, and `key: text` descriptions | first position; skip a leading `<think>` | `temperature 1.22`, cap 16 options, `maxTokens 1`; the 16-option knockout is out of scope |
| `granite-guardian` | the state as one user message, then the guardian block as a second user message; no system message | `yes` / `no` only (`noul`) | anchor: first position after the sampled text ends with `<score>`; stop at `</score>` | `maxTokens 12` to clear the empty think block; `choice` runs 2 to 3 calls (§5) |
| `qwen3guard` | the raw text as one user message; no system message, no suffix | map `safe` / `controversial` / `unsafe` onto question keys by config | anchor: first position after `Safety:` | verify the three words are single tokens; otherwise read the first sub-token |

Two generic engine changes carry all of this: (1) **anchored position selection**, replacing "first
non-blank token" with "first position after the accumulated text ends with the anchor", and (2)
**per-profile message layout** (system on or off, user-only, JSON user message). Neither touches
the wire contract.

## 7. Ranked shortlist to download and test

Memory is not a constraint: all four fit in 48 GB with room for LM Studio's own overhead. Order
of value, with the order I would actually run them in noted per entry.

**Step 0, before any download of the shortlist (control).** Re-run the existing Qwen3-1.7B probe
with the GGUF build and compare to the MLX build. This tests the §0 claim that logprobs depend on
the runtime, and costs one small model:

```sh
lms get https://huggingface.co/lmstudio-community/Qwen3-4B-Instruct-2507-GGUF --gguf --select
```

`Qwen3-4B-Instruct-2507` is non-thinking, so it avoids the `/no_think` problem. It also serves as
the general-model baseline that the decision models must beat.

1. **JevK5 4B v0.3, Q8_0 (4.48 GB).** Highest expected value: the only candidate that is
   purpose-trained for arbitrary typed decisions, calibrated (ECE 0.035), and large enough to
   follow `turn-outcome`. Test second.

   ```sh
   lms get https://huggingface.co/alibiserikbay/JevK5-GGUF --gguf --select
   ```

   Pick `jevk5-4b-v0.3-Q8_0.gguf`. Adapter: profile `jevk5` (§6): ChatML system prompt plus the
   user JSON, `temperature: 1.22`, `maxTokens: 1`, `topLogprobs: 20`. Confirm first that the
   embedded template prefills `<think>\n\n</think>\n\n`.

2. **Jev-Style v1 2B, Q8_0 (2.1 GB).** Test first. The only model with a third-party LM Studio
   chat-logprobs result, and the cheapest to wire up. Weak out of distribution and archived, so
   use it to validate the engine path, not as the production choice.

   ```sh
   lms get https://huggingface.co/chaoliangUNSW/Jev-Style-Qwen3.5-2B-Decision-GGUF --gguf --select
   ```

   Pick `Jev-Style-Qwen3.5-2B-Decision-Q8_0.gguf`. Adapter: profile `jev-style` (§6); the only
   thing the generic prompt lacks is the letter-for-everything scheme and the missing system
   message.

3. **Granite Guardian 4.1 8B, Q8_0 (8.91 GB; Q4_K_M 5.12 GB if latency matters).** The one guard
   with real custom-criteria support that survives a plain chat template, and the best-calibrated
   guard in the studies read. Serves `command-risk` and `permission`; cannot serve the other
   policies.

   ```sh
   lms get https://huggingface.co/ibm-granite/granite-guardian-4.1-8b-GGUF --gguf --select
   ```

   Adapter: profile `granite-guardian` (§6): guardian block as the last user message, anchored
   read after `<score>`, binary only.

4. **Qwen3Guard-Gen 4B, Q8_0 (4B parameters).** A three-level verdict (`Safe` / `Controversial` /
   `Unsafe`) that matches `command-risk`'s three options without a second call. Apache-2.0 and
   ungated; contrast case for the guard approach.

   ```sh
   lms get https://huggingface.co/mradermacher/Qwen3Guard-Gen-4B-GGUF --gguf --select
   ```

   Adapter: profile `qwen3guard` (§6): raw text, no system message, anchored after `Safety:`.
   Check that the repo's GGUF carries the Qwen3Guard chat template **[unverified]**.

**Test protocol for all four.** (a) A raw `curl` to `/v1/chat/completions` with `logprobs: true`,
`top_logprobs: 20` and `max_tokens: 12`; check that `choices[0].logprobs.content` is non-empty and
read which position holds the verdict. (b) Run `policies/fixtures/` through the gateway in
`shadow`. (c) Compare each model's P(correct) calibration (`local-decider stats`) with the
control from step 0.

**Not shortlisted, and why.** Llama Guard 3 and ShieldGemma (gated, fixed taxonomy, weaker
calibration in the studies read); Nemotron (needs template kwargs or an anchor plus Gemma-terms
review); WildGuard (gated, no GGUF); gpt-oss-safeguard (reasoning before the verdict, §3.5);
Arch-Router and RouteLLM (routing only); Jev-Style v3/v4/v4.2, d3, Decision 2.0, pplx-decider and
Strands (custom readout or head, §3.6).

## 8. Open questions

- **[unverified]** Whether the earlier null-logprobs measurement was an MLX build (§0, step 0).
- **[unverified]** The exact `<no-think>` instruction string for Granite 4.1 (copy it from the
  card), and whether a GGUF's embedded template reproduces the stock Granite 4.1 template.
- **[unverified]** Token boundaries for `Safe` / `Unsafe` / `Controversial`, `safe` / `unsafe`
  and `<score>` in LM Studio's returned `top_logprobs`.
- **[unverified]** Whether `lms get <HF URL>` accepts an `@quant` suffix.
- **[unverified]** JevK5 quality beyond 2,048 input tokens, and the license position of its
  teacher-generated training data for anything shipped as a default.
- **[unverified]** The calibration studies conflict; none used our policies.

## Sources

- LM Studio: `lms get --help` (local); <https://lmstudio.ai/docs/cli/get>;
  <https://github.com/nowledge-co/community/issues/929>.
- Letter-readout models: <https://huggingface.co/alibiserikbay/JevK5>,
  <https://huggingface.co/alibiserikbay/JevK5-GGUF>,
  <https://raw.githubusercontent.com/allebee/jevk5/v0.3.3/jevk5/prompt.py>,
  <https://huggingface.co/chaoliangUNSW/Jev-Style-Qwen3.5-2B-Decision-GGUF> (+
  `jev_style_client.py`), `...-v2-GGUF`, `Jev-Style-2B-Decision-v4.2-GGUF`,
  `Jev-Style-0.8B-Decision-v3-GGUF`, <https://huggingface.co/Mapika/decider-2b-GGUF>,
  <https://huggingface.co/perplexity-ai/pplx-decider-flash-gguf-v1.2>.
- Guards: <https://huggingface.co/ibm-granite/granite-guardian-4.1-8b>,
  <https://huggingface.co/ibm-granite/granite-guardian-4.1-8b-GGUF>,
  <https://huggingface.co/ibm-granite/granite-guardian-3.3-8b>,
  <https://huggingface.co/ibm-granite/granite-guardian-3.2-5b>,
  <https://github.com/ibm-granite/granite-guardian>, <https://arxiv.org/pdf/2412.07724>,
  <https://huggingface.co/Qwen/Qwen3Guard-Gen-8B>, <https://github.com/QwenLM/Qwen3Guard>,
  <https://huggingface.co/meta-llama/Llama-Guard-3-8B>, <https://huggingface.co/google/shieldgemma-2b>,
  <https://huggingface.co/nvidia/Nemotron-3.5-Content-Safety>,
  <https://huggingface.co/nvidia/Nemotron-Content-Safety-Reasoning-4B>,
  <https://huggingface.co/allenai/wildguard>, <https://huggingface.co/openai/gpt-oss-safeguard-20b>,
  <https://developers.openai.com/cookbook/articles/gpt-oss-safeguard-guide>.
- Calibration studies: <https://arxiv.org/html/2410.10414>, <https://arxiv.org/html/2511.10665v1>,
  <https://arxiv.org/html/2609.36477>.
- Routers and vllm-sr: <https://huggingface.co/katanemo/Arch-Router-1.5B>,
  <https://huggingface.co/routellm/causal_llm_gpt4_augmented>,
  <https://huggingface.co/vllm-sr/Decision-2.0-Nox-4B>,
  <https://huggingface.co/vllm-sr/qwen3_generative_classifier_r16>,
  <https://huggingface.co/ggml-org/vllm-d3-edge-GGUF>.
- HF API listings (2026-11-11): `/api/models?search=` for `granite-guardian`, `Qwen3Guard`,
  `llama-guard`, `shieldgemma`, `nemotron safety`, `wildguard`, `vllm-sr`, `decider`, `system-one`,
  `d3-edge`, `jev`, `gpt-oss-safeguard`, `Arch-Router`; `author=mlx-community&search=guard`.
- This repo: `packages/gateway/src/engines/openai/{index,logprob}.ts`, `docs/engines.md` §6,
  `docs/research/engines.md` §2, `docs/research/flm-decision-models.md` §1, `policies/*.yaml`.
