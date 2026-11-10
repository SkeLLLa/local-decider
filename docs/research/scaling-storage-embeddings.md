# Scaling, storage and embeddings

Research note, 2026-11-11. It answers one question: how does the current design scale, and does
it need a database or embeddings for better performance or accuracy? The implementation plan that
follows from it is in [scaling-plan.md](scaling-plan.md).

Short answer: **no database and no embeddings now.** The engine queue is what hurts today. Two
safety problems come next: a privacy leak in the engine log and forgeable outcomes. With
retention, windowed stats and a worker thread, JSONL holds for years at today's volume. Embeddings
would add privacy and poisoning risk, and cheaper levers can probably get the same gain.

Markers follow the other research notes: **[verified]** means checked in code, on this machine or
in a primary source; **[unverified]** means a vendor claim, a secondary source or an estimate.

## 1. Method

- **Code read** on master with uncommitted work in progress:
  - `packages/gateway/src/{decider,precedent,shadow,stats,savings,server,queue,runtime,config}.ts`
  - `packages/gateway/src/engines/{lazy,supervised,fastflowlm}.ts`
  - `packages/core/src/{policy,hash,redact,truncate}.ts`
  - `packages/hooks/src/{mapping,subject,shell,guard}.ts`
  - `packages/paseo-plugin/server/{permission,history}.ts`
  - `policies/*.yaml`
- **Real log:** `~/.local/share/local-decider/logs/decisions-2026-11-10.jsonl` (952 records at the
  time), read with read-only scripts.
- **Synthetic logs:** generated in the real record format, with real hash-only records as
  templates. The mix was the real day's: 64% `command-risk`, 17% `turn-outcome`, 15% `permission`,
  4% `routing`. About 14% of records got outcomes, and about 3.5% of permission labels were denies.
- **Benchmarks:**
  - The real `ShadowLog`, `computeStats` and `PrecedentStore`, imported from source with
    `node --conditions=source`.
  - A `node:sqlite` equivalent on the same data.
  - Exact cosine search in plain JS.
  - The decider's CPU path: redact, render, build state, hash.
- **Machine:** AMD Ryzen AI 9 365, 61 GB RAM, Fedora 44, Node v26.13.0, FastFlowLM with `--pmode
  performance`, d3:mini.
- **Power state during every measurement:** on battery, BAT0 discharging, tuned `powersave`,
  `/sys/firmware/acpi/platform_profile` = `low-power`, and the `net.hadess.PowerProfiles`
  ActiveProfile = `power-saver`. Absolute latencies are therefore likely pessimistic.
  [scaling-plan.md](scaling-plan.md) step 0.2 gives the procedure to re-measure on AC with the
  performance profile.
- **Scratch scripts:** under `/tmp/ld-scale/{inspect,bench,sqlite,vec}`, not committed.

## 2. Facts checked against the code

| Claim | Status |
|---|---|
| Decisions, outcomes and usage are append-only JSONL, one file per UTC day, hashes only | Correct for `decisions-*.jsonl` (`shadow.ts`). **Wrong for the engine log**: see §3.1 |
| A day's decisions file is about 90 KB | **Out of date.** 2026-11-10 grew to 540–600 KB: 827 decisions, 118 outcomes, 7 usage records, about 570 B per record. Decision records average 630–720 B, outcomes 138 B |
| `stats` reads the whole log each time | Correct, and both `GET /v1/stats` (`server.ts`) and the CLI do it **synchronously on the event loop**: `readFileSync`, then `JSON.parse` of every line, then `computeStats`. Every decision waits while it runs |
| Precedent is an in-memory exact-match tally with a 10k-key LRU, rebuilt at startup and on policy reload from 90 days | Correct (`precedent.ts`, `runtime.ts:64`, `decider.ts:218`). But the largest `maxAgeDays` in any policy is 14 (`permission.yaml`), so 90 days reads about 6× more than needed. The rebuild also runs on every policy reload, which the file watcher triggers |
| The decision cache is keyed on the full state hash with TTL 0 | TTL 0 for `command-risk`, `permission` and `turn-outcome`; **600 s for `routing`, `routing-budget` and `routing-task-kind`**. Keyed by `inputHash({id, version, state, questions})`, at most 500 entries, cleared on policy reload and engine switch |
| One engine behind a queue of 8 waiting decisions | Correct (`QUEUE_MAX = 8`). The `SerialQueue` already orders by policy `priority` (high > normal > low, FIFO within each), but it never interrupts a running job and the limit of 8 is shared by all priorities. `command-risk`, `permission` and the routing policies are `high`; `turn-outcome` is `low` |
| d3:mini takes about 250–600 ms per decision | That is engine time for short states. Real end-to-end latency today includes the queue wait: see §3.3 |
| Learning is limited to precedent, an exact-match threshold lowering, and advisory calibration hints | Correct. Only `permission` has a `precedent` block. `command-risk`, the busiest policy, gets **no labels at all**, because the hooks cannot see the user's answer |
| The hooks have a read-only command classifier | **Not found.** The hooks have only the deterministic destructive-command guard (`guard.ts`, `shell.ts`) |
| Shadow decisions outlive the caller | Correct (`decider.ts:333`): a shadow decision uses a fresh signal, so it keeps its place in the engine queue after the hook has given up |
| Outcome rules | `stats` uses the **latest** outcome per decision (`computeStats`); precedent uses the **first** (`PrecedentStore.noteOutcome`). It is a deliberate split, but undocumented |
| Two subject normalisers | `hooks/src/subject.ts` and `paseo-plugin/server/history.ts` each build the subject string. They agree today; template keys should be computed once in the gateway (plan 5.2) |

