/**
 * Card 2, "Benchmark this machine", as a pure view model: the idle summary, live progress, end
 * states and the saved results grouped by model family (UX brief §4).
 */
import type { BenchmarkTarget, BenchmarkView } from './benchmark.ts';
import type { EngineCatalog, EngineModel } from './engines.ts';
import type { Measured } from './machine.ts';
import { ms, runtimeName } from './recommended-card.ts';

export type BenchActionKind =
  | 'run'
  | 'cancel'
  | 'finish'
  | 'again'
  | 'show-results'
  | 'restore'
  | 'auto'
  | 'measure'
  | 'retry'
  | 'use';

export interface BenchTarget {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
}

export interface BenchAction {
  readonly kind: BenchActionKind;
  readonly label: string;
  readonly disabled: boolean;
  readonly hint: string | null;
  /** `missing` for Finish benchmark (`only:'missing'`). */
  readonly only: 'missing' | null;
  /** The rows to run (`targets:[row]`), or the one to select; empty otherwise. */
  readonly targets: readonly BenchTarget[];
  /** The family for `auto`. */
  readonly family: string | null;
}

export type RowBadgeKind = 'fastest' | 'in-use' | 'stale' | 'provisional' | 'noisy' | 'failed';

export interface RowBadge {
  readonly kind: RowBadgeKind;
  readonly label: string;
}

export type RowState = 'measured' | 'unmeasured' | 'failed' | 'live' | 'cancelled' | 'not-run';

export interface ResultRow {
  readonly key: string;
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
  readonly runtime: string;
  readonly format: string;
  readonly state: RowState;
  readonly p256: string | null;
  readonly typical: string | null;
  readonly long: string | null;
  readonly k2: string | null;
  /** A sentence replacing the numbers: "Waiting", "Failed: …", "Speed not measured yet". */
  readonly text: string | null;
  readonly hint: string | null;
  /** The full error text of a failed row. */
  readonly error: string | null;
  readonly badges: readonly RowBadge[];
  readonly action: BenchAction | null;
  readonly accessibleName: string;
}

export interface ResultGroup {
  readonly family: string;
  readonly label: string;
  readonly current: boolean;
  readonly rows: readonly ResultRow[];
  readonly useFastest: BenchAction | null;
}

export interface BenchmarkCard {
  readonly state: 'idle' | 'running' | 'cancelling' | 'done' | 'cancelled' | 'failed';
  readonly stateLabel: string | null;
  readonly description: string;
  /** "About 6 min · 6 runtimes": how long a run takes, not latency. */
  readonly summary: string | null;
  readonly detail: string | null;
  readonly primary: BenchAction;
  readonly secondary: readonly BenchAction[];
  readonly activity: string | null;
  readonly progress: {
    readonly completed: number;
    readonly total: number;
    readonly fraction: number;
    readonly text: string;
  } | null;
  readonly startedNote: string | null;
  readonly status: string | null;
  /** Live-region text. It changes only when a target finishes or the job ends, not per tick. */
  readonly announcement: string | null;
  readonly restoreFailure: {
    readonly text: string;
    readonly retry: BenchAction;
    readonly auto: BenchAction;
  } | null;
  readonly footer: readonly string[];
  readonly resultsExpanded: boolean;
  /** Whether any row has a 2,048-token measurement. */
  readonly showK2: boolean;
  readonly groups: readonly ResultGroup[];
}

const DESCRIPTION =
  'Times every installed model on every runtime, one at a time, with short, typical and long prompts.';
const BUSY_HINT = 'Available when this finishes.';
const KEPT = 'Completed results are kept.';
const MACHINE_ONLY = 'Results are from this machine only.';
const MAX_ERROR = 120;

function action(
  kind: BenchActionKind,
  label: string,
  rest: Partial<BenchAction> = {},
): BenchAction {
  return {
    kind,
    label,
    disabled: false,
    hint: null,
    only: null,
    targets: [],
    family: null,
    ...rest,
  };
}

// ── internal model ───────────────────────────────────────────────────────────────────────────

interface Source {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
  readonly family: { id: string; label: string };
  readonly format: string;
  readonly installed: boolean;
  readonly measured: Measured | null;
}

