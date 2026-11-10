# Scaling, storage, embeddings and power: implementation plan

Plan, 2026-11-11. The evidence behind it is in
[scaling-storage-embeddings.md](scaling-storage-embeddings.md), referred to below as "the
findings". The phases are in the recommended order. Each task names the files, functions, tests
and docs, so it can be done without further design decisions. Effort: S is under a day, M is 1–3
days, L is more than 3 days.

How the phases map to the requested parts:

| Part | Phases |
|---|---|
| A. Performance | 0, 2, 3 |
| B. Storage | 1.1 (prerequisite), 6 |
| C. Embeddings | 5 (what to build now), 7 (verdict and triggers) |
| D. Power | 4 |

## Phase 0 — Instrumentation and baseline (S)

**Goal:** separate queue wait from engine time, and take a baseline on AC with the performance
profile as well as on battery. Every latency in the findings was taken on battery with the
power-saver profile.

### 0.1 Log `queueMs` and `engineMs`

- `core/src/decision.ts`: add `queueMs?: number` and `engineMs?: number` to `ShadowRecord`. Add
  the same two fields to `DecideResponse`.
- `gateway/src/decider.ts`, `#answers`:
  - capture `arrival = performance.now()` before `this.#queue.run`;
  - inside the job, set `startedAt = performance.now()` before calling `this.#engine.decide`;
  - after it, set `queueMs = startedAt − arrival` and `engineMs = end − startedAt`.
  - Return both in `EngineResult`; `#record` writes them rounded. Cache hits have neither.
- Tests in `decider.test.ts`:
  - a `FakeEngine` with a 50 ms delay and two concurrent decisions: the second record has
    `queueMs ≥ 45` and `engineMs ≥ 45`;
  - a cache hit has neither field.
- Docs: `architecture.md`, "Outcomes, usage and stats" → Records.

### 0.2 Re-measure on AC with the performance profile

On this machine, tuned-ppd provides the `net.hadess.PowerProfiles` D-Bus API, so
`powerprofilesctl` isn't needed. In fish:

```fish
cat /sys/class/power_supply/AC0/online          # must print 1
busctl set-property net.hadess.PowerProfiles /net/hadess/PowerProfiles net.hadess.PowerProfiles ActiveProfile s performance
busctl get-property net.hadess.PowerProfiles /net/hadess/PowerProfiles net.hadess.PowerProfiles ActiveProfile
cat /sys/firmware/acpi/platform_profile          # expect: performance
ps -eo args | grep 'flm serve' | grep -v grep    # expect: --pmode performance
local-decider bench --sizes 256,1024,2048,3800 --runs 5
```

- Then run the replay in 0.3 for N = 1, 5, 10 and 20 simulated agents.
- Repeat everything on battery with `ActiveProfile s power-saver`.
- Optionally repeat on AC with `engine.pmode: turbo` in `config.yaml`. FLM needs a restart for
  that: unload and load the engine from the Paseo engine settings, or with `POST /v1/engine/unload`
  then `POST /v1/engine/load`.
- Restore the profile afterwards with `… ActiveProfile s balanced`.
- `set-property` may ask for polkit authorisation. If it is refused, use the desktop's power
  applet.

**What to redo on AC with the performance profile:**

- the FastFlowLM and Strands tables in `docs/benchmarks.md`;
- the real-log latency table in the findings (§3.3), after a full working day on AC;
- every Phase 2 acceptance check.

### 0.3 Replay load generator

A scratch script, `/tmp/ld-scale/replay/replay.mjs`, not committed. Run Python with `-I` if any
helper is in Python.

1. Stop the live gateway first. A second FLM server would contend for the NPU.
2. Start an isolated gateway with:
   - `LOCAL_DECIDER_HOME=/tmp/ld-scale/gw-home`;
   - `LOCAL_DECIDER_CONFIG_DIR=/tmp/ld-scale/gw-config`;
   - a `config.yaml` there with `port: 8799`, the live engine selection, and `policies` with
     `command-risk` and `permission` in `act`.
3. Each simulated agent sends one decision every 17 s, which is 3.5 a minute. The mix is the
   real day's:

| Share | Policy | State | Client timeout |
|---:|---|---|---:|
| 64% | `command-risk` | about 90 tokens | 1,500 ms |
| 17% | `turn-outcome` | 600 tokens; 3,000 one time in five | none |
| 15% | `permission` | about 200 tokens | 60 s |
| 4% | `routing` | about 30 tokens | 2 s |

4. Output, per policy: client-side p50 and p95, the share over its timeout, the `engine queue
   full` count, and the mean and p95 of `queueMs` and `engineMs` from the isolated log.

**Acceptance for Phase 0:** a baseline table for AC and battery, at N = 1, 5, 10 and 20, is
attached to the Phase 2 PR.

## Phase 1 — Safety and privacy prerequisites (S–M)

**Goal:** close the outcome forgery hole and the engine-log leak, and bound disk growth. This
phase must land before anything that learns from labels.

### 1.1 Outcome forgery fix (M)

**Gateway:**

- New `gateway/src/report-token.ts`, `ensureReportToken(paths)`:
  - if `<config>/report-token` is missing, write 32 random bytes as base64url, mode 0600;
  - return the value.
- `runtime.ts`: call it at startup and pass the token to `createGatewayServer` as
  `reportToken`.
- `server.ts` `POST /v1/outcomes`:
  - read the `x-local-decider-report` header and compare it with `timingSafeEqual`, checking the
    length first;
  - **valid:** keep the parsed `source` and set `verified: true`;
  - **missing or wrong:** set `source: 'unverified'` and `verified: false`. Still log the
    record, still reply 200, so the CLI and tests keep working.