## 3. Findings from the real log

### 3.1 The engine log stores state text [verified]

`logs/engine-fastflowlm.log` was 2 MB after one day, has no rotation, and contains the full
redacted state of each decision ("## Project … ## Command …"). `SupervisedEngine` writes the
child process's stdout and stderr to `logs/engine-<id>.log` (`engines/supervised.ts:125`). Secrets
are redacted before the engine sees them. Commands, history, paths and prompts are still
persisted, which contradicts "no state text is logged" in `architecture.md` and `security.md`.

### 3.2 Outcomes can be forged [verified in code]

`POST /v1/outcomes` takes `source` from the request body and defaults it to `user`
(`server.ts`, `parseOutcome`). In the default loopback mode with no token, any local process can
post one, including an agent's own shell tool:

1. Decision IDs are in the 0600 shadow log, which the same user can read.
2. The first outcome per decision wins (`precedent.ts:73`).
3. So an agent can trigger an escalated permission request, read its `decisionId` from the log
   tail, and post `allow` before the user answers.

Three such allows for one subject satisfy `minAllows: 3`. The current model answer must still give
p(allow) ≥ 0.6, so the damage is bounded, but the same forged labels also feed the calibration
hints. Every label-driven feature depends on fixing this.

Labels with source `supervised` come from a parent agent. That parent is an LLM that reads the
child's text, so they inherit any prompt injection the child carries. `permission` counts them for
precedent (`sources: [user, supervised]`), and `samplesForRule` in `stats.ts` counts every source
for the calibration hint.

### 3.3 Latency and the queue [verified on this machine, battery and power-saver]

Successful decisions on d3:mini, measured at the gateway (`latencyMs` includes the queue wait):

| Policy | n | p50 | p95 | Over 1.5 s | State tokens p50 / p95 |
|---|---:|---:|---:|---:|---:|
| `command-risk` | 209 | 836 ms | 3,070 ms | **55 (26%)** | 89 / 767 |
| `permission` | 124 | 885 ms | 3,646 ms | 37 (30%) | 200 / 1,062 |
| `routing` | 21 | 779 ms | 3,087 ms | 2 | 27 / 270 |
| `turn-outcome` | 116 | 1,710 ms | 9,609 ms | 67 | 606 / – |

- A `command-risk` state of about 90 tokens should take roughly 0.3–0.6 s on the NPU. The rest is
  waiting behind a running job. The queue never interrupts, so a running 600–3,000-token
  `turn-outcome` holds the NPU for 1.5–10 s, even though it is low priority.
- The hooks give up after 1.5 s and fail open. So about a quarter of `command-risk` checks did
  nothing today.
- The load was small:
  - peak 24 decisions a minute, 95th-percentile minute 15;
  - at most 5 sessions active in one minute, 1.8 on average;
  - about 3.5 decisions per active session per minute.
- Errors: 6 `engine unreachable: This operation was aborted` and 1 `engine starting` out of about
  500 engine decisions.
- Gateway CPU per decision, excluding the engine: **0.15 ms** for redact, sections, state build
  and two SHA-256 hashes on a 6,000-character permission input. A log append costs 5–9 µs. The
  gateway itself is never the bottleneck.

### 3.4 Repeats and caching [verified]

- `command-risk` input hashes repeat: 50 repeats out of 529 decisions. 25 came within 60 s and 37
  within 600 s, so a 600–3,600 s TTL would serve about 7% of `command-risk` calls from cache.
- Caching is safe here because the state is just project, tool and command. The engine is
  deterministic for the same input, and the cache is already cleared on policy reload and engine
  switch.
- `turn-outcome` had 2 repeats within 0.5 s, which look like duplicate Stop events. Coalescing
  in-flight requests would fold them.
- `permission` states include the conversation history, so they rarely repeat.

### 3.5 Labels [verified]

- About 89 escalated `permission` decisions a day got user labels: 79 allow, 3 deny, 7 neither.
  That is a deny rate of about 3.5%.
- `turn-outcome` got about 27 labels a day from the "Right answer?" buttons.
- `command-risk` got none.
- Precedent keys only started being logged at 21:51 UTC. In that window: 25 distinct keys, 4
  seen more than once, at most 3 labels on any key. So exact-match precedent rarely fires.

p(allow) of the 65 user-labelled `permission` asks on d3:mini, using the first outcome:

| p(allow) band | Allowed | Denied | Other |
|---|---:|---:|---:|
| 0.00–0.50 | 17 | 1 | 3 |
| 0.50–0.60 | 6 | 1 | 3 |
| 0.60–0.70 | 4 | 1 | 0 |
| 0.70–0.80 | 11 | 0 | 0 |
| 0.80–0.90 | 13 | 0 | 0 |
| 0.90–0.95 | 5 | 0 | 0 |

- The three denies sat at p = 0.34, 0.56 and **0.69**.
- In this sample, an allow threshold of 0.7 would have auto-allowed 29 of the 65 prompts (45%),
  and 0.8 would have auto-allowed 18 (28%), with no observed deny above either.
- n is far too small to act on: with 0 denies in 29, the Wilson 95% upper bound is about 12%.
- The existing hint rule (n ≥ 100 and Wilson upper ≤ 2%) needs about 189 labels with 0 denies
  above the threshold. At about 30 labels a day in the 0.7–0.95 band, that is roughly a week.
- d3:mini looks under-confident on benign requests. For a single allow threshold, calibration is
  the same thing as choosing the threshold: temperature or isotonic scaling is monotone, so it
  changes nothing beyond what moving the threshold does.

## 4. Scaling of the current design

### 4.1 Volumes

| Scenario | Records/day | Size/day | Month | Year | Records/year |
|---|---:|---:|---:|---:|---:|
| Today, one user, about 5 agents at peak | ≈1,000 | 0.55–0.6 MB | ≈17 MB | ≈210 MB | ≈350k |
| Heavy: 20 parallel agents, 10k decisions a day | ≈11,400 | ≈6.7 MB | ≈200 MB | ≈2.4 GB | ≈4.1M |

Neither row counts the engine log, which is unbounded today (2 MB/day) and holds state text
(§3.1). Nothing deletes old logs: there is no retention or rotation code.

### 4.2 Stats and precedent rebuild [verified]

Real gateway code on synthetic logs. "Stall" is how long the event loop is blocked, which is the
time the read and the computation take together.

| Log | Records | MB | `read()` | `computeStats` | Stall | Heap for records | RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1k/day × 90 d | 102k | 60 | 383 ms | 233 ms | ≈0.6 s | 81 MB | 341 MB |
| 1k/day × 365 d | 414k | 243 | 1,353 ms | 799 ms | ≈2.2 s | 298 MB | 565 MB |
| 10k/day × 90 d | 1.02M | 600 | 4,353 ms | 2,438 ms | ≈6.8 s | 655 MB | 1,994 MB |
| 10k/day × 365 d | 4.15M | 2,431 | 24,912 ms | 9,227 ms | **≈34 s** | 2,661 MB | **3,892 MB of a 4,395 MB heap limit** |

Precedent rebuild at startup and on every policy reload, with `readRecent(90)` and `rebuild`:

| Rate | `readRecent(90)` | `rebuild` | Total |
|---|---:|---:|---:|
| 1k/day | 306–318 ms | 25–39 ms | ≈0.35 s |
| 10k/day | 4,210 ms (11,060 ms under heap pressure) | 1,124–1,164 ms | 5–12 s |

Parsing alone, without materialising records, cost about 70% of `read()` (264 ms for 102k
records), so a streaming parser saves memory, not much time. What cuts time is a smaller window
(14 days instead of 90) and not repeating the work.

### 4.3 Gateway memory

Steady-state memory is small:

- precedent: three maps of at most 10k entries each (about 2–3 MB);
- the decision cache: at most 500 entries;
- the call store: 10 minutes of entries;
- a 200-sample latency window.

The peaks come from transient reads: about 80 MB of heap per 100k records materialised.

### 4.4 Precedent LRU

The 10k-key limit evicts subjects only when more than 10k distinct labelled subjects fall within
`maxAgeDays` (14), which is about 700 distinct labelled subjects a day. That happens only in the
heavy case. Pending escalated decisions (`#decisions`) are removed when their first outcome
arrives, so they stay well under 10k even at 10k decisions a day.

### 4.5 Engine capacity

- At 0.6–1.0 s of NPU time per decision, one d3:mini serves roughly 60–100 decisions a minute
  [unverified estimate from §3.3].
- 20 agents at 3.5 decisions a minute is about 70 a minute, which is about the capacity: the queue
  would fill and decisions would fail open in bulk.
- FLM serves one request at a time, and two FLM decision servers contend for the NPU and slow each
  other down ([flm-decision-models.md](flm-decision-models.md) §6). The only scaling levers are
  doing less work and dropping work that no one will use (plan Phase 2).

### 4.6 Multiple processes and machines

- **Writers:** only the gateway appends to the log. The CLI's `stats` only reads.
  `appendFileSync` of a line under 1 KB with `O_APPEND` is effectively atomic on local Linux
  filesystems (ext4, btrfs, xfs), but POSIX doesn't guarantee it and NFS breaks it.
- **Two gateways:** two gateways on one data directory would each keep their own precedent, and
  the port normally prevents it anyway.
- **Several Paseo hosts or machines sharing one gateway:** that needs a non-loopback bind with a
  token, and all of them would share one NPU. The NPU is per machine, so run one gateway per
  machine. If labels ever need sharing, export and import hash-only precedent, not the gateway.