interface Numbers {
  readonly p256: number | null;
  readonly typical: { p50Ms: number; p95Ms: number } | null;
  readonly long: number | null;
  readonly k2: number | null;
}

interface Ctx {
  readonly catalog: EngineCatalog;
  readonly view: BenchmarkView | null;
  readonly busy: boolean;
  readonly auto: boolean;
}

function keyOf(engine: string, model: string, device: string | null): string {
  return `${engine}|${model}|${device ?? ''}`;
}

function familyOf(m: EngineModel): { id: string; label: string } {
  return m.family ?? { id: `${m.engine}:${m.id}`, label: m.label };
}

function engineCalibrated(catalog: EngineCatalog, id: string): boolean {
  return catalog.engines.find((e) => e.id === id)?.calibrated !== false;
}

function sourcesOf(catalog: EngineCatalog): Source[] {
  const out: Source[] = [];
  for (const m of catalog.models) {
    const base = {
      engine: m.engine,
      model: m.id,
      family: familyOf(m),
      format: m.format?.label ?? '—',
      installed: m.installed,
    };
    for (const measured of m.measured) {
      out.push({ ...base, device: measured.device, measured });
    }
    const listable = m.installed && m.fits && engineCalibrated(catalog, m.engine);
    if (m.measured.length === 0 && listable) {
      out.push({ ...base, device: null, measured: null });
    }
  }
  return out;
}

/** A job target the catalog has no model for, so it still gets a row. */
function sourceOfTarget(t: BenchmarkTarget, label: string | undefined): Source {
  const id = t.family ?? `${t.engine}:${t.model}`;
  return {
    engine: t.engine,
    model: t.model,
    device: t.device,
    family: { id, label: label ?? id },
    format: '—',
    installed: true,
    measured: null,
  };
}

function withJobTargets(catalog: EngineCatalog, view: BenchmarkView | null): Source[] {
  const sources = sourcesOf(catalog);
  const labels = new Map(
    catalog.models.flatMap((m) => (m.family === null ? [] : [[m.family.id, m.family.label]])),
  );
  const known = new Set(sources.map((s) => keyOf(s.engine, s.model, s.device)));
  for (const t of view?.targets ?? []) {
    if (!known.has(keyOf(t.engine, t.model, t.device))) {
      sources.push(sourceOfTarget(t, t.family === null ? undefined : labels.get(t.family)));
    }
  }
  return sources;
}

// ── numbers ──────────────────────────────────────────────────────────────────────────────────

function fromMeasured(m: Measured): Numbers {
  const at = (n: number): number | null => m.sizes.find((s) => s.targetTokens === n)?.p50Ms ?? null;
  return { p256: at(256), typical: m.typical, long: m.long?.p50Ms ?? null, k2: at(2048) };
}

/** Numbers from a finished job target the catalog does not have yet. */
function fromTarget(t: BenchmarkTarget): Numbers {
  const rows = t.sizes.filter((s) => s.p50Ms !== null && s.p95Ms !== null);
  const at = (n: number): number | null => rows.find((s) => s.targetTokens === n)?.p50Ms ?? null;
  const typical = rows.find((s) => s.targetTokens === 1024);
  const long = rows.toReversed().find((s) => s.targetTokens > 1024);
  return {
    p256: at(256),
    typical:
      typical?.p50Ms == null || typical.p95Ms == null
        ? null
        : { p50Ms: typical.p50Ms, p95Ms: typical.p95Ms },
    long: long?.p50Ms ?? null,
    k2: at(2048),
  };
}

function oneLine(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > MAX_ERROR ? `${line.slice(0, MAX_ERROR)}…` : line;
}

// ── rows ─────────────────────────────────────────────────────────────────────────────────────

const LIVE_TEXT: Record<string, string> = {
  pending: 'Waiting',
  loading: 'Loading…',
  measuring: 'Measuring…',
};

function targetKey(s: Source): BenchTarget {
  return { engine: s.engine, model: s.model, device: s.device };
}

function lockable(c: Ctx, a: BenchAction): BenchAction {
  return c.busy ? { ...a, disabled: true, hint: BUSY_HINT } : a;
}

function isActive(c: Ctx, s: Source): boolean {
  const a = c.catalog.active;
  if (a === null || a.engine !== s.engine || a.model !== s.model) {
    return false;
  }
  return s.device === null || a.device === s.device || a.resolvedDevice === s.device;
}