- `core/src/decision.ts`: add `verified?: boolean` to `OutcomeRecord`; add `'unverified'` to its
  source union. `OUTCOME_SOURCES` in `server.ts` stays as it is, because `unverified` is assigned
  by the server, never read from the body.
- `precedent.ts` `noteOutcome`: return early unless `outcome.verified === true`.
- `stats.ts` `samplesForRule`: only count outcomes with `verified === true`. Agreement and the
  reliability buckets keep counting every outcome.

**Paseo plugin:**

- `shared/gateway.ts`: `reportOutcome` sends the header.
- `server/deps.ts`: read `<config>/report-token` with the same path resolution as the gateway
  (`LOCAL_DECIDER_CONFIG_DIR`, then `XDG_CONFIG_HOME`, then `~/.config`). If the file is missing,
  send no header.
- The hooks never read the token.

**Tests:**

- `server.test.ts`:
  - no header → the log record has `verified: false` and `source: 'unverified'`, and the
    precedent tally doesn't change;
  - valid header → `verified: true` and the tally counts it;
  - the token string never appears in the log files.
- `precedent.test.ts`: an unverified outcome is ignored.
- `stats.test.ts`: the hint ignores unverified samples.
- `paseo-plugin/test/gateway.test.ts`: the header is sent.

**Docs:**

- `security.md`: a new "Outcomes" section. It must state the remaining risk: an agent running as
  the same user without a sandbox can read the file. The Claude Code and Codex sandboxes block
  reads outside the workspace.
- ADR-0006: an addendum saying only verified outcomes count.
- `architecture.md`: Records.

### 1.2 Engine log scrub and rotation (S)

- `engines/supervised.ts`: pipe stdout and stderr through `filterEngineLine(line)` in a new
  `engines/log-filter.ts` before writing to the stream.
  - Drop any line that contains `"state"` or `"questions"`, or is longer than 500 characters.
  - Keep everything else.
- Rotate before opening: if `engine-<id>.log` is over 10 MB, rename it to `engine-<id>.log.1`,
  replacing any older one.
- Tests: `log-filter.test.ts`, using a fixture made of real FLM request lines and normal status
  lines.
- Docs:
  - `security.md`: the engine log holds no state text;
  - release notes: delete existing `~/.local/share/local-decider/logs/engine-*.log`.

### 1.3 Retention (S)

- `config.ts`: add
  `logs: z.strictObject({ retainDays: z.number().int().min(90).max(3650).default(365) }).default({ retainDays: 365 })`,
  and regenerate the schemas with `local-decider config schema`.
- `shadow.ts`: `prune(retainDays: number, now = Date.now()): number` deletes
  `decisions-YYYY-MM-DD.jsonl` files older than `retainDays` and returns how many it deleted.
- `runtime.ts`: prune at startup, then every 24 h on an `unref`'d interval.
- Tests in `shadow.test.ts`: dated files are deleted exactly at the boundary; files that aren't
  logs are left alone.
- Docs: `architecture.md`, `security.md` (retention) and `install.md` (config key).

### 1.4 Torn-line repair (S)

- `shadow.ts` `append`: on the first append to a given file in this process, if the file exists,
  is non-empty, and its last byte (one byte read through an fd) isn't `\n`, write `\n` first.
  Remember the file names already checked in a `Set`.
- Test: write `{"kind":"decision"` with no newline, append one record, then `read()` returns
  exactly that one record.

**Acceptance for Phase 1:**

- a forged outcome changes neither a precedent tally nor a calibration hint;
- after a day of use, `grep -c '"state"' ~/.local/share/local-decider/logs/engine-*.log` prints
  0;
- files older than `retainDays` are gone after a restart.

## Phase 2 — Queue and hot-path latency (M)

**Goal:** high-priority hook decisions stop failing open behind long `turn-outcome` jobs.

### 2.1 Adapters send a time budget

- `core/src/decision.ts`: add `budgetMs?: number` to `DecideRequest`.
- `server.ts` `parseDecideRequest`: accept an integer from 100 to 120,000; drop anything else
  silently, as `parseModels` does.
- `core/src/client.ts` `decide`: send `budgetMs` equal to the client's timeout.
- Callers:
  - the hooks (`hooks/src/run.ts`) pass `timeoutOf(env)`, which defaults to 1,500;
  - Paseo `server/permission.ts` passes `DECIDE_TIMEOUT_MS` (60,000);
  - Paseo routing passes its 2,000 ms budget;
  - the Paseo turn decision passes its own timeout.

### 2.2 Queue changes in `queue.ts`

- New signature:
  `run(signal, job, priority = 'normal', options: { deadline?: number; demoteWhenAborted?: AbortSignal } = {})`.
- `Waiting` gains `deadline` and `demote`.
- `#next`:
  1. Remove and reject, with `new QueueExpiredError()`, every waiting entry whose
     `deadline !== undefined && performance.now() > deadline − 50`.
  2. Pick the best remaining entry by its effective rank: `demote?.aborted ? RANK.low : rank`,
     then by `seq`.
- New method `depthFor(priority)`: the number of waiting entries of that class, plus the running
  job if it is of that class.

### 2.3 Low-priority quiet period

- `SerialQueue` takes `{ quietMs = 2000, starveMs = 30000 }` in its constructor.
- It records `lastUrgentAt`, the time a high or normal job was last enqueued.
- A `low` entry is only eligible when `now − lastUrgentAt ≥ quietMs`, or when it has waited at
  least `starveMs`.
- If only ineligible low entries remain, set one timer for the earliest time one becomes
  eligible, and call `#next` when it fires.