### 4.7 Crash safety

- **Process crash:** nothing is lost, because each append is complete before the call returns.
- **Power loss:** there is no fsync, so the last lines can be lost and the last one torn. A torn
  line without `\n` merges with the next append, and `parseLine` then skips both. That loses two
  records, rarely. The fix is to repair a missing trailing newline before the first append (plan
  1.4).

### 4.8 Scaling table

| Volume | Bottleneck | When it bites | Fix |
|---|---|---|---|
| Today: peak 24/min, 5 sessions | Single engine, no interruption; long `turn-outcome` jobs block high-priority hooks | **Now**: 26% of `command-risk` over budget | Plan Phase 2 |
| 20 agents ≈ 70/min | Engine capacity ≈ 60–100/min | Queue full, decisions fail open in bulk | Phase 2 cuts the work; one NPU can't do more |
| ≈100k records (3 months now) | `stats` blocks the event loop | 0.6 s stall per stats call | Phase 3 window and worker |
| ≈400k (1 year now) | same | 2.2 s | Phase 3 |
| ≈1M (90 days at 10k/day) | same | 6.8 s, 2 GB RSS | Phase 3 |
| ≈4M (1 year at 10k/day) | same, plus memory | 34 s, close to OOM | Phase 3; SQLite trigger T1 |
| Startup or policy reload | 90-day rebuild | 0.35 s now; 5–12 s at 10k/day | Phase 3.3: 14-day window, skip when unchanged |
| Disk | No retention | 210 MB/year now, 2.4 GB/year heavy; engine log 2 MB/day | Phase 1.2–1.3 |
| Precedent LRU 10k | Older keys evicted | More than ≈700 distinct labelled subjects/day | Raise to 50k with template keys (Phase 5.3) |
| Two gateways on one data dir | Divergent precedent | Only if someone runs two | One gateway per machine; SQLite trigger T3 |
| Machines sharing one gateway | One NPU for all | Immediately | Don't |
| Power loss | Torn last line drops 2 records | Rare | Phase 1.4 |

## 5. Do we need a database?

### 5.1 Query needs

| Need | JSONL today | JSONL after the plan | SQLite |
|---|---|---|---|
| Stats windows (7/30/90 days, per scope) | Full read | Windowed read in a worker | Indexed range scan |
| Precedent lookup on the hot path | In-memory Map, O(1) | Same | Same Map; the database is only for rebuilds |
| Precedent rebuild | 90-day read | 14-day read, skipped when unchanged | One aggregate query |
| Agreement per policy and scope | Full read | Windowed | `GROUP BY scope, policy` |
| Reviewing disagreements | Possible by ID, time and probabilities only (no text) | Same | Same; text is the limit, not storage |
| Mutable rows (label corrections, review status) | Awkward in append-only files | Same | Natural |

### 5.2 SQLite benchmark [verified]

- WAL mode, `synchronous=NORMAL`, the real record fields as columns, and indexes on
  `(policy, ts)`, the partial precedent key, and `outcome(decision_id)`.

| Data | Bulk load | DB size | All-time `GROUP BY policy, action` | 30-day join with outcomes | 90-day precedent aggregate | One-key precedent lookup |
|---|---:|---:|---:|---:|---:|---:|
| 1k/day × 365 (414k) | 6.4 s | 211 MB | 365 ms | 68 ms | 109 ms | 27 µs |
| 10k/day × 90 (1.02M) | 14.8 s | 521 MB | 955 ms | 550 ms | 546 ms | 676 µs |

- A single insert as its own transaction costs about 16 µs, against 5–9 µs for a JSONL append.
- The database is about 0.87× the size of the JSONL.
- SQLite is about 7× faster than the current all-time JSONL path at 1M records. Most of that gain
  comes from windowed queries and from not holding every record in the JS heap. A windowed JSONL
  read in a worker gets most of the same benefit for far less change.

### 5.3 node:sqlite status

- **History:** in Node since v22.5 behind `--experimental-sqlite`; unflagged since v22.13 and
  v23.4; Stability 1.2 "Release candidate" since v25.7 (Node docs) and v24.15 (secondary source)
  [verified for v25.7; v24.15 unverified].
- **API changes in Node 26:** v26.10 binds `undefined` as NULL; v26.11 renamed `DatabaseSync` to
  `Database` and kept `DatabaseSync` as a deprecated alias (DEP0210). On v26.13 here, the module
  exports both `Database` and `DatabaseSync`, and printed no experimental warning [verified].
- **Bundled SQLite:** 3.54.0 [verified].
- **Extensions:** `loadExtension()` and `enableLoadExtension()` exist but need the constructor
  option `allowExtension: true`. Without it, loading fails with `ERR_INVALID_STATE` [verified],
  and it can't be turned on later. Under Node's `--permission` model, loading an extension throws
  `ERR_LOAD_SQLITE_EXTENSION`.
- **Gaps:** no encryption at rest. It is synchronous, so a query on the main thread blocks it just
  like the current reads do.

### 5.4 Options compared