interface Built {
  readonly state: RowState;
  readonly numbers: Numbers | null;
  readonly text: string | null;
  readonly error: string | null;
  readonly retry: 'measure' | 'retry' | null;
}

const EMPTY: Numbers = { p256: null, typical: null, long: null, k2: null };

function failed(error: string): Built {
  return {
    state: 'failed',
    numbers: null,
    text: `Failed: ${oneLine(error)}`,
    error,
    retry: 'retry',
  };
}

function plain(state: RowState, text: string, retry: Built['retry']): Built {
  return { state, numbers: null, text, error: null, retry };
}

function measuredBuilt(numbers: Numbers): Built {
  return { state: 'measured', numbers, text: null, error: null, retry: null };
}

/** A running job's live state or a failed target beats anything stored. */
function jobFirst(c: Ctx, t: BenchmarkTarget | undefined): Built | null {
  const live = t?.state == null ? undefined : LIVE_TEXT[t.state];
  if (c.busy && live !== undefined) {
    return plain('live', live, null);
  }
  return t?.state === 'failed' ? failed(t.error ?? 'failed') : null;
}

function storedState(s: Source): Built | null {
  if (s.measured?.failed != null) {
    return failed(s.measured.failed.error);
  }
  return s.measured?.typical == null ? null : measuredBuilt(fromMeasured(s.measured));
}

/** What a job knows when nothing is stored: new numbers, or why there are none. */
function jobLast(t: BenchmarkTarget | undefined): Built | null {
  if (t?.state === 'done' && fromTarget(t).typical !== null) {
    return measuredBuilt(fromTarget(t));
  }
  if (t?.state === 'discarded') {
    return plain('cancelled', 'Not measured (cancelled)', 'measure');
  }
  return t?.state === 'not-run' ? plain('not-run', 'Not run', 'measure') : null;
}

function buildState(c: Ctx, s: Source, t: BenchmarkTarget | undefined): Built {
  return (
    jobFirst(c, t) ??
    storedState(s) ??
    jobLast(t) ??
    plain('unmeasured', 'Speed not measured yet', 'measure')
  );
}

function isNoisy(n: Numbers | null): boolean {
  return n?.typical != null && n.typical.p95Ms > 2 * n.typical.p50Ms;
}

function isProvisional(s: Source): boolean {
  const m = s.measured;
  return m !== null && (m.provisional || (m.runs !== null && m.runs < 3));
}

function badgesOf(c: Ctx, s: Source, b: Built, fastest: boolean): RowBadge[] {
  const out: RowBadge[] = [];
  if (fastest) out.push({ kind: 'fastest', label: 'Fastest here' });
  if (isActive(c, s)) out.push({ kind: 'in-use', label: 'In use' });
  if (b.state === 'failed') out.push({ kind: 'failed', label: 'Failed' });
  if (b.state === 'measured' && s.measured?.freshness === 'stale') {
    out.push({ kind: 'stale', label: 'Out of date' });
  }
  if (b.state === 'measured' && isProvisional(s))
    out.push({ kind: 'provisional', label: 'Few runs' });
  if (b.state === 'measured' && isNoisy(b.numbers)) out.push({ kind: 'noisy', label: 'Noisy' });
  return out;
}

function retryAction(c: Ctx, s: Source, kind: 'measure' | 'retry' | null): BenchAction | null {
  if (kind === null) {
    return null;
  }
  const label = kind === 'measure' ? 'Measure' : 'Retry';
  return lockable(c, action(kind, label, { targets: [targetKey(s)] }));
}

function hintOf(s: Source, b: Built): string | null {
  return b.state === 'measured' && s.measured?.freshness === 'stale'
    ? 'Out of date — run again.'
    : null;
}

function accessible(
  label: string,
  runtime: string,
  s: Source,
  b: Built,
  badges: RowBadge[],
): string {
  const n = b.numbers;
  const parts = [`${label} on ${runtime}`, `${s.format} format`];
  if (n === null) {
    parts.push(b.text ?? '');
  } else {
    if (n.p256 !== null) parts.push(`256 tokens ${ms(n.p256)}`);
    if (n.typical !== null) parts.push(`typical ${ms(n.typical.p50Ms)}`);
    if (n.long !== null) parts.push(`long prompts ${ms(n.long)}`);
  }
  return [...parts, ...badges.map((x) => x.label.toLowerCase())].join(', ');
}