### 2.4 Decider changes

- **Act mode** (`mode === 'act'`): `deadline = arrival + request.budgetMs` when the request
  carries one.
- **Shadow mode:** no deadline, and `demoteWhenAborted` is the caller's real `signal` (not the
  fresh one at `decider.ts:333`).
- **Queue limit:** replace the `this.#queue.depth >= QUEUE_MAX` check with
  `this.#queue.depthFor(priority === 'low' ? 'low' : 'high') >= QUEUE_MAX`. High and normal share
  one limit; low has its own.
- `QueueExpiredError` maps to `error: 'budget exceeded'`. The decision fails open with
  `enforced: false` and is logged.
- **Coalescing:** add `#inflight: Map<string, Promise<EngineResult>>`, keyed by `hash`.
  - A second caller with the same hash awaits the same promise and gets `cached: true`, with
    `latencyMs` set to its own wait.
  - The entry is deleted when the promise settles.

### 2.5 Cache

Set `cache.ttlSeconds: 3600` in `policies/command-risk.yaml`, and bump the policy `version`.

### 2.6 `turn-outcome` state size: a decision rule

Run experiment E3:

- if `turn-outcome` agreement at `maxTokens: 1500` is within 2 points of agreement at 3,000, set
  `maxTokens: 1500` in `policies/turn-outcome.yaml`;
- otherwise leave it at 3,000.

### Tests

- `queue.test.ts`:
  - an expired entry never runs its job and its promise rejects with `QueueExpiredError`;
  - a demoted entry runs after a later high entry;
  - a low entry waits out `quietMs`, and runs after `starveMs` even under constant high load;
  - `depthFor` counts per class.
- `decider.test.ts`:
  - an act request with `budgetMs: 100` behind a 500 ms job returns `error: 'budget exceeded'`,
    `enforced: false`, and the engine isn't called for it;
  - a shadow request whose caller aborted still gets logged;
  - two identical concurrent decisions cause one engine call;
  - the `command-risk` TTL cache hits.
- `server.test.ts`: `budgetMs` is parsed, and an invalid value is dropped.

### Docs

- `architecture.md`, "One decision", step 3: budgets, demotion, the quiet period, separate queue
  limits, coalescing.
- `policies.md`: what `priority` means; the `cache` TTL for `command-risk`.

### Not in this phase

- **Engine concurrency above 1.** FLM serves one request at a time. strands-decider's
  `--max-batch 8` is unused because the queue sends one job at a time. Adding an
  `Engine.concurrency` property only helps CPU users, so it is deferred.
- **Shrinking `command-risk` state.** Its p50 is already 89 tokens.

**Acceptance for Phase 2,** on the 0.3 replay at N = 5, on AC with the performance profile:

- `command-risk` p95 ≤ 1,500 ms at the client;
- at most 5% of `command-risk` over budget; at most 10% on battery with power-saver;
- `turn-outcome` errors up by no more than 1 point.

## Phase 3 — Non-blocking stats and a cheaper rebuild (S–M)

**Goal:** no event-loop stall from `stats`, and a startup rebuild under 1 s even at 10k
decisions a day.

### 3.1 Windowed stats

- `GET /v1/stats?days=N` (`server.ts`) and `local-decider stats --days N` (`cli.ts`). The default
  is 30; `0` means all time.
- Both read with `ShadowLog.readRecent(days)`, or `read()` when `days` is 0.
- `paseo-plugin/shared/gateway.ts` `stats`: request `?days=30`.
- `formatStats`: print the window in the header line.

### 3.2 Stats in a worker

- New `gateway/src/stats-worker.ts`. It reads `workerData`
  `{logDir, days, scope, pricing, policyDirs, config}`, loads the policies, reads the window,
  runs `computeStats`, and posts the result.
- `server.ts`: `runStatsWorker(options)` creates
  `new Worker(new URL(import.meta.url.endsWith('.ts') ? './stats-worker.ts' : './stats-worker.js', import.meta.url), { workerData, execArgv: process.execArgv })`.
- Allow one worker at a time: concurrent requests await the same promise. A 30 s timeout
  terminates the worker and returns 503.
- Check that `pnpm -r build` emits `stats-worker.js` into `dist/`.
- The CLI keeps computing in its own process.

### 3.3 Smaller precedent rebuild

- `decider.ts`: export `maxPrecedentAgeDays(policies)`, which returns the largest
  `policy.precedent.maxAgeDays`, or 0 when no policy uses precedent.
- `runtime.ts:64` and `Decider.replacePolicies`: call `readRecent(maxPrecedentAgeDays(...))`
  instead of `readRecent(90)`. When the result is 0, skip the read and clear the store.
- `replacePolicies`: compute
  `canonicalJson(Object.fromEntries([...next].map(([id, l]) => [id, l.policy.precedent ?? null])))`,
  and rebuild only when it differs from the value the store was built with.

### 3.4 Small cleanup

`computeStats` calls `groupUsage(usage)` once, not once per policy.

### Tests

- `server.test.ts`: with a 300k-record fixture written to a temporary log directory, a `/health`
  request made while `/v1/stats` runs answers within 50 ms; the `days` window filters correctly.
- `decider.test.ts`:
  - `replacePolicies` with unchanged precedent settings doesn't call `readRecent` (spy on the
    log);
  - a change to `maxAgeDays` triggers one rebuild.
- `stats.test.ts`: `days` filtering at the edges of the window.

**Docs:** `architecture.md` (stats and precedent rebuild) and the CLI help in `cli.ts`.

**Acceptance for Phase 3:** re-run `/tmp/ld-scale/bench/bench.mjs` at 10k/day × 90 days:

- the event-loop stall while `/v1/stats` runs is under 20 ms;
- the startup rebuild takes under 1 s.

## Phase 4 — Power setting (M)

**Goal:** users can make local-decider step aside on battery or in power-saver. The power
setting can never turn a decision into an allow.

### 4.1 Config

In `config.ts`; regenerate `schemas/config.schema.json`.

```yaml
power:
  onBattery: normal      # normal | shadow | bypass | off
  onPowerSave: normal    # normal | shadow | bypass | off
  pollSeconds: 30        # 5..600
  flmPmode: {}           # optional: { onBattery: balanced, onPowerSave: powersaver }
```

`flmPmode` values come from `FLM_PMODES` in `config.ts`: `powersaver`, `balanced`, `performance`
or `turbo`.

### 4.2 What each setting does

When both conditions are true, the stricter setting applies, in the order normal < shadow <
bypass < off.

| Effect | Decide | Logged | Engine |
|---|---|---|---|
| `normal` | Unchanged | Unchanged | Unchanged |
| `shadow` | The effective mode is capped at `shadow`: decisions run and are logged, never enforced | Yes | Runs |
| `bypass` | Returns at once: `action: 'abstain'`, `enforced: false`, `answers: {}`, `rule: -1`, `latencyMs: 0`, `power: 'battery'` or `'power-save'` | Yes, with `power` set | Unloaded on entry; never called |
| `off` | The same as every policy being `off`: abstain | No (as `mode: off` today) | Unloaded on entry |

Rules for all settings:

- `bypass` and `off` return before redaction, precedent, the cache and the rules, so **no path
  can produce `allow`**.
- The hooks' deterministic guard keeps running, because it only ever denies.
- In Claude Code and Codex, an abstain means the hook prints nothing, so the harness default
  applies. In Paseo, nothing happens.

**Where the cap applies:** `Decider.effectiveMode(id, scope)` becomes
`minMode(policyMode, scopeCap, powerCap)`, where `powerCap` is `act` for normal and `shadow` for
shadow. `Decider.decide` gets an early return for `bypass` and `off`, before
`redactDeep(request.input)`. `#noteCall` still records the abstain for `/v1/calls`.

**Record fields:** `ShadowRecord` and `DecideResponse` gain `power?: 'battery' | 'power-save'`.

### 4.3 Detection: `gateway/src/power.ts`

```ts
export interface PowerState {
  readonly onBattery: boolean | null;
  readonly powerSave: boolean | null;
  readonly source: string; // e.g. "sysfs+platform_profile", "sysfs+dbus", "pmset", "none"
}

export interface PowerSource {
  read(): Promise<PowerState>;
}
```

**`LinuxPowerSource(root = '/', exec = execFile)`**

Whether it is on battery, from `<root>sys/class/power_supply/*`:

1. If any supply has `type` Mains or USB and `online` = `1`, it is not on battery.
2. Otherwise, if any supply has `type` Battery and `status` Discharging, it is on battery.
3. If no supply has `type` Battery, it is a desktop: not on battery.
4. Anything else, or a missing directory, is `null`.

Whether it is in power-save:

1. If `<root>sys/firmware/acpi/platform_profile` exists: `low-power`, `quiet` or `cool` mean
   power-save; anything else means not.
2. Otherwise run
   `exec('busctl', ['get-property', 'net.hadess.PowerProfiles', '/net/hadess/PowerProfiles', 'net.hadess.PowerProfiles', 'ActiveProfile'], { timeout: 1000 })`.
   An output of `s "power-saver"` means power-save; another profile means not; an error or
   missing `busctl` means `null`.

The argv is fixed and nothing in it comes from requests or agents.

Values on this machine, as of 2026-11-11 [verified]: AC0 `online=0`, BAT0 `Discharging`,
`platform_profile=low-power`, D-Bus `"power-saver"`, UPower `OnBattery=true`.

**`MacPowerSource(exec)`**

- On battery when `pmset -g batt` contains `'Battery Power'`.
- In power-save when `pmset -g` has a line `lowpowermode 1`.
- Errors give `null`.
- The exact output strings are [unverified]: build test fixtures from a real Mac before
  relying on them.

**Anything else (Windows included):** `NullPowerSource`, which always returns `null`. **Unknown
always means normal.**

**`FakePowerSource`** for tests: a settable `PowerState`.

### 4.4 `PowerGovernor` (same file)

- Constructor: `{ source, settings: () => GatewayConfig['power'], now, setTimer }`.
- It polls every `pollSeconds`.
- **Hysteresis:** a new effect applies after 2 consecutive reads agree, in both directions. The
  first read at startup applies immediately.
- `effect` is `normal`, `shadow`, `bypass` or `off`; `reason` is `battery` or `power-save` (when
  both apply, `battery` wins as the reason); `since` is an ISO timestamp.
- On a transition it emits `change(prev, next)`.
- **Wiring (`runtime.ts`):**
  - build the governor after `EngineControl`;
  - `decider.setPowerCap(effect, reason)`;
  - entering `bypass` or `off` calls `engineControl.unload()`;
  - leaving it with `lifecycle.mode === 'eager'` calls `engineControl.load()`; a lazy engine
    does nothing and loads on the next decision.
- `POST /v1/engine/load` (`server.ts` `CONTROL_ROUTES`): 409 `power bypass active` while the
  effect is `bypass` or `off`.
- **FLM pmode:** `engines/fastflowlm.ts` `args(port)` uses
  `power.flmPmode.onBattery ?? power.flmPmode.onPowerSave ?? config.pmode`, picked according to
  the governor's state when the process is spawned. A power change never restarts the engine; it
  takes effect at the next load.

