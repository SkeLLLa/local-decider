/**
 * Card 1, "Recommended for this machine", as a pure view model: one primary kind (plan §8.2, the
 * first matching row wins), activity overlays, condition badges and the copy of the UX brief.
 */
import type { ActiveEngine, EngineCatalog } from './engines.ts';
import type { MachineOption, MachineRecommendation } from './machine.ts';
import { backendOf, minutes, type SelectionMode } from './recommendation.ts';

export type CardKind =
  | 'unsupported'
  | 'uncalibrated'
  | 'fallback'
  | 'needs-install'
  | 'needs-download'
  | 'estimated'
  | 'manual-differs'
  | 'ok-manual'
  | 'ok-auto';

/**
 * `use`, `download`, `install` (show install steps), `auto` (turn automatic on for `family`)
 * and `none` are the primary kinds. The others only appear as secondary actions or, for
 * `benchmark` and `connect`, as the primary of `estimated` and `unsupported`.
 */
export type ActionKind =
  | 'use'
  | 'download'
  | 'install'
  | 'auto'
  | 'none'
  | 'benchmark'
  | 'finish-benchmark'
  | 'choose'
  | 'details'
  | 'connect';

export interface ActionTarget {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
}

export interface CardAction {
  readonly kind: ActionKind;
  readonly label: string;
  /** Why the action is disabled, else null. */
  readonly hint: string | null;
  readonly disabled: boolean;
  readonly target: ActionTarget | null;
  /** The family automatic selection should prefer (`auto`, `benchmark`). */
  readonly family: string | null;
}

export type BadgeKind = 'stale' | 'partial' | 'provisional' | 'noisy';

export interface CardBadge {
  readonly kind: BadgeKind;
  readonly label: string;
}

export interface RecommendedCard {
  readonly kind: CardKind;
  readonly mode: 'Automatic' | 'Manual' | null;
  readonly headline: string;
  /** Typical then long latency, or "Speed not measured yet"; null without a best option. */
  readonly latency: string | null;
  readonly reasonText: string | null;
  readonly status: string;
  readonly primary: CardAction;
  readonly secondary: readonly CardAction[];
  readonly badges: readonly CardBadge[];
  /** The one secondary line a badge adds (stale beats partial beats provisional beats noisy). */
  readonly note: string | null;
  readonly overlay: 'benchmarking' | 'switching' | null;
  readonly overlayText: string | null;
  readonly overlayLink: string | null;
  /** "{label} is about {ratio}× faster on this machine."; null when no faster family. */
  readonly fasterFamilyText: string | null;
}

interface Ctx {
  readonly catalog: EngineCatalog;
  readonly machine: MachineRecommendation | null;
  readonly best: MachineOption | null;
  readonly active: ActiveEngine | null;
  readonly mode: SelectionMode | null;
  readonly now: number;
}

interface Core {
  readonly headline: string;
  readonly status: string;
  readonly primary: CardAction;
  readonly secondary: readonly CardAction[];
}

const BLOCKED = new Set(['unsupported-platform', 'no-memory', 'no-hardware']);
const BUSY_HINT = 'Available when this finishes.';

function act(kind: ActionKind, label: string, rest: Partial<CardAction> = {}): CardAction {
  return { kind, label, hint: null, disabled: false, target: null, family: null, ...rest };
}

const NO_ACTION = act('none', '');

function targetOf(o: MachineOption): ActionTarget {
  return { engine: o.engine, model: o.model, device: o.device };
}

// ── names ────────────────────────────────────────────────────────────────────────────────────

const RUNTIME_WORDS: Record<string, string> = {
  NPU: 'NPU',
  Vulkan: 'GPU (Vulkan)',
  CUDA: 'GPU (CUDA)',
  MLX: 'Apple GPU',
  MPS: 'Apple GPU',
  CPU: 'CPU',
};

interface Where {
  readonly engine: string;
  readonly device: string | null;
  readonly backend: string | null;
}

function runtimeWord(c: Ctx, w: Where): string {
  const backend = w.backend ?? backendOf(w.engine, w.device);
  if (backend !== null) {
    return RUNTIME_WORDS[backend] ?? backend;
  }
  return c.catalog.engines.find((e) => e.id === w.engine)?.label ?? w.engine;
}

