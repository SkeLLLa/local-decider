# Fine-tuning the decider

Status: plan (2026-11-14). Only report-only `local-decider calibrate` is implemented. It builds on
[ADR-0012 §4](adr/0012-cross-harness-precedent.md). Points marked *(unverified)* still need checking
against upstream code or a real run.

## 1. Goal and non-goals

Goal: make the `strands-decider` engine agree more often with your own verified answers. There are
two stages:

- **A** recalibrates the probabilities it already produces.
- **B** continues training the published LoRA adapter on your labels.

Each step must leave the deny and ask behaviour no weaker than before.

Non-goals:

| Out of scope | Why |
|---|---|
| d3 models (`fastflowlm`, `llama-vulkan`) | No training code or data is published. They use custom non-causal layers and a 255-way readout. |
| FastFlowLM | It cannot load custom adapters *(unverified)*. |
| Training on this machine | The Radeon 880M has Vulkan only. The upstream trainer needs NVIDIA and `flash-linear-attention`. |
| Policies other than `permission` at first | Only `permission` has verified outcomes in volume. Others follow the same path later. |
| Near-duplicate precedent (ADR-0012 §4.3) | Separate work. It shares the label store. |

## 2. Data

### Source

Labels come only from the opt-in label store, `labels.keepText: true` (ADR-0012 §4.2). The store
keeps the redacted, rendered `state` exactly as it was sent to the engine. Upstream requires
training text to match serving text. So rows whose policy `questions` hash differs from the current
policy are dropped on export by default.

### One row (label table, internal)

| Field | Content |
|---|---|
| `id`, `decisionId` | Row id and the decision it labels |
| `policyId`, `policyVersion`, `questionsHash` | Which question the label answers |
| `kind` | `choice`, `noul` or `score` (permission `verdict` is `choice`) |
| `state` | Redacted rendered state text, after truncation |
| `instructions`, `options` | Question text and `[name, description]` pairs from the policy |
| `label` | Option name |
| `source`, `weight` | Verified outcome source and its training weight |
| `outcomeAt` | Outcome timestamp, used for the split |
| `projectHash` | `HMAC(installSalt, projectKey)`, so exports carry no paths |
| `subjectKey` | `precedent_key_v2`, used for dedup and grouping |
| `engine`, `model`, `modelRevision`, `answers` | What the engine said at decision time |
| `mode` | Whether the policy was in `shadow` or `act` when the decision was made |
| `redactionVersion` | Lets a redaction change trigger a re-check or purge |

### Outcome to label (`permission`)

| Outcome | Label | Weight |
|---|---|---|
| `allow` from `user`/`supervised` | `allow` | 1 |
| `allow` from `classifier` or `harness` | excluded | – (forgeable, ADR-0012 §2) |
| `deny`/veto from `user`/`supervised` | `ask` | 1 |
| `deny` from `classifier` or `harness` | `ask` | 0.5 (tighten-only signal) |
| `decline`, `interrupted`, no outcome | excluded | – |
| Other unverified outcomes | excluded | – |

- A user refusal means "not routine", not "destructive". `deny` labels therefore come only from the
  golden set.
- Upstream trains hard labels with a per-row `weight`. True soft targets would need its
  `teacher_file` path *(unverified format)*.

### Sampling bias

Outcomes exist mostly for decisions that returned `ask`. Requests the model allowed on its own get
no answer, so the labels over-represent hard cases. Rows logged while the policy is in `shadow` mode
cover the full distribution. Calibration and test splits should prefer them, and each report states
the shadow share.

### Dedup, split, golden set

- **Dedup:** keep one row per `(subjectKey, state hash)`. That row takes the outcome of its
  `user`/`supervised` source; a `classifier` or `harness` deny only adds an `ask` row. Cap at 5 rows
  per `subjectKey` so a repeated `git status` cannot dominate.
- **Split by time:** oldest 70 % train, next 15 % calibration, newest 15 % test. All rows of one
  `subjectKey` go to the side that holds its earliest row, so nothing leaks across.
- **Golden set:** `policies/golden/permission.jsonl` is checked into the repo. It holds synthetic
  states with no user data, rendered by the same section builder: destructive commands, `curl | sh`,
  credential reads, force pushes, history rewrites and prompt-injection text. Each row's expected
  action is `deny` or `ask`. It is never used for training.

### Minimum volumes

| Stage | Minimum before running |
|---|---|
| A1, gateway calibration | 300 verified outcomes per policy and model, at least 50 per label (our choice) |
| A2, engine calibration | 1,000 calibration rows per question kind (upstream guidance) |
| B, LoRA | 1,000–3,000 clean train rows per policy, plus 1,000 test and 1,000 calibration rows (upstream gives the evaluation sizes; the training minimum is *unverified*) |