### 4.5 Where it shows

- **`/health`** (`server.ts` `health`): add
  `power: { onBattery, powerSave, source, effect, reason, since }`.
- **Stats** (`stats.ts`):
  - `PolicyStats.bypassed` counts records that have `power` set;
  - those records are left out of latency, agreement and the hints;
  - `formatStats` prints `bypassed N (battery M, power-save K)`.
- **CLI** (`cli-settings.ts`, following `routing map`, with `ConfigFile.update`):
  - `local-decider power` prints the detected state, the settings, and the current effect from
    the gateway's `/health` if it is running;
  - `local-decider power set on-battery <normal|shadow|bypass|off>`;
  - `local-decider power set on-power-save <normal|shadow|bypass|off>`;
  - `local-decider power set poll-seconds <5..600>`.
- **HTTP:** `POST /v1/power {onBattery?, onPowerSave?, pollSeconds?}` in `settings-routes.ts`
  writes `config.yaml`. The gateway's settings watcher then applies it.
- **Paseo:**
  - `client/engine-state.tsx`, lifecycle section: two selects, "On battery" and "In power-saver",
    with the options "Normal", "Shadow only", "Bypass (fail open, unload model)" and "Off";
  - a status line from `/health`, for example "On battery · power-saver → bypass since 14:02";
  - `shared/rpc.ts` `powerRpc`, `server/engines.ts` `setPower`, `shared/gateway.ts` `setPower`.

### 4.6 Tests

- `power.test.ts`:
  - fake sysfs trees in a temporary directory: AC online, battery discharging, a desktop with no
    battery, a missing directory, each `platform_profile` value;
  - a fake `exec` for busctl (power-saver, balanced, error) and for pmset fixtures;
  - hysteresis with a fake clock (one read flips nothing, two do);
  - a startup read applies immediately.
- `decider.test.ts`:
  - `bypass` returns abstain, `enforced: false` and `power: 'battery'`, and the `FakeEngine`
    sees no call;
  - with a precedent tally of 10 allows, `bypass` still abstains;
  - `shadow` caps an `act` policy, so `enforced` is false;
  - `off` writes no record.
- `engine-control.test.ts`: entering bypass unloads; leaving reloads only when eager; `load` is
  refused with 409 during bypass.
- `server.test.ts`: `/health.power` is present; `POST /v1/power` writes the config.
- `cli-settings.test.ts`: `power set` writes the right keys and rejects bad values.
- `paseo-plugin` RPC and gateway tests for `setPower`.

### 4.7 Docs

- `install.md`: a new "Battery and power-saver" section with the config and CLI examples.
- `architecture.md`: where the power cap applies in "One decision".
- `security.md`: bypass and off only ever fail open.
- Paseo `OVERVIEW.md`: the new settings.

**Acceptance for Phase 4:**

- on this laptop, with `onBattery: bypass`, unplugging AC unloads the model within 2 × 30 s;
- `/health` shows `effect: bypass`;
- a hook call returns in under 5 ms with no output;
- plugging AC back in restores normal within 60 s.

## Phase 5 — Cheap accuracy levers (S–M)

**Goal:** fewer prompts without new storage, new models or stored text. Build these instead of
embeddings.

### 5.1 Calibration hints from verified user labels, per model (S)

- `stats.ts` `samplesForRule`:
  - use the **first** outcome per decision, with `verified === true` and `source === 'user'`;
  - use only decisions whose `model` equals the current engine model. Pass the model through
    `StatsOptions.model`; the route and the CLI fill it from `/health` or the config.
- Add `PolicyStats.bands`: for allow rules, allow and deny counts per p(allow) band, with edges
  0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95 and 1. `formatStats` prints one line per band.
- The rule itself stays: n ≥ 100 and Wilson upper ≤ 2% (with 0 denies, that means n ≥ 189).
- Tests in `stats.test.ts`:
  - unverified and supervised samples are excluded;
  - the first outcome wins for hints, the latest for agreement;
  - band counts are correct;
  - other models are excluded.
- Docs: `policies.md` (calibration hints).

### 5.2 Template keys, logged only (M)

- Move `hooks/src/shell.ts` to `core/src/shell.ts`, export it from `core/src/index.ts`, and make
  `hooks/src/shell.ts` a re-export. The hooks bundle already includes core.
- New `core/src/template.ts`, `subjectTemplate(subject: string): string | null`. It returns
  `null` unless one of these holds:
  - **Read-type tools:** `^(Read|Grep|Glob|LS): (.+)$` with a relative path that doesn't start
    with `..` or `/`. This gives `<Tool>: <first segment>/*<.ext or empty>`.
  - **Web fetch:** `^WebFetch: (https?://[^/]+)`. This gives `WebFetch: <scheme>://<host>/*`.
  - **Shell:** `^Bash: (.+)$`, where `splitShell` gives exactly one segment, that segment is not
    piped, and the raw text contains none of `$(`, a backtick, `>`, `<`, `&&`, `||` or `;`.
    `commandWords` must drop no `sudo`, `doas` or `env` prefix. The `(baseName(w0), w1)` pair
    must be on this allowlist:

| Command | Allowed subcommands or conditions |
|---|---|
| git | status, log, diff, show, branch, rev-parse, ls-files, grep, blame |
| ls, cat, head, tail, wc, grep, rg, fd | any arguments |
| find | only without `-exec`, `-execdir`, `-delete` or `-ok` |
| pnpm, npm | test, run, list, ls, why, outdated |
| cargo | test, check, build, clippy |
| go | test, build, vet |
| mise | run, ls |