function engineLabel(c: Ctx, id: string): string {
  return c.catalog.engines.find((e) => e.id === id)?.label ?? id;
}

function bestWord(c: Ctx): string {
  return c.best === null ? 'this runtime' : runtimeWord(c, c.best);
}

function runningWord(c: Ctx): string {
  const a = c.active;
  if (a?.engine == null) {
    return 'another runtime';
  }
  return runtimeWord(c, {
    engine: a.engine,
    device: a.resolvedDevice ?? a.device,
    backend: a.backend,
  });
}

function familyLabel(c: Ctx): string {
  return c.machine?.familyLabel ?? '';
}

function headlineOf(c: Ctx): string {
  if (c.machine === null) {
    return c.active?.engine == null ? 'Engine and model' : `Running on ${runningWord(c)}`;
  }
  return c.best === null ? c.machine.familyLabel : `${c.machine.familyLabel} on ${bestWord(c)}`;
}

// ── numbers and dates ────────────────────────────────────────────────────────────────────────

function ms(value: number): string {
  const rounded = Math.round(value / 10) * 10;
  return rounded < 1000 ? `${String(rounded)} ms` : `${(rounded / 1000).toFixed(1)} s`;
}

/** `37% faster` below 2×, `2.3× faster` from there. */
function ratioText(ratio: number): string {
  return ratio < 2
    ? `${String(Math.round((ratio - 1) * 100))}% faster`
    : `${String(Number(ratio.toFixed(1)))}× faster`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateText(iso: string | null | undefined): string | null {
  const t = iso == null ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(t)) {
    return null;
  }
  const d = new Date(t);
  return `${String(d.getDate())} ${MONTHS[d.getMonth()] ?? ''}`;
}

function latencyOf(c: Ctx): string | null {
  if (c.best === null) {
    return null;
  }
  const m = c.best.measured;
  if (m?.typical == null) {
    return 'Speed not measured yet';
  }
  const long = m.long === null ? '' : ` · ${ms(m.long.p50Ms)} on long prompts`;
  return `${ms(m.typical.p50Ms)} per decision${long}`;
}

// ── reason line ──────────────────────────────────────────────────────────────────────────────

function runnerUpWord(c: Ctx): string {
  const r = c.machine?.runnerUp;
  return r == null ? 'the next option' : runtimeWord(c, r);
}

function reasonOf(c: Ctx): string | null {
  const m = c.machine;
  if (m === null || m.reason === null || c.best === null) {
    return null;
  }
  const date = dateText(c.best.measured?.measuredAt);
  const measured = date === null ? '' : `Measured ${date}. `;
  const same = `About the same as ${runnerUpWord(c)}`;
  switch (m.reason) {
    case 'fastest-measured':
      return m.ratio === null
        ? measured.trim()
        : `${measured}${ratioText(m.ratio)} than ${runnerUpWord(c)}.`;
    case 'tie-dedicated':
      return `${measured}${same}; the NPU is steadier and leaves your GPU free.`;
    case 'tie-steadier':
      return `${measured}${same}; ${bestWord(c)} is steadier.`;
    case 'tie-ladder':
      return `${same}.`;
    case 'only-measured':
      return `${measured}Other runtimes here weren't measured.`;
    case 'estimated':
      return `Speed not measured yet. ${bestWord(c)} is usually fastest on this kind of hardware.`;
    default:
      return `${m.familyLabel} runs only on ${bestWord(c)} here.`;
  }
}

// ── badges ───────────────────────────────────────────────────────────────────────────────────

function isNoisy(c: Ctx): boolean {
  const t = c.best?.measured?.typical;
  return t != null && t.p95Ms > 2 * t.p50Ms;
}

function isProvisional(c: Ctx): boolean {
  const m = c.best?.measured;
  return m != null && (m.provisional || (m.runs !== null && m.runs < 3));
}