| Option | Native code | Fits the query needs | Multiple processes | Migration and backup | Privacy | Cost to users | Verdict |
|---|---|---|---|---|---|---|---|
| JSONL with retention, windows and a worker (plan) | None | Yes at today's volume, for years | One writer; CLI reads | None; files are the backup | Hash-only | None | **Now** |
| SQLite via `node:sqlite` | None (built into Node) | Yes, including mutable rows | WAL, one writer, read-only readers | Import and export tools; `VACUUM INTO` backups | Hash-only; no encryption | None; Node ≥ 24.15 | **When a trigger fires** |
| DuckDB (`@duckdb/node-api`) | 96 MB native binary per platform | Excellent analytics | Single writer | Can read the JSONL directly | AES-256-GCM since 1.4 | Large install | Reject for the runtime. Fine as a personal analysis tool over exported JSONL |
| Embedded key-value stores (LMDB, classic-level, RocksDB) | Native | Key→value only, no windows | Varies | Custom | – | Native builds | Reject |
| PGlite | 26 MB WASM | Full Postgres | Single process | Custom | No encryption | Large | Reject; it's the WASM runner-up if SQLite were ever unavailable |

Recommendation and triggers T1–T5: [scaling-plan.md](scaling-plan.md) section B.

## 6. Would embeddings improve accuracy?

### 6.1 How many labels one user produces

| Policy | Labels per week | Denies or rare-class labels per week | Notes |
|---|---:|---:|---|
| `permission` | ≈450–600 | ≈15–20 denies | Paseo only; escalated decisions only |
| `turn-outcome` | ≈190 | `stuck` is rare (1 per day) | "Right answer?" buttons |
| `command-risk` | 0 | 0 | Hooks can't see the answer |
| `routing` | 0 labels; ≈50 usage records | – | Savings only |

- A learned model for `command-risk`, the busiest policy, is impossible without labels.
- `permission` has plenty of allow labels but few denies. Any learned allow region is estimated
  almost entirely from allows. Bounding the false-allow rate on dangerous requests needs hundreds
  of denies, which at 15–20 a week takes about 6 months to reach 100–500.

### 6.2 Options

| Option | What it needs | Expected gain | Risk | Call |
|---|---|---|---|---|
| Similarity precedent: allow when nearest labelled neighbours were allowed | An embedding model; stored vectors, or text, for the labelled subjects | Small over template keys (§7.3); near-identical repeats are already covered by exact and template keys | **Near-misses**: `rm -rf ./build` vs `rm -rf ~/build`, `git push` vs `git push --force`, `cat a` vs `cat ~/.ssh/id_ed25519` embed almost identically. The neighbour's label is controlled by whoever produced it (see §3.2). Stored vectors can be inverted (§6.4) | **Reject** |
| kNN or few-shot examples in the prompt | Stored text, which breaks the hash-only log | Small; the model already sees context | The token budget (`command-risk` 1,000; the NPU cost grows with tokens); re-injects past attacker-controlled text into new decisions (ADR-0006) | **Reject** |
| Embedding-based routing | Labels on routing quality | Not measurable: there are no routing labels | Low | **Reject** until routing outcomes exist |
| Small classifier head trained on embeddings from our labels | An embedding model plus ≥2,000 labels including ≥100 denies (about 6 months); FLM can't expose the decision model's hidden states, so it needs a separate embedder | Marginal over a calibrated threshold: the base model already separates today's denies (all ≤ 0.69) | Class imbalance; drift when the model or policy changes; same poisoning surface as precedent | **Defer** (trigger in the plan) |

### 6.3 Embedding models and runtimes