function rowOf(c: Ctx, s: Source, t: BenchmarkTarget | undefined, fastest = false): ResultRow {
  const built = buildState(c, s, t);
  const n = built.numbers ?? EMPTY;
  const runtime = runtimeName(c.catalog, { engine: s.engine, device: s.device, backend: null });
  const badges = badgesOf(c, s, built, fastest);
  return {
    key: keyOf(s.engine, s.model, s.device),
    engine: s.engine,
    model: s.model,
    device: s.device,
    runtime,
    format: s.format,
    state: built.state,
    p256: n.p256 === null ? null : ms(n.p256),
    typical: n.typical === null ? null : ms(n.typical.p50Ms),
    long: n.long === null ? null : ms(n.long),
    k2: n.k2 === null ? null : ms(n.k2),
    text: built.text,
    hint: hintOf(s, built),
    error: built.error,
    badges,
    action: retryAction(c, s, built.retry),
    accessibleName: accessible(s.family.label, runtime, s, built, badges),
  };
}

// ── groups ───────────────────────────────────────────────────────────────────────────────────

interface Entry {
  readonly source: Source;
  readonly target: BenchmarkTarget | undefined;
  readonly row: ResultRow;
  readonly p50: number | null;
}

function p50Of(row: ResultRow, s: Source, t: BenchmarkTarget | undefined): number | null {
  if (row.state !== 'measured') {
    return null;
  }
  return (
    s.measured?.typical?.p50Ms ?? (t === undefined ? null : (fromTarget(t).typical?.p50Ms ?? null))
  );
}

function fastestOf(entries: Entry[], currentBest: BenchTarget | null): Entry | null {
  if (currentBest !== null) {
    return (
      entries.find(
        (e) =>
          keyOf(e.source.engine, e.source.model, e.source.device) ===
          keyOf(currentBest.engine, currentBest.model, currentBest.device),
      ) ?? null
    );
  }
  const ranked = entries.filter(
    (e) => e.p50 !== null && e.source.measured?.freshness !== 'stale' && !isProvisional(e.source),
  );
  return ranked.reduce<Entry | null>(
    (a, e) => (a === null || (e.p50 ?? 0) < (a.p50 ?? 0) ? e : a),
    null,
  );
}

function runtimeCount(entries: Entry[]): number {
  return new Set(entries.map((e) => `${e.source.engine}|${e.source.device ?? ''}`)).size;
}

function useFastest(
  c: Ctx,
  family: string,
  entries: Entry[],
  best: Entry | null,
): BenchAction | null {
  if (best === null || !best.source.installed) {
    return null;
  }
  const word = best.row.runtime;
  const label = runtimeCount(entries) > 1 ? `Use fastest: ${word}` : `Use: ${word}`;
  if (c.auto) {
    return lockable(c, action('auto', label, { family }));
  }
  if (isActive(c, best.source)) {
    return null;
  }
  return lockable(c, action('use', label, { targets: [targetKey(best.source)] }));
}

function orderCurrent(c: Ctx, entries: Entry[]): Entry[] {
  const order = (c.catalog.recommendation?.machine?.runtimes ?? []).map(
    (r) => `${r.engine}|${r.device ?? ''}`,
  );
  const rank = (e: Entry): number => {
    const i = order.indexOf(`${e.source.engine}|${e.source.device ?? ''}`);
    return i < 0 ? order.length : i;
  };
  return entries.toSorted((a, b) => rank(a) - rank(b));
}

function orderBySpeed(entries: Entry[]): Entry[] {
  const key = (e: Entry): number => e.p50 ?? Number.POSITIVE_INFINITY;
  return entries.toSorted((a, b) => key(a) - key(b));
}

function groupOf(
  c: Ctx,
  family: { id: string; label: string },
  entries: Entry[],
  current: boolean,
): ResultGroup {
  const machine = c.catalog.recommendation?.machine;
  const best = current && machine?.best != null ? machine.best : null;
  const ordered = current ? orderCurrent(c, entries) : orderBySpeed(entries);
  const fastest = fastestOf(ordered, best);
  const rows = ordered.map((e) => (e === fastest ? rowOf(c, e.source, e.target, true) : e.row));
  return {
    family: family.id,
    label: family.label,
    current,
    rows,
    useFastest: useFastest(c, family.id, ordered, fastest),
  };
}