function badgesOf(c: Ctx): CardBadge[] {
  const out: CardBadge[] = [];
  if (c.machine?.stale === true) {
    out.push({ kind: 'stale', label: 'Out of date' });
  }
  if (c.machine?.partial === true) {
    out.push({ kind: 'partial', label: 'Partly measured' });
  }
  if (isProvisional(c)) {
    out.push({ kind: 'provisional', label: 'Few runs' });
  }
  if (isNoisy(c)) {
    out.push({ kind: 'noisy', label: 'Noisy' });
  }
  return out;
}

function noteOf(c: Ctx, kind: BadgeKind): string {
  switch (kind) {
    case 'stale': {
      const why = c.machine?.staleReason == null ? '' : ` ${c.machine.staleReason}.`;
      return `Out of date — run again.${why} Not used for ranking until measured again.`;
    }
    case 'partial':
      return "Other runtimes here weren't measured.";
    case 'provisional': {
      const n = c.best?.measured?.runs ?? 1;
      return `Measured from ${String(n)} ${n === 1 ? 'run' : 'runs'}; run again for a steadier result.`;
    }
    default:
      return 'Times vary a lot here, often because the GPU is shared with the display.';
  }
}

function badgeAction(kind: BadgeKind, family: string | null): CardAction | null {
  switch (kind) {
    case 'partial':
      return act('finish-benchmark', 'Finish benchmark', { family });
    case 'noisy':
      return null;
    default:
      return act('benchmark', 'Run benchmark again', { family });
  }
}

// ── primary kind (plan §8.2: the first match wins) ───────────────────────────────────────────

function isUnsupported(c: Ctx): boolean {
  const candidates = c.catalog.recommendation?.candidates ?? [];
  const noBest = c.machine === null || c.best === null;
  const connection = c.catalog.engines.some((e) => e.connection !== null);
  return (
    noBest &&
    !connection &&
    candidates.length > 0 &&
    candidates.every((x) => x.code !== null && BLOCKED.has(x.code))
  );
}

function isUncalibrated(c: Ctx): boolean {
  const id = c.active?.engine;
  return id != null && c.catalog.engines.find((e) => e.id === id)?.calibrated === false;
}

function isFallback(c: Ctx): boolean {
  return (
    c.mode === 'auto' &&
    (c.active?.fallback != null || c.machine?.availability === 'family-unavailable')
  );
}

function kindOf(c: Ctx): CardKind {
  const action = c.machine?.action ?? null;
  const reason = c.machine?.reason ?? null;
  if (isUnsupported(c)) return 'unsupported';
  if (isUncalibrated(c)) return 'uncalibrated';
  if (isFallback(c)) return 'fallback';
  if (action === 'install') return 'needs-install';
  if (action === 'download') return 'needs-download';
  if (reason === 'estimated') return 'estimated';
  if (c.mode === 'manual' && action === 'use') return 'manual-differs';
  return c.mode === 'auto' ? 'ok-auto' : 'ok-manual';
}

// ── per-kind cores ───────────────────────────────────────────────────────────────────────────

function useLabel(c: Ctx, text: string): string {
  return c.mode === 'auto' ? `${text} (turns off automatic)` : text;
}

function useAction(c: Ctx, o: MachineOption, text: string): CardAction {
  return act('use', useLabel(c, text), { target: targetOf(o) });
}

function autoAction(c: Ctx): CardAction {
  const family = c.machine?.family ?? c.active?.preferredFamily ?? null;
  return act('auto', 'Use automatic', { family });
}

const CHOOSE = act('choose', 'Choose another…');

function unsupportedCore(c: Ctx): Core {
  const reason = c.catalog.recommendation?.candidates.find((x) => x.reason !== '')?.reason;
  return {
    headline: 'No local model can run here',
    status: reason ?? 'No local model can run on this machine.',
    primary: act('connect', 'Connect a model server'),
    secondary: [],
  };
}

function uncalibratedCore(c: Ctx): Core {
  const id = c.active?.engine ?? '';
  const model = c.catalog.models.find((m) => m.engine === id && m.id === c.active?.model);
  return {
    headline: `${model?.label ?? c.active?.model ?? 'Model'} on ${engineLabel(c, id)}`,
    status:
      "This engine's confidence isn't calibrated, so the policy thresholds may not fit. Automatic never picks it.",
    primary: NO_ACTION,
    secondary: [autoAction(c)],
  };
}