| Option | Size | Runtime and dependencies | Latency and memory | Verdict |
|---|---|---|---|---|
| `bge-small-en-v1.5` (384-d, MIT) via Python `fastembed` 0.9.1 in its own uv venv | 34 MB int8 (133 MB fp32) | onnxruntime and numpy in Python; no Node native modules; managed like an engine process | ≈5–15 ms per short text on CPU, ≈150–250 MB RAM [unverified; measure] | **Pick, if ever** |
| `gte-small` (384-d) | 34 MB int8 | Same | Same | Equivalent alternative |
| `all-MiniLM-L6-v2` (384-d) | 23 MB int8 | Same | ≈8–12 ms per sentence in browser WASM on an M2 [unverified] | Smaller, weaker |
| EmbeddingGemma-300M (768-d; Matryoshka truncation to 512/256/128) | 309 MB int8, 197 MB q4 | Gemma licence terms, not Apache | Vendor: under 15 ms for 256 tokens on EdgeTPU, under 200 MB RAM quantised [unverified] | Reject: licence and size |
| FastFlowLM `embed-gemma:300m` on the NPU | – | `flm serve -e` or `--embed 1` | Contends with the decision model on the NPU | **Reject**: wrong vectors from v0.9.45 until fixed ([#732](https://github.com/ROCm/FastFlowLM/issues/732)); intermittently collapsed vectors on HRX ([#939](https://github.com/ROCm/FastFlowLM/issues/939)); the task prefix is ignored ([#758](https://github.com/ROCm/FastFlowLM/issues/758)) |
| transformers.js (`@huggingface/transformers` 4.3.2) | – | Hard-depends on `onnxruntime-node` (308 MB, postinstall download that `allowBuilds` blocks), `onnxruntime-web` (151 MB) and `sharp` | – | Reject: dependency policy |
| strands-decider hidden states | – | The Strands engine is LoRA plus a pointer head on Qwen3.5. The hidden states exist inside it but aren't exposed by `serve`, and FLM can't run Strands | – | Not available |

### 6.4 Privacy of stored vectors

Vectors are roughly as revealing as the text they came from:

- [Vec2Text](https://arxiv.org/abs/2310.06816) (EMNLP 2023) recovers 92% of 32-token inputs
  exactly from GTR-base embeddings, and full names from clinical notes.
- [TEIA](https://arxiv.org/abs/2406.10280) (ACL 2024) transfers inversion attacks through a
  surrogate encoder, without querying the target model.
- [ALGEN](https://arxiv.org/html/2502.11308v1) (ACL 2025) inverts with about 1k leaked pairs, and
  none of the defences tested worked.
- [ZSInvert](https://arxiv.org/html/2504.00147) needs no trained decoder, only black-box access to
  the encoder, and attacks GTE directly: F1 about 53 at 0.94 cosine on MS-MARCO, and 82% leakage
  on Enron emails as judged by an LLM.
- [Zero2Text](https://arxiv.org/abs/2602.01757) (2026) works without training and across domains,
  and reports that differential privacy doesn't stop it.
- No paper found attacks bge-small specifically. Treat it as vulnerable.

So stored vectors break the hash-only rule just as stored text would. Keeping them only in memory
avoids storage, but then nothing survives a restart without text to re-embed. Any embedding
feature therefore requires an explicit opt-in local label store.

### 6.5 Poisoning and injection

- **Who controls the text:** agent prompts and tool inputs are untrusted. An attacker can shape a
  command to sit near an allowed neighbour while doing something different. Exact and template
  keys can't be "nudged" that way; similarity can.
- **Who controls the labels:** until plan 1.1 ships, any local process can post a "user" label.
  Supervised labels come from an LLM parent that reads the child's text.
- **How similarity amplifies a bad label:** one bad label would generalise to a neighbourhood of
  commands, where exact precedent affects only one subject in one project.

## 7. Cheaper accuracy levers

### 7.1 Ranked by expected gain per unit of effort

| Rank | Lever | Effort | Expected gain | Evidence |
|---:|---|---|---|---|
| 1 | Per-policy, per-model threshold calibration from verified user labels (existing hint, restricted to verified user labels, plus band tables) | S | 30–45% fewer `permission` prompts if the 0.7–0.95 band stays deny-free at n ≥ 189 | §3.5 |
| 2 | Queue fixes: budgets, demoting aborted shadow jobs, a quiet period before low-priority jobs, coalescing, a `command-risk` TTL | M | Recovers the ≈26% of `command-risk` checks that fail open today | §3.3, §3.4 |
| 3 | Template-normalised precedent keys (command, subcommand, flags, operands collapsed; strict allowlist) | M | Unknown; must be measured (E2). Bounded by repeat structure | §3.5 |
| 4 | Better state and context | Done | The big jump already happened | – |
| 5 | Engine model choice (d3:nano / mini / flash) on fixtures | S to measure | d3:mini is the calibrated default; flash is too slow for hooks (≈2.3–3.5 s) | [flm-decision-models.md](flm-decision-models.md) §6 |
| 6 | Policy wording and fixtures with `policies eval` | S, ongoing | Removes systematic confusions | – |
| 7 | Structured command features as a deterministic state section, e.g. `Command class: git read` | M | Only where E4 shows confusions a feature would fix | – |
| – | Temperature or isotonic scaling | – | None beyond lever 1 for a single threshold; only useful for the reported confidences and Brier score | §3.5 |

### 7.2 Why calibration first

Today's labelled prompts show a clean region (0.7–0.95, 29 of 29 allowed) and denies only below
0.7. The existing Wilson rule turns that into a safe, auditable threshold once enough verified user
labels accumulate. No new state, storage or model is needed.

### 7.3 Template keys

A template key generalises along a fixed, reviewable axis, the operands of known read-mostly
commands, rather than an opaque similarity:

- It stays hash-only, per project, and exact-match on the template.
- Compound commands, redirection, command substitution and privilege prefixes get no template.
- Any command or subcommand outside the allowlist gets no template.

It can be measured from hash-only logs: log `templateKey` next to `precedentKey` for a week, then
compare hit rates and look for templates with mixed labels.

## 8. Performance

### 8.1 Hot-path latency per tool call

Gateway work is about 0.15 ms; the engine is 0.3–2 s; the queue wait is anywhere from 0 to more
than 10 s. A database lookup (27–676 µs) or an in-memory vector search (6 ms over 10k vectors)
would be noise next to the engine. An embedding model on CPU would add about 5–15 ms
[unverified], or NPU contention if it ran on FLM.

### 8.2 Queue

The priority order exists already, but a job that has started always runs to the end. Three
things make the tail worse:

1. Long low-priority `turn-outcome` jobs block high-priority hooks once they start.
2. Shadow jobs whose caller has gone keep their priority.
3. The queue limit of 8 is shared, so held-back low jobs could lock out hooks.

The plan's Phase 2 addresses all three.

### 8.3 Batching and concurrency

- FastFlowLM serves one request at a time. strands-decider supports `--max-batch 8` on CPU, but
  the gateway queue never sends more than one job at a time, so that batching is unused.
- Allowing concurrency up to `maxBatch` would help CPU users only. CPU decisions are 1.2–20 s and
  too slow for hooks anyway, so this is a low priority.

### 8.4 Caching identical states

- A TTL above 0 helps `command-risk`: about 7% of its calls repeat within 600 s.
- Coalescing identical in-flight requests helps duplicate events.
- A TTL doesn't help `permission` (the history changes) or `turn-outcome`.

### 8.5 Would a database or embeddings slow the hot path?

- **SQLite:** not if precedent stays an in-memory Map. Only the 16 µs append would change.
- **Embeddings:** yes. An embedding call before each decision adds 5–15 ms on CPU, or NPU
  contention on FLM, plus another process to supervise.

## 9. Embedded vector stores for Node

The research agent checked versions, dates, sizes and install scripts on `registry.npmjs.org`,
and read the Orama, Vectra, better-sqlite3 and sqlite-vec tarballs.

The scale is thousands to about 100k vectors of 384–768 dimensions. At that scale, exact search is
fast enough: LanceDB's docs say brute force is often enough up to about 100k rows, and plain JS
measured here took **6.3 ms at 10k × 384, 57 ms at 100k × 384 (154 MB) and 116 ms at 100k × 768
(307 MB)**.

| Option | Native code | Licence | Latest (date) | Storage and crash safety | Index; exact search | Non-vector needs | Encryption | Size |
|---|---|---|---|---|---|---|---|---|
| `@lancedb/lancedb` | Native Rust addon, 8 per-platform optional packages, no install script | Apache-2.0 | 0.41.0 (2026-10-29); 0.42 betas almost daily | Lance format: atomic, versioned manifest commits | IVF_PQ, IVF_RQ, IVF_HNSW_SQ/PQ/FLAT; exact via `bypassVectorIndex` | SQL-style filters; GROUP BY not verified | None found [unverified] | 1.5 MB + **215 MB** linux-x64 binary |
| sqlite-vec with `node:sqlite` | `vec0.so` (160 KB), a SQLite loadable extension in 5 platform optional packages; no linux-musl | MIT or Apache-2.0 | 0.1.9 (2026-03-31); 0.1.10-alpha.4 (2026-05-18) | SQLite WAL, full ACID | Stable: brute force (float, int8, bit). Alpha: DiskANN, rescore. IVF experimental, not enabled | Full SQL | Not in `node:sqlite` | ≈165 KB |
| sqlite-vss | Native (Faiss) | MIT or Apache-2.0 | 0.1.2 (2023-08) | SQLite | Faiss | SQL | – | Abandoned in favour of sqlite-vec |
| `@orama/orama` + persistence plugin | Pure JS | Apache-2.0 | 3.1.18 (2025-12-19); no release for 11 months | Snapshot only: whole file rewritten with `fs.writeFile`, no temp file and rename, so not atomic | Brute-force cosine over a Map; default similarity threshold 0.8 | Facets and filters; no time-window aggregates | None | 2.2 MB + 116 KB |
| Vectra | Pure JS | MIT | 0.15.0 (2026-05-24) | `index.json` rewritten in place, not atomic | Brute force, heap top-k | None | None | 2.2 MB, plus heavy dependencies (openai, @grpc/grpc-js, cheerio, yargs, wink-nlp) |
| hnswlib-node | Native; `node-gyp rebuild` install script needs a C++ toolchain | Apache-2.0 | 3.0.0 (2024-03), stale | Whole binary file via `writeIndex` | HNSW | None | None | 196 KB |
| hnswlib-wasm | WASM | Apache-2.0 | 0.8.2 (2023-07), stale | IDBFS (browser) | HNSW | None | None | 3 MB |
| `usearch` | Native; `node-gyp-build` with bundled prebuilt binaries | Apache-2.0 | 2.26.5 (2026-10-18), active | Save and load an index file; crash safety undocumented | HNSW-style graph and exact scans | None | None | **25 MB** |
| DuckDB VSS (`@duckdb/node-api`) | Native, 6 platform packages; the `vss` extension is downloaded at runtime | MIT | 2.0.0-r.1 (2026-10-21) | DuckDB WAL, but storing the HNSW index on disk is experimental: WAL recovery "not properly implemented", the index must fit in RAM and is rewritten at every checkpoint | HNSW; exact via `array_distance` | **Full analytical SQL** | AES-256-GCM since 1.4 | **96 MB** linux-x64 |
| PGlite + `@electric-sql/pglite-pgvector` | WASM | Apache-2.0 | 0.5.16 and 0.0.17 (both 2026-11-09), roughly weekly | Postgres WAL inside WASM over NodeFS; how flushes reach disk is undocumented [unverified] | pgvector: HNSW, IVFFlat, exact | **Full Postgres SQL** | None | **26 MB** |
| `@zvec/zvec` (Alibaba Proxima) | Native; install script plus 8 binding packages | Apache-2.0 | 0.8.0 (2026-10-27) | RocksDB-backed [unverified] | HNSW, IVF, flat [unverified] | None | None | 41 MB linux-x64 |
| Voy (`voy-search`) | WASM (Rust) | MIT or Apache-2.0 | 0.6.3 (2023-09), stale | Serialise to a string | k-d tree | None | None | 207 KB |
| client-vector-search | Pure JS | MIT | 0.2.0 (2023-11), stale | – | Brute force | None | None | Pulls in `@xenova/transformers` |
| `vectordb` | Native | – | Deprecated ("Use @lancedb/lancedb") | – | – | – | – | – |
| Chroma (`chromadb` 3.5.0) | – | Apache-2.0 | 3.5.0 | **Server only for JS.** Embedded mode is Python only | – | – | – | – |
| Qdrant (`@qdrant/js-client-rest` 1.20.0) | – | Apache-2.0 | 1.20.0 | **REST client only.** Qdrant Edge runs in-process, but only for Python and Rust | – | – | – | – |

**Supply chain:**

- The workspace has `minimumReleaseAge: 4320` (3 days), `trustPolicy: no-downgrade`, and
  `allowBuilds` limited to `esbuild` (`pnpm-workspace.yaml`).
- Packages with install scripts (`hnswlib-node`, `usearch`, `@zvec/zvec`, `onnxruntime-node`)
  would need explicit approval.
- LanceDB's near-daily betas don't trip `minimumReleaseAge`, because only `latest` resolves.
- better-sqlite3 13.0.3 bundles prebuilt binaries for 8 platforms (27 MB, no install script). The
  SQLCipher variant `better-sqlite3-multiple-ciphers` is 34 MB. Both are native.

**Pick, if vectors are ever approved:** a `node:sqlite` table with int8-quantised vectors as BLOBs
and exact top-k in plain JS. It needs no dependency, handles 100k vectors in tens of
milliseconds, and the same database serves the stats and precedent queries. Rejected:

- **sqlite-vec:** a native binary per platform, version 0.1.x, needs `allowExtension`, and throws
  under `--permission`. Revisit only above about 100k vectors.
- **PGlite:** the only actively released pure-WASM option and the runner-up, but it is a full
  Postgres for needs SQLite already covers.
- **Everything else:** native code, non-atomic persistence, stale maintenance, or no in-process
  Node mode.

## 10. Sources

- Node.js `node:sqlite`: <https://nodejs.org/api/sqlite.html>
- Node permission model: <https://nodejs.org/api/permissions.html>
- node:sqlite RC status on Node 24 (secondary): <https://github.com/semics-tech/mongolite/pull/127>
- sqlite-vec releases: <https://github.com/asg017/sqlite-vec/releases>
- sqlite-vec with Node: <https://alexgarcia.xyz/sqlite-vec/js.html>
- LanceDB format and indexes: <https://lance.org/format/table/transaction/>,
  <https://docs.lancedb.com/indexing/vector-index>
- USearch: <https://github.com/unum-cloud/USearch>
- DuckDB VSS: <https://duckdb.org/docs/2.0/core_extensions/vss.html>
- DuckDB 1.4 encryption: <https://duckdb.org/2025/09/16/announcing-duckdb-140>
- PGlite: <https://pglite.dev/docs/filesystems>, <https://pglite.dev/extensions/>
- zvec (secondary):
  <https://www.marktechpost.com/2026/02/10/alibaba-open-sources-zvec-an-embedded-vector-database-bringing-sqlite-like-simplicity-and-high-performance-on-device-rag-to-edge-applications/>
- Chroma clients: <https://cookbook.chromadb.dev/core/clients/>
- Qdrant Edge: <https://qdrant.tech/documentation/edge/edge-vs-qdrant-cluster/>
- FastFlowLM EmbeddingGemma: <https://fastflowlm.com/docs/models/embeddinggemma/>
- FastFlowLM issues: <https://github.com/ROCm/FastFlowLM/issues/732>,
  <https://github.com/ROCm/FastFlowLM/issues/939>, <https://github.com/ROCm/FastFlowLM/issues/758>
- EmbeddingGemma: <https://huggingface.co/google/embeddinggemma-300m>,
  <https://developers.googleblog.com/en/introducing-embeddinggemma/>
- transformers.js in-browser latency (secondary): <https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/>
- Strands Decider: <https://github.com/strands-labs/strands-decider>,
  <https://strandsagents.com/blog/introducing-strands-decider/>
- Embedding inversion: <https://arxiv.org/abs/2310.06816>, <https://arxiv.org/abs/2406.10280>,
  <https://arxiv.org/html/2502.11308v1>, <https://arxiv.org/html/2504.00147>,
  <https://arxiv.org/abs/2602.01757>, <https://arxiv.org/pdf/2505.16008>,
  <https://arxiv.org/html/2607.01276v1>