function bestP50(g: ResultGroup, entries: Map<string, Entry[]>): number {
  const list = entries.get(g.family) ?? [];
  return Math.min(...list.map((e) => e.p50 ?? Number.POSITIVE_INFINITY));
}

function buildGroups(c: Ctx): ResultGroup[] {
  const targets = new Map(
    (c.view?.targets ?? []).map((t) => [keyOf(t.engine, t.model, t.device), t]),
  );
  const families = new Map<string, { label: string; entries: Entry[] }>();
  for (const s of withJobTargets(c.catalog, c.view)) {
    const t = targets.get(keyOf(s.engine, s.model, s.device));
    const row = rowOf(c, s, t);
    const slot = families.get(s.family.id) ?? { label: s.family.label, entries: [] };
    slot.entries.push({ source: s, target: t, row, p50: p50Of(row, s, t) });
    families.set(s.family.id, slot);
  }
  const currentId = c.catalog.recommendation?.machine?.family ?? null;
  const groups = [...families].map(([id, f]) =>
    groupOf(c, { id, label: f.label }, f.entries, id === currentId),
  );
  const byFamily = new Map([...families].map(([id, f]) => [id, f.entries]));
  const speed = (g: ResultGroup): number => (g.current ? -1 : bestP50(g, byFamily));
  return groups.toSorted((a, b) => speed(a) - speed(b));
}

// ── header, progress and end states ──────────────────────────────────────────────────────────