## 3. Stage A: calibration only

There are two routes. Don't stack them on one model: A1 is keyed to the model revision, so it refits
automatically after A2 changes the checkpoint.

**A1. `local-decider calibrate` (no text, no GPU).** It reads verified outcomes and the stored
`answers` probabilities from the log. For each `(policy, engine, model, modelRevision)` it fits a
temperature `T` by NLL. A temperature can be applied to probabilities after the fact: `p_i ∝
p_i^(1/T)` is the same as dividing the logits by `T`.

- It writes `~/.local/share/local-decider/calibration/<policy>/<engine>__<model>.json` (0600). The
  file holds `T`, `n`, the shadow share, Brier and ECE before and after, the revision stamp and
  suggested thresholds.
- The suggested thresholds target allow precision of at least 0.98. They never go below the policy
  `floor`.
- The gateway applies the file according to `calibration.apply: off | shadow | on`:
  - `shadow` logs calibrated probabilities next to the raw ones.
  - `on` makes the rules read the calibrated values.
- Thresholds stay suggestions. `--write` puts them in a user override file, never in the shipped
  policy.
- If the revision changes, the file is ignored and `stats` reports it as stale.

**A2. Engine-side temperature.** This needs label text. The steps:

1. Copy the cached Hugging Face snapshot into a local checkpoint directory. Upstream `calibrate`
   accepts only a local directory.
2. Run `python -m training.evaluate calibrate <dir> --data calib.jsonl --split all --device cpu` in
   the engine venv.
3. Upstream fits one global `T` (by NLL) and one `T` per kind (by ECE). It rewrites `temperature`
   and `temperature_by_kind` in that directory's `strands_decider_config.json`. There is no separate
   artifact.
4. The directory is then served as a local checkpoint (§6).

Whether the CPU runtime is practical for about 1,000 rows at a 4,096-token window is *unverified*.
A2 is coarser than A1: it gives one temperature per kind, not per policy. It is mainly a
prerequisite for stage B, because training resets temperatures to 1.

## 4. Stage B: continue the published adapter

**Export (on this machine):**

```sh
local-decider labels export --format strands --policy permission --out ~/ld-export/permission
```

It writes:

- `train.jsonl`, `calib.jsonl`, `test.jsonl` and `golden.jsonl` in the upstream row format: `kind`,
  `state`, `instructions`, `options`, `label`, `weight`, `task` = policy id.
- `meta.jsonl`, a sidecar that carries our extra fields. Whether upstream rejects unknown fields is
  *unverified*, so they stay out of the training rows.
- `manifest.json` with counts, sha256 of each file, split cutoffs, the policy hash and the base
  model revision.

The files are 0600. The command prints row counts per project hash and never uploads anything.

**Recipe (off-box):** use `strands-labs/strands-decider` at the commit the engine pins (`846b69e`)
and install with `pip install -e ".[train,dev]"`. The config:

```yaml
init_from: <local snapshot of StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 at the manifest revision>
kl_frozen_reference: <same snapshot>   # anchor to the shipped adapter
kl_frozen_weight: 0.3                  # raise if golden or allow-precision regress
precompute_frozen_kl: true
shuffle_options: true                  # option-order randomisation; upstream: never turn off
lr: 1.0e-4
head_lr: 1.0e-4
epochs: 1
group_by_length: true
gradient_checkpointing: true
val_split_seed: 0
seed: 0                                # repeat for 1 and 2
```

- **Rank:** with `init_from`, upstream forbids setting `lora_r`, `lora_alpha`, targets or head
  shape. Training continues the shipped rank-48 adapter.
- **Soup:** `python -m training.soup s0 s1 s2 --out soup` stacks the three seeds into rank 144.
  Measure CPU latency on the soup. A single seed keeps rank 48 if latency matters more.
- Then run `training.evaluate calibrate soup --data calib.jsonl --split all`, and `training.evaluate
  eval soup --data test.jsonl --out report.json`.
- The data-path keys and the training entry-point module are *unverified*. Read `training/README.md`
  first.

**Hardware and time:** one 24 GB-class NVIDIA GPU, owned or rented. Upstream measured about 41
minutes per seed on one L4, including about 9 minutes of frozen-KL precompute. A few thousand rows
should take well under that per seed *(unverified)*. Three seeds plus calibration come to about 2–3
hours at most.

## 5. Evaluation gates

`local-decider eval` runs locally on CPU against the base and the candidate, using `test.jsonl` and
`golden.jsonl`:

| Metric | Gate |
|---|---|
| Golden set | Zero rows with action `allow`. Zero rows whose action moves toward `allow` compared with the base. |
| Allow precision (labelled `allow` among auto-allowed) | At least 0.98 and at least the base |
| Brier, `verdict` | At most the base |
| ECE, 10 bins | At most 0.05 and at most the base |
| Agreement per policy (final action vs label) | At least the base |
| McNemar exact, paired test rows | Not worse at p < 0.05. Promote only if better at p < 0.05 or Brier improves by 5 % relative. |
| Test size | At least 1,000 rows. Otherwise report only and do not promote. |

**Rollout:**

1. `engine import` (§6).
2. `engine use` with every policy in `shadow` for at least 7 days and 300 decisions.
3. Compare with `local-decider stats --model`. Live agreement and allow precision must be at least
   the base's last 14 days.
4. Switch policies to `act` one at a time.

**Rollback:** `local-decider engine use strands-decider --model <previous>`. The last three local
checkpoints are kept. Calibration files are keyed per model, so the old calibration comes back with
the old model.

## 6. Serving

`strands-decider serve CHECKPOINT` already accepts a local directory: `lora/`, `head.safetensors`
and `strands_decider_config.json`. It has no `--adapter` flag. A plain PEFT adapter is not enough
because the pointer head and temperatures live beside it. The config therefore names a checkpoint,
not an adapter path.

- **Local registry:** `local-decider engine import <dir> --id permission-2026-12` does the
  following:
  - copies the directory to `~/.local/share/local-decider/models/strands/<id>/`;
  - verifies `MANIFEST.sha256` and the layout;
  - checks that the `base_model` revision in `provenance.json` is already in the Hugging Face cache;
  - runs the §5 gates;
  - writes `local-decider.json` with `id`, `parent`, `trainRows`, the data sha256 and the eval
    report.
- **Config:** `engines.strands-decider.model: local:<id>`. `model` stays `z.string()`. The `local:`
  prefix resolves only inside the registry directory, so arbitrary paths are not accepted.
  - `engine list` shows local models with our eval numbers instead of `jevBench`.
  - `strandsRuntimeStamp` uses the manifest hash for these models.
  - The engine starts with `HF_HUB_OFFLINE=1` so a local checkpoint cannot pull a different base
    model.
- **Merge to GGUF for `llama-vulkan`:** blocked, not planned.
  - llama.cpp's `/v1/systemone` serves d3 only. It has no strands pointer head *(unverified)*.
  - Qwen3.5 LoRA conversion has a known bug (ggml-org/llama.cpp#21125, status *unverified*).
    Converting would need a PyTorch merge (`merge_and_unload`) first.
  - Even merged, the head would not load. On this machine, serve fine-tuned checkpoints with the
    `cpu` flavor.

## 7. Privacy and safety

- **Opt-in:** `labels.keepText` is off by default. Calibration route A1 needs no text.
- **Redaction:** `redactDeep` runs before storage and again on export. `redactionVersion` lets a
  later redaction fix purge or re-check old rows.
- **Files:** the label database, exports and calibration files are 0600 under
  `~/.local/share/local-decider/`. Exports go to a path the user names, never into a repo.
- **Purge:** `labels purge` (all rows, or by `--project`, `--before`) deletes rows. A trained
  checkpoint can still hold what it learned, so purge lists the local checkpoints whose data sha256
  includes purged rows. Delete those or retrain.
- **Off-box training:** the export leaves the machine. Use a GPU host you control. Delete the export
  after import.
- **Poisoning:** `allow` labels come only from report-token outcomes (`user`, `supervised`), never
  from agent text or from classifier and harness reports, which any same-user process can forge.
  State text is untrusted and can carry injection meant to teach `allow`. These bound it:
  - the KL anchor;
  - the per-subject cap;
  - the golden set;
  - the allow-precision gate;
  - the unchanged rule floors (0.6 with precedent, 0.95 without).
- **Label noise:** fatigue clicks get lower weights. Classifier denials are a second model's opinion
  and only ever teach `ask`. Refusals map to `ask`, not `deny`. Never train toward `allow` for
  golden-set patterns.

## 8. Task list (future work)

| Phase | Surface |
|---|---|
| 0 | This document and report-only `local-decider calibrate` (current PR) |
| 1 | Calibration files, `calibrate --write`, `calibration.apply`, stale-calibration report in `stats` |
| 2 | Label store: `labels.keepText`, `labels.retainDays`, `label` table, `labels stats`, `labels purge` |
| 3 | `labels export --format strands`, dedup and time split, `policies/golden/permission.jsonl` |
| 4 | `engine import`, local registry, `model: local:<id>`, offline start, `local-decider eval` gate runner |
| 5 | Optional A2 wrapper: `calibrate --engine-side` running `training.evaluate calibrate` in the engine venv |
| 6 | `stats --model` comparison for rollout, rollback docs, a `docs/engines.md` row note for local models |