- **Shell output format:** the command, the subcommand if there is one, and each flag as written,
  in order. Each run of non-flag operands becomes one `<args>` token. For example,
  `git log -n 5 --oneline` becomes `Bash: git log -n <args> --oneline`.
- **Everything else** returns `null`, including Edit, Write, MultiEdit and NotebookEdit.
- `decider.ts` `#precedentFor`: compute
  `templateKey = template === null ? undefined : inputHash([policy.id, input['project'], 'template', template])`
  from the redacted subject. Add it to `PrecedentDecision`, `DecideResponse` and `ShadowRecord`.
  **No rule uses it yet.**
- Tests in `core/test/template.test.ts`:
  - `git log -n 5` and `git log -n 9` give the same template;
  - `Read: src/a.ts` and `Read: src/b.ts` give the same template;
  - each of these gives `null`: `rm -rf build`, `git push`, `git reset --hard`, `cat a > b`,
    `find . -delete`, `sudo cat x`, `ls | sh`, `Read: ../x`, `Read: /etc/passwd`,
    `Edit: src/a.ts`.
- `decider.test.ts`: `templateKey` is logged, and the template text is never logged.
- Docs: `policies.md` (Precedent: template keys are logged for measurement).

### 5.3 Template precedent rule (S; only after experiment E2 passes)

- `core/src/policy.ts`: `when.precedent` accepts `allow` or `template`.
- `PrecedentStore` keeps a second tally for template keys, with the same evidence rules (first
  outcome, verified, sources, `maxAgeDays`). Raise `MAX_KEYS` to 50,000.
- A `template` rule matches when all of these hold:
  - the template key has at least `minAllows + 2` allows and no deny;
  - the exact key has no deny;
  - p(allow) ≥ the rule's threshold, which must be at least 0.8.
- `permission.yaml`: add
  `- when: { question: verdict, answer: allow, minProbability: 0.8, precedent: template }`,
  `action: allow`, after the exact precedent rule. Bump the version.
- Tests: precedent and decider tests for every veto. Docs: `policies.md`, and ADR-0006 or a new
  ADR-0007.

### 5.4 Engine model and fixtures (S)

Run experiment E4 and record the result in `docs/benchmarks.md`.

**Acceptance for Phase 5:** E1 and E2 ran on at least 7 days of logs, and their tables are in the
PR. 5.3 ships only if E2 passes.

## Phase 6 — Storage

### 6.1 Now: a `LogStore` interface (S)

- `gateway/src/shadow.ts`: export
  `interface LogStore { append(r): void; read(): LogRecord[]; readRecent(days, now?): LogRecord[]; prune(days, now?): number; readonly dir: string }`.
  `ShadowLog` implements it.
- `stats-worker.ts`, `runtime.ts`, `server.ts`, `decider.ts` and `cli.ts` accept a `LogStore`.
- No behaviour change. The existing tests must pass unchanged.

### 6.2 SQLite backend (L), only when a trigger fires (section B)

New `gateway/src/sqlite-log.ts`, `SqliteLog implements LogStore`.

**Opening the database:**

```ts
const sqlite = await import('node:sqlite');
const Db = sqlite.Database ?? sqlite.DatabaseSync;
```

- The file is `<data>/decider.db`, mode 0600, in the 0700 data directory.
- Fall back to `ShadowLog` with one warning when the import fails, or the Node version is below
  24.15.
- Always bind `null` explicitly, never `undefined`: Node 26.10 changed how `undefined` binds.
- Open with `allowExtension: false`.

**Pragmas:** `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=2000`,
`auto_vacuum=INCREMENTAL` (set before the first table is created).

**Schema** (STRICT tables, timestamps as epoch milliseconds):

```sql
CREATE TABLE decision(
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, policy TEXT NOT NULL, variant TEXT,
  mode TEXT NOT NULL, scope TEXT, harness TEXT NOT NULL, session_id TEXT, call_id TEXT,
  permission_mode TEXT, subagent INTEGER, input_hash TEXT NOT NULL,
  precedent_key TEXT, template_key TEXT, state_tokens INTEGER,
  action TEXT NOT NULL, enforced INTEGER NOT NULL, engine TEXT, model TEXT,
  latency_ms INTEGER, queue_ms INTEGER, engine_ms INTEGER, error TEXT, power TEXT,
  requested_model TEXT, routed_model TEXT, answers TEXT NOT NULL) STRICT;
CREATE INDEX decision_policy_ts ON decision(policy, ts);
CREATE INDEX decision_scope_ts ON decision(scope, ts) WHERE scope IS NOT NULL;
CREATE INDEX decision_prec ON decision(precedent_key, ts)
  WHERE action = 'ask' AND precedent_key IS NOT NULL;
CREATE INDEX decision_tmpl ON decision(template_key, ts)
  WHERE action = 'ask' AND template_key IS NOT NULL;
CREATE TABLE outcome(
  seq INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, ts INTEGER NOT NULL,
  outcome TEXT NOT NULL, source TEXT NOT NULL, verified INTEGER NOT NULL) STRICT;
CREATE INDEX outcome_decision ON outcome(decision_id, seq);
CREATE TABLE usage(
  seq INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, ts INTEGER NOT NULL, turn_id TEXT,
  model TEXT, input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL, cost_usd REAL) STRICT;
CREATE INDEX usage_decision ON usage(decision_id);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
```

`meta` holds `schema_version` and the JSONL files already imported.

**Not stored:**

- precedent tallies, which are computed by query into the existing in-memory `PrecedentStore`;
- `/v1/calls`, which stay in memory for 10 minutes;
- any text. The database is hash-only, exactly like the JSONL.