function retryText(c: Ctx, retryAt: string | null): string {
  const at = retryAt === null ? Number.NaN : Date.parse(retryAt);
  if (Number.isNaN(at)) {
    return 'It will be retried.';
  }
  return `Retrying in ${minutes(Math.max(0, Math.round((at - c.now) / 1000)))}.`;
}

function fallbackCore(c: Ctx): Core {
  const fb = c.active?.fallback;
  if (fb == null) {
    return {
      headline: familyLabel(c),
      status: `${familyLabel(c)} can't run on this machine right now. Running ${runningWord(c)} instead.`,
      primary: NO_ACTION,
      secondary: [CHOOSE],
    };
  }
  const failed =
    fb.engine === null
      ? 'The preferred runtime'
      : runtimeWord(c, { engine: fb.engine, device: fb.device, backend: null });
  return {
    headline: headlineOf(c),
    status: `${failed} failed: ${fb.reason}. Running on ${runningWord(c)} for now. ${retryText(c, fb.retryAt)}`,
    primary: NO_ACTION,
    secondary: [act('details', 'Details')],
  };
}

/** The next runtime that is installed, downloaded and allowed, after the recommended one. */
function nextInstalled(c: Ctx): MachineOption | null {
  const picks = (c.machine?.runtimes ?? []).map((r) => r.pick);
  return (
    picks.find((p) => p !== null && p !== c.best && p.ready && p.eligible && p.downloaded) ?? null
  );
}

function installCore(c: Ctx): Core {
  const best = c.best;
  const next = nextInstalled(c);
  return {
    headline: headlineOf(c),
    status: `${bestWord(c)} needs ${engineLabel(c, best?.engine ?? '')}, which isn't installed on the gateway machine.`,
    primary: act('install', 'Show install steps', {
      target: best === null ? null : targetOf(best),
    }),
    secondary: next === null ? [] : [useAction(c, next, `Use ${runtimeWord(c, next)} for now`)],
  };
}

function downloadCore(c: Ctx): Core {
  const best = c.best;
  const gb = c.catalog.models.find(
    (m) => m.engine === best?.engine && m.id === best?.model,
  )?.downloadGb;
  const size = gb == null ? '' : ` (${String(gb)} GB)`;
  return {
    headline: headlineOf(c),
    status: `${familyLabel(c)} for ${bestWord(c)} isn't downloaded yet${size}.`,
    primary: act('download', `Download${size}`, {
      target: best === null ? null : targetOf(best),
    }),
    secondary: c.mode === 'manual' ? [autoAction(c)] : [],
  };
}

function estimatedCore(c: Ctx): Core {
  const best = c.best;
  const bench = act('benchmark', 'Run benchmark', { family: c.machine?.family ?? null });
  const canUse = c.machine?.action === 'use' && best !== null;
  return {
    headline: headlineOf(c),
    status: 'Ranked by hardware type. Benchmark to measure this machine.',
    primary: canUse ? useAction(c, best, `Use ${bestWord(c)}`) : bench,
    secondary: canUse ? [bench, CHOOSE] : [CHOOSE],
  };
}

/** How much faster the best option is than the active one, when both are measured. */
function activeRatio(c: Ctx): number | null {
  const current = c.machine?.runtimes.flatMap((r) => r.variants).find((v) => v.active);
  const a = current?.measured?.typical?.p50Ms;
  const b = c.best?.measured?.typical?.p50Ms;
  return a == null || b == null || b <= 0 || a <= b ? null : a / b;
}

function differsCore(c: Ctx): Core {
  const best = c.best;
  const ratio = activeRatio(c);
  const tail =
    ratio === null
      ? `${bestWord(c)} is usually faster on this kind of hardware.`
      : `${bestWord(c)} is ${ratioText(ratio)} here.`;
  return {
    headline: headlineOf(c),
    status: `You picked ${familyLabel(c)} on ${runningWord(c)} manually. ${tail}`,
    primary: best === null ? NO_ACTION : useAction(c, best, `Use ${bestWord(c)}`),
    secondary: [autoAction(c)],
  };
}