function minutesText(seconds: number): string {
  return `${String(Math.max(1, Math.ceil(seconds / 60)))} min`;
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

function wordOf(c: Ctx, w: { engine: string; device: string | null }): string {
  return runtimeName(c.catalog, { engine: w.engine, device: w.device, backend: null });
}

function familyLabelOf(c: Ctx, id: string | null, fallback: string): string {
  const hit = id === null ? undefined : c.catalog.models.find((m) => m.family?.id === id)?.family;
  return hit?.label ?? id ?? fallback;
}

function promptText(tokens: number | null): string {
  if (tokens === null) return 'measuring';
  if (tokens <= 256) return 'short prompts';
  if (tokens <= 1024) return 'typical prompts';
  return `long prompts (${tokens.toLocaleString('en-US')} tokens)`;
}

function activityOf(c: Ctx, v: BenchmarkView): string | null {
  const cur = v.current;
  if (v.phase === 'restoring') {
    return 'Restoring your setup…';
  }
  if (cur === null || v.phase === null) {
    return null;
  }
  const what = `${familyLabelOf(c, cur.family, cur.model)} on ${wordOf(c, cur)}`;
  return v.phase === 'loading'
    ? `Loading ${what}…`
    : `Timing ${what} · ${promptText(cur.promptTokens)}`;
}

function restoreName(c: Ctx, v: BenchmarkView): string | null {
  const r = v.restore;
  if (r?.engine == null) {
    return null;
  }
  const family = familyLabelOf(c, r.family, r.model ?? r.engine);
  return `${family} on ${wordOf(c, { engine: r.engine, device: r.device })}`;
}

function startedNote(v: BenchmarkView): string | null {
  if (v.startedBy === 'cli') return 'Started from the command line.';
  return v.startedBy === 'api' ? 'Started from another client.' : null;
}

function progressOf(v: BenchmarkView): NonNullable<BenchmarkCard['progress']> {
  const eta = v.etaSeconds === null ? '' : ` · about ${minutesText(v.etaSeconds)} left`;
  return {
    completed: v.completed,
    total: v.total,
    fraction: v.total > 0 ? Math.min(1, v.completed / v.total) : 0,
    text: `${String(v.completed)} of ${String(v.total)}${eta}`,
  };
}

/** The quickest typical time among this run's finished targets, as `{family} on {runtime} ({t})`. */
function fastestText(c: Ctx, v: BenchmarkView): string | null {
  let best: { t: BenchmarkTarget; p50: number } | null = null;
  for (const t of v.targets) {
    const p50 = t.state === 'done' ? fromTarget(t).typical?.p50Ms : undefined;
    if (p50 != null && (best === null || p50 < best.p50)) {
      best = { t, p50 };
    }
  }
  if (best === null) {
    return null;
  }
  const family = familyLabelOf(c, best.t.family, best.t.model);
  return `Fastest here: ${family} on ${wordOf(c, best.t)} (${ms(best.p50)}).`;
}

function backNote(c: Ctx, v: BenchmarkView): string {
  const name = v.restoredOk === true ? restoreName(c, v) : null;
  return name === null ? '' : ` Your setup (${name}) is back.`;
}

function cancelledStatus(c: Ctx, v: BenchmarkView): string {
  switch (v.cancelReason) {
    case 'superseded':
    case 'config-changed':
      return `Cancelled because the engine selection changed. ${KEPT}`;
    case 'shutdown':
      return `Cancelled because the gateway stopped. ${KEPT}`;
    default:
      return `Cancelled after ${String(v.completed)} of ${String(v.total)}. ${KEPT}${backNote(c, v)}`;
  }
}

function doneStatus(c: Ctx, v: BenchmarkView): string {
  const head =
    v.failed > 0 ? `Finished; ${String(v.failed)} of ${String(v.total)} failed.` : 'Finished.';
  const fastest = fastestText(c, v);
  return `${head}${fastest === null ? '' : ` ${fastest}`}${backNote(c, v)}`;
}

function statusOf(c: Ctx, v: BenchmarkView): string | null {
  switch (v.state) {
    case 'done':
      return doneStatus(c, v);
    case 'cancelled':
      return cancelledStatus(c, v);
    case 'failed':
      return `The benchmark stopped: ${v.error ?? 'unknown error'}. ${KEPT}`;
    default:
      return null;
  }
}

function announcementOf(v: BenchmarkView, status: string | null): string | null {
  if (v.state === 'running' || v.state === 'cancelling') {
    if (v.completed === 0 && v.failed === 0) {
      return null;
    }
    const failedText = v.failed > 0 ? `, ${String(v.failed)} failed` : '';
    return `${String(v.completed)} of ${String(v.total)} finished${failedText}`;
  }
  return status;
}

function restoreFailure(c: Ctx, v: BenchmarkView): BenchmarkCard['restoreFailure'] {
  if (v.restoredOk !== false) {
    return null;
  }
  const name = restoreName(c, v) ?? 'your setup';
  const why = v.restoreError === null ? '' : `: ${v.restoreError}`;
  const target = v.restore;
  const targets =
    target?.engine == null || target.model == null
      ? []
      : [{ engine: target.engine, model: target.model, device: target.device }];
  return {
    text: `Couldn't switch back to ${name}${why}. Decisions are passed to you until an engine is running.`,
    retry: action('restore', 'Try again', { targets }),
    auto: action('auto', 'Use automatic', { family: target?.family ?? null }),
  };
}

// ── actions ──────────────────────────────────────────────────────────────────────────────────

function idleSummary(v: BenchmarkView | null): { summary: string | null; detail: string | null } {
  const p = v?.preview;
  if (p == null || p.total === 0) {
    return { summary: null, detail: null };
  }
  const time = p.etaSeconds === null ? '' : `About ${minutesText(p.etaSeconds)} · `;
  const custom = p.excluded.length > 0 ? " Custom servers aren't benchmarked." : '';
  return {
    summary: `${time}${plural(p.total, 'runtime')}`,
    detail: `Decisions are passed to you while it runs; your current setup comes back when it ends.${custom}`,
  };
}

function runAction(v: BenchmarkView | null, label: string): BenchAction {
  if (v === null) {
    return action('run', label, {
      disabled: true,
      hint: "Benchmarking isn't available on this gateway.",
    });
  }
  if (v.preview?.total === 0) {
    return action('run', label, {
      disabled: true,
      hint: 'Install a runtime first; see the recommendation above.',
    });
  }
  return action('run', label);
}

function hasStale(groups: readonly ResultGroup[]): boolean {
  return groups.some((g) => g.rows.some((r) => r.badges.some((b) => b.kind === 'stale')));
}

function hasResults(groups: readonly ResultGroup[]): boolean {
  return groups.some((g) => g.rows.some((r) => r.state === 'measured'));
}

interface Actions {
  readonly primary: BenchAction;
  readonly secondary: BenchAction[];
}

function endActions(v: BenchmarkView | null): Actions {
  const again = runAction(v, 'Run again');
  const finish = action('finish', 'Finish benchmark', { only: 'missing' });
  const show = action('show-results', 'Show results');
  if (v?.state === 'done') {
    return { primary: again, secondary: [show] };
  }
  if (v?.state === 'cancelled') {
    return v.cancelReason === 'user' || v.cancelReason === null
      ? { primary: finish, secondary: [again] }
      : { primary: finish, secondary: [] };
  }
  return { primary: again, secondary: [] };
}

function actionsOf(v: BenchmarkView | null, groups: readonly ResultGroup[]): Actions {
  if (v?.state === 'running') {
    return { primary: action('cancel', 'Cancel benchmark'), secondary: [] };
  }
  if (v?.state === 'cancelling') {
    return { primary: action('cancel', 'Cancelling…', { disabled: true }), secondary: [] };
  }
  if (v?.state === 'done' || v?.state === 'cancelled' || v?.state === 'failed') {
    return endActions(v);
  }
  const stale = hasResults(groups) && hasStale(groups);
  return { primary: runAction(v, stale ? 'Run again' : 'Run benchmark'), secondary: [] };
}

function footerOf(v: BenchmarkView | null, groups: readonly ResultGroup[]): string[] {
  const out: string[] = [];
  if (v !== null && v.state !== 'idle' && v.state !== 'done') {
    out.push(KEPT);
  }
  if (hasResults(groups)) {
    out.push(MACHINE_ONLY);
  }
  return out;
}

interface ViewParts {
  readonly stateLabel: string | null;
  readonly summary: string | null;
  readonly detail: string | null;
  readonly activity: string | null;
  readonly progress: BenchmarkCard['progress'];
  readonly startedNote: string | null;
  readonly status: string | null;
  readonly announcement: string | null;
  readonly restoreFailure: BenchmarkCard['restoreFailure'];
  readonly resultsExpanded: boolean;
}

const NO_VIEW: ViewParts = {
  stateLabel: null,
  summary: null,
  detail: null,
  activity: null,
  progress: null,
  startedNote: null,
  status: null,
  announcement: null,
  restoreFailure: null,
  resultsExpanded: false,
};

function isRunning(v: BenchmarkView | null): boolean {
  return v?.state === 'running' || v?.state === 'cancelling';
}

function isTerminal(v: BenchmarkView | null): boolean {
  return v?.state === 'done' || v?.state === 'cancelled' || v?.state === 'failed';
}

function viewParts(c: Ctx, v: BenchmarkView): ViewParts {
  const running = isRunning(v);
  const status = statusOf(c, v);
  const idle = running || v.state === 'done' ? { summary: null, detail: null } : idleSummary(v);
  return {
    ...NO_VIEW,
    ...idle,
    stateLabel: running ? (v.state === 'cancelling' ? 'Cancelling' : 'Running') : null,
    activity: running ? activityOf(c, v) : null,
    progress: running ? progressOf(v) : null,
    startedNote: running ? startedNote(v) : null,
    status,
    announcement: announcementOf(v, status),
    restoreFailure: restoreFailure(c, v),
    resultsExpanded: running || isTerminal(v),
  };
}

/** Card 2 for the job view (null when the gateway has no benchmark) and the engines catalog. */
export function benchmarkCard(view: BenchmarkView | null, catalog: EngineCatalog): BenchmarkCard {
  const c: Ctx = {
    catalog,
    view,
    busy: isRunning(view) || catalog.active?.benchmark != null,
    auto: catalog.active?.selectionMode === 'auto',
  };
  const groups = buildGroups(c);
  const actions = actionsOf(view, groups);
  return {
    ...(view === null ? NO_VIEW : viewParts(c, view)),
    state: view?.state ?? 'idle',
    description: DESCRIPTION,
    primary: actions.primary,
    secondary: actions.secondary,
    footer: footerOf(view, groups),
    showK2: groups.some((g) => g.rows.some((r) => r.k2 !== null)),
    groups,
  };
}