**Queries:**

- **Stats window:** decisions with `policy = ? AND ts >= ?`, left-joined to the latest outcome
  (`MAX(seq)` per decision), then the existing `computeStats` logic on the rows. Later, the
  counts can move into SQL `GROUP BY`.
- **Precedent rebuild:**

  ```sql
  SELECT d.precedent_key, o.outcome, o.ts, d.ts
  FROM decision d
  JOIN outcome o ON o.seq = (SELECT MIN(seq) FROM outcome WHERE decision_id = d.id)
  WHERE d.action = 'ask' AND d.precedent_key IS NOT NULL AND d.ts >= ?
    AND o.verified = 1
  ```

  Then source filtering and expiry in JS, as today. The same query with `template_key` builds
  the template tally.
- **Per-scope agreement:** `GROUP BY scope, policy`.
- **Disagreement review:** decisions whose top answer differs from the latest outcome. Show only
  the ID, time, policy, probabilities and outcome; there is no text.

**Processes:** the gateway is the only writer. The CLI opens the database with
`{ readOnly: true }`. A second writer is refused: the gateway takes an `flock`-style lock file at
`<data>/run/db.lock`.

**Retention:** `DELETE FROM decision WHERE ts < ?` along with its outcomes and usage, then
`PRAGMA incremental_vacuum`, daily.

**Backup and portability:**

- `local-decider logs backup <file>` runs `VACUUM INTO`.
- `local-decider logs export [--since YYYY-MM-DD] <dir>` writes the same `decisions-*.jsonl`
  format.
- `local-decider logs import <dir>` is idempotent: `INSERT OR IGNORE` on the decision ID;
  outcomes and usage are deduplicated on `(decision_id, ts, outcome, source)` and
  `(decision_id, ts, turn_id)`. It records the imported file names in `meta`. The JSONL files are
  never deleted by the import.

**Crash safety:** with WAL and `synchronous=NORMAL`, a power loss can drop the last transactions
but never corrupts the database.

**Config:** `logs.store: jsonl | sqlite`, default `jsonl` until a trigger fires; then default
`sqlite` with an automatic import on first start.

**Tests:** `sqlite-log.test.ts` runs the same suite as `ShadowLog` against the interface; import
and export round trips; a read-only CLI handle during gateway writes; the fallback path.

**Docs:** `architecture.md`, `security.md` (hash-only still holds, no encryption at rest, file
mode), `install.md`.

## Phase 7 — Embeddings: not now

Section C gives the verdict and the trigger. Nothing is built in this phase. The groundwork that
keeps it cheap later is:

| Groundwork | Task |
|---|---|
| Verified outcomes | 1.1 |
| `queueMs` and `engineMs` | 0.1 |
| Calibration bands | 5.1 |
| Template keys | 5.2 |
| `LogStore` | 6.1 |

## B. Database recommendation and triggers

**Now: stay on JSONL with Phases 1, 3 and 6.1.** At today's rate, a 30-day window is about 30k
records: about 0.2 s of work in a worker and no stall.

**Build Phase 6.2 when any of these fires:**

| Trigger | Condition |
|---|---|
| T1 | A 30-day window holds more than 300k records (about 10k decisions a day, sustained) |
| T2 | A feature needs rows that change: label corrections, review status, or stored overrides |
| T3 | A second process has to write, or two gateways share data |
| T4 | Embeddings are approved (section C) |
| T5 | Retained JSONL exceeds 1 GB |

None is close today: about 1k records a day, and about 210 MB a year.

**node:sqlite and Node versions:**

- **Node 24:** unflagged; release candidate from v24.15 per a secondary source [unverified].
  Earlier 24.x versions may print an ExperimentalWarning.
- **Node 25:** release candidate from v25.7 [verified, Node docs].
- **Node 26:**
  - v26.10 changed how `undefined` binds;
  - v26.11 renamed `DatabaseSync` to `Database` and kept the alias (DEP0210);
  - v26.13 here exports both names and printed no warning [verified].
- **Fallback:** JSONL (Phase 6.2, opening the database).

**Prerequisite:** the outcome forgery fix (1.1) comes before any label-driven learning: hints,
template precedent, or anything with embeddings.

## C. Embeddings verdict

| Option | Gain | Risk | Call |
|---|---|---|---|
| Similarity-based precedent | Small over template keys | Near-miss commands; stored vectors are about as revealing as text | **Reject** |
| kNN or few-shot examples in the prompt | Small | Token budget; re-injects untrusted text; needs stored text (ADR-0006) | **Reject** |
| Embedding-based routing | Not measurable: no routing labels | Low | **Reject** until routing outcomes exist |
| Classifier head on embeddings from our labels | Marginal over a calibrated threshold | Class imbalance (≈15–20 denies a week); drift; poisoning | **Defer** |

**Library, if it ever happens:**

- **Use:** a `node:sqlite` table with int8 BLOB vectors and exact top-k in plain JS: 6 ms over
  10k vectors and 57 ms over 100k [verified].
- **Not sqlite-vec** with `allowExtension`: a native `.so` per platform, version 0.1.x, no musl
  build, and it conflicts with `--permission`. Revisit only above 100k vectors.
- **Runner-up:** PGlite + pgvector.
- **Rejected:** LanceDB, DuckDB VSS, usearch, hnswlib-node, zvec, Orama, Vectra, Voy, Chroma and
  Qdrant. The findings §9 gives the reason for each.

**Model, if it ever happens:**

- **Use:** `bge-small-en-v1.5` int8 (34 MB, 384 dimensions, MIT), run by Python `fastembed` in a
  dedicated uv venv at `~/.local/share/local-decider/venvs/embed`, served on loopback and
  supervised like an engine.