function okManualCore(c: Ctx): Core {
  return {
    headline: headlineOf(c),
    status:
      "You're on the recommended setup, chosen manually. Automatic would also fall back if it fails.",
    primary: NO_ACTION,
    secondary: [autoAction(c), CHOOSE],
  };
}

function okAutoCore(c: Ctx): Core {
  return {
    headline: headlineOf(c),
    status: "You're on the recommended setup.",
    primary: NO_ACTION,
    secondary: [
      act('benchmark', 'Run benchmark again', { family: c.machine?.family ?? null }),
      CHOOSE,
    ],
  };
}

const CORES: Record<CardKind, (c: Ctx) => Core> = {
  'unsupported': unsupportedCore,
  'uncalibrated': uncalibratedCore,
  'fallback': fallbackCore,
  'needs-install': installCore,
  'needs-download': downloadCore,
  'estimated': estimatedCore,
  'manual-differs': differsCore,
  'ok-manual': okManualCore,
  'ok-auto': okAutoCore,
};

// ── overlays ─────────────────────────────────────────────────────────────────────────────────

interface Overlay {
  readonly kind: 'benchmarking' | 'switching' | null;
  readonly text: string | null;
  readonly link: string | null;
}

function overlayOf(c: Ctx): Overlay {
  const b = c.active?.benchmark;
  if (b != null) {
    return {
      kind: 'benchmarking',
      text: `Benchmark running (${String(b.completed)} of ${String(b.total)}). Decisions are passed to you until it finishes.`,
      link: 'Go to benchmark',
    };
  }
  if (c.active?.state === 'starting') {
    return {
      kind: 'switching',
      text: `Switching to ${familyLabel(c)} on ${runningWord(c)}. Decisions are passed to you until it's ready.`,
      link: null,
    };
  }
  return { kind: null, text: null, link: null };
}

function lock(action: CardAction): CardAction {
  return action.kind === 'none' ? action : { ...action, disabled: true, hint: BUSY_HINT };
}

function withBadgeAction(
  c: Ctx,
  secondary: readonly CardAction[],
  note: BadgeKind | null,
): readonly CardAction[] {
  const extra = note === null ? null : badgeAction(note, c.machine?.family ?? null);
  const taken = extra !== null && secondary.some((s) => s.label === extra.label);
  return extra === null || taken ? secondary : [...secondary, extra];
}

/**
 * The card for the catalog and selection mode. `mode` is `active.selectionMode`; `now` only
 * feeds the retry countdown.
 */
export function recommendedCard(
  catalog: EngineCatalog,
  mode: SelectionMode | null = catalog.active?.selectionMode ?? null,
  now: number = Date.now(),
): RecommendedCard {
  const machine = catalog.recommendation?.machine ?? null;
  const c: Ctx = {
    catalog,
    machine,
    best: machine?.best ?? null,
    active: catalog.active,
    mode,
    now,
  };
  const kind = kindOf(c);
  const core = CORES[kind](c);
  const badges = badgesOf(c);
  const top = badges[0]?.kind ?? null;
  const overlay = overlayOf(c);
  const busy = overlay.kind !== null;
  const secondary = withBadgeAction(c, core.secondary, top);
  return {
    kind,
    mode: mode === 'auto' ? 'Automatic' : mode === 'manual' ? 'Manual' : null,
    headline: core.headline,
    latency: latencyOf(c),
    reasonText: reasonOf(c),
    status: core.status,
    primary: busy ? lock(core.primary) : core.primary,
    secondary: busy ? secondary.map(lock) : secondary,
    badges,
    note: top === null ? null : noteOf(c, top),
    overlay: overlay.kind,
    overlayText: overlay.text,
    overlayLink: overlay.link,
    fasterFamilyText: fasterText(machine),
  };
}

function fasterText(machine: MachineRecommendation | null): string | null {
  const f = machine?.fasterFamily;
  if (f == null || f.ratio === null) {
    return null;
  }
  return `${f.label} is about ${String(Number(f.ratio.toFixed(1)))}× faster on this machine.`;
}