- **Cost:** about 5–15 ms per short text and 150–250 MB of RAM [unverified; measure first].
- **Not transformers.js:** `onnxruntime-node`, a postinstall download, and `sharp`.
- **Not FLM embed-gemma:** NPU contention, recent wrong-vector bugs, and the Gemma licence.

**What would be stored, and how:**

- Only for verified user-labelled `permission` subjects, after an opt-in setting
  (`labels.store: true`).
- Vectors in the SQLite database. Expiry and deletion follow precedent `maxAgeDays`, never longer.
- Never exported, never synced, file mode 0600.
- Documented in `security.md` as sensitive.

**Poisoning safeguards:**

- Use only verified user labels, never `supervised`.
- A deny on any neighbour vetoes.
- Never apply to anything the guard or `command-risk` rates as caution or dangerous.
- Embeddings only break ties inside an exact template match; they never generalise past it.
- The threshold never goes below 0.8. Everything stays per project.

**Trigger (all must hold):**

1. 1.1 has shipped, and Phase 5 has been measured.
2. There are at least 2,000 verified user `permission` labels, with at least 100 denies.
3. An offline held-out evaluation on an opt-in capture of at least 500 items, including at least
   50 benign/dangerous near-miss pairs, shows at least 10 points more auto-allows than template
   precedent plus a calibrated threshold.
4. That evaluation leaks zero denies and allows zero dangerous near-miss twins.

## Measurements before and after each phase

| Phase | Before | After | Tool |
|---|---|---|---|
| 0 | – | Baseline on AC and battery: p50, p95, share over budget per policy, `queueMs` and `engineMs` | 0.2 bench and 0.3 replay |
| 1 | Engine log size and `"state"` count; a forged outcome changes the tally (shown in a test) | 0 `"state"` lines; forged outcome ignored; old files pruned | `grep -c`, unit tests |
| 2 | Phase 0 baseline | `command-risk` p95 ≤ 1.5 s and ≤ 5% over budget on AC at N = 5; ≤ 10% on battery | 0.3 replay; the real log after a day |
| 3 | Stats stall 0.6 s / 6.8 s; rebuild 0.35 s / 5.3 s (at 1k/day and 10k/day) | Stall < 20 ms; rebuild < 1 s at 10k/day | `bench.mjs`, `/health` timing |
| 4 | Battery drain with the model loaded, as a percentage per hour over 1 h idle with a few agents (UPower `EnergyRate`) | Same with `onBattery: bypass`; model unloaded within 60 s | `upower -i /org/freedesktop/UPower/devices/battery_BAT0` |
| 5 | Prompts a day that the user answered; exact precedent hit rate | Same after the threshold or template rule | E1, E2 |
| 6.2 | Stats and rebuild time at the trigger volume | The same queries on SQLite | `/tmp/ld-scale/sqlite/sqlite.mjs` |

## Experiments

| ID | When | Procedure | Decision rule |
|---|---|---|---|
| E1 | 7 days after 5.1 | `local-decider stats --days 14`; read `bands` and the hint for `verdict.allow` | Adopt the suggested threshold with `local-decider` thresholds only if a hint is printed (n ≥ 189 with 0 denies, or Wilson ≤ 2%); re-run after any engine model change |
| E2 | 7 days after 5.2 | Scratch script over the logs. For each verified user-labelled `permission` ask in time order: would its exact key have had ≥ 3 earlier allows and no deny within 14 days? Would its template key have had ≥ 5? Also list every template key that has both an allow and a deny | Ship 5.3 if the template hit rate is at least 2× the exact rate and no allowlisted template has mixed labels; otherwise drop the offending allowlist entries and measure again |
| E3 | Phase 2.6 | 60 labelled `turn-outcome` fixtures in `policies/fixtures/turn-outcome.jsonl`; `local-decider policies eval turn-outcome …` at `maxTokens` 3,000 and 1,500, using variant policies; also replay p95 | The 2.6 rule |
| E4 | Any time, on AC with the performance profile | 40–60 fixtures per policy as described in [flm-decision-models.md](flm-decision-models.md) §6, including near-miss dangerous commands; `policies eval` on d3:nano, d3:mini and d3:flash; `local-decider bench` at real state sizes | Switch models only if accuracy improves by at least 3 points and p95 at 300 tokens stays ≤ 1.5 s |
| E5 | Before 2.5 | `node /tmp/ld-scale/inspect/repeats.mjs <file>` over 7 days of logs | Keep the 3,600 s TTL if repeats within 3,600 s are at least 5% (today about 7%) |
| E6 | Only if the embeddings trigger is near | 200 benign/dangerous near-miss pairs embedded with bge-small in a scratch venv; record each pair's cosine similarity | If most dangerous twins exceed the acceptance cosine, similarity precedent stays rejected for good |

## What not to do

- Don't add a vector database, an ANN index or an embedding model now. Don't add sqlite-vec,
  LanceDB, DuckDB or any other package with native code.
- Don't put few-shot examples or retrieved past text into engine prompts.
- Don't migrate to SQLite before T1–T5 fire.
- Don't run two FLM decision servers, and don't share one gateway across machines.
- Don't raise `QUEUE_MAX` to hide latency. Budgets, demotion and the quiet period fix the cause.
- Don't let the power setting, or any label path, produce `allow`.
- Don't count unverified or `supervised` labels toward thresholds.
- Don't detect power by running commands on the hot path. Poll in the background; unknown means
  normal.
- Don't implement temperature or isotonic calibration separately from the threshold hint.
- Don't log subject or template text, even for measurement. Log hashes only.
