/**
 * Pure helpers of `local-decider bench`: argument parsing, target syntax, and the text and exit
 * code of a finished run. The CLI itself (HTTP, polling, SIGINT) lives in cli.ts.
 */
import { parseArgs } from 'node:util';

import { DEVICES } from './engines/descriptor.ts';
import { SELECTABLE_IDS, isSelectableEngine } from './engines/registry.ts';

const DEFAULT_SIZES: readonly number[] = [256, 1024, 3800];
const DEFAULT_RUNS = 5;

export interface BenchTargetSpec {
  readonly engine: string;
  readonly model: string;
  readonly device?: string;
}

export interface BenchArgs {
  readonly scope: 'active' | 'installed' | 'family' | 'targets';
  readonly family?: string;
  readonly targets?: readonly BenchTargetSpec[];
  readonly only?: 'missing';
  readonly sizes: readonly number[];
  readonly runs: number;
  readonly json: boolean;
}

/** A usage error is exit code 2. */
export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly exitCode: 2 };

function fail(error: string): { ok: false; error: string; exitCode: 2 } {
  return { ok: false, error, exitCode: 2 };
}

const DEVICE_SET: ReadonlySet<string> = new Set(DEVICES.filter((d) => d !== 'auto'));

/** `model@cuda` is a model on a device only when the suffix is a real, non-`auto` device. */
function splitDevice(rest: string): { model: string; device?: string } {
  const at = rest.lastIndexOf('@');
  const suffix = at < 0 ? '' : rest.slice(at + 1);
  return DEVICE_SET.has(suffix) ? { model: rest.slice(0, at), device: suffix } : { model: rest };
}

function parseTarget(item: string): Parsed<BenchTargetSpec> {
  const colon = item.indexOf(':');
  const engine = (colon < 0 ? item : item.slice(0, colon)).trim();
  const rest = colon < 0 ? '' : item.slice(colon + 1).trim();
  if (engine === '') {
    return fail(`empty engine in "${item}"`);
  }
  if (!isSelectableEngine(engine)) {
    return fail(`unknown engine "${engine}" (expected one of ${SELECTABLE_IDS.join(', ')})`);
  }
  const { model, device } = splitDevice(rest);
  if (model === '') {
    return fail(`empty model in "${item}"`);
  }
  return { ok: true, value: { engine, model, ...(device === undefined ? {} : { device }) } };
}

/**
 * `engine:model[@device],…`. Items split on `,`, each on its first `:` so model ids may contain
 * colons (`fastflowlm:d3:mini`).
 */
export function parseBenchTargets(list: string): Parsed<BenchTargetSpec[]> {
  const targets: BenchTargetSpec[] = [];
  for (const item of list.split(',')) {
    const parsed = parseTarget(item.trim());
    if (!parsed.ok) {
      return parsed;
    }
    targets.push(parsed.value);
  }
  return { ok: true, value: targets };
}

function parseIntegers(text: string, flag: string): Parsed<number[]> {
  const values: number[] = [];
  for (const part of text.split(',')) {
    if (!/^\d+$/.test(part.trim())) {
      return fail(`${flag} needs whole numbers, got "${part}"`);
    }
    values.push(Number.parseInt(part.trim(), 10));
  }
  return { ok: true, value: values };
}

interface Flags {
  readonly engines?: string | undefined;
  readonly installed?: boolean | undefined;
  readonly family?: string | undefined;
  readonly missing?: boolean | undefined;
  readonly sizes?: string | undefined;
  readonly runs?: string | undefined;
  readonly json?: boolean | undefined;
}

function readFlags(argv: readonly string[]): Parsed<Flags> {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        engines: { type: 'string' },
        installed: { type: 'boolean' },
        family: { type: 'string' },
        missing: { type: 'boolean' },
        sizes: { type: 'string' },
        runs: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    return { ok: true, value: values };
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'bad arguments');
  }
}

type Scope = Pick<BenchArgs, 'scope' | 'family' | 'targets'>;

function readScope(f: Flags): Parsed<Scope> {
  const given = [f.engines !== undefined, f.installed === true, f.family !== undefined];
  if (given.filter(Boolean).length > 1) {
    return fail('use only one of --engines, --installed and --family');
  }
  if (f.engines !== undefined) {
    const targets = parseBenchTargets(f.engines);
    return targets.ok ? { ok: true, value: { scope: 'targets', targets: targets.value } } : targets;
  }
  if (f.family !== undefined) {
    return f.family.trim() === ''
      ? fail('--family needs a model family id')
      : { ok: true, value: { scope: 'family', family: f.family.trim() } };
  }
  return { ok: true, value: { scope: f.installed === true ? 'installed' : 'active' } };
}

function readCounts(f: Flags): Parsed<{ sizes: number[]; runs: number }> {
  const sizes =
    f.sizes === undefined
      ? { ok: true as const, value: [...DEFAULT_SIZES] }
      : parseIntegers(f.sizes, '--sizes');
  if (!sizes.ok) {
    return sizes;
  }
  const runs =
    f.runs === undefined
      ? { ok: true as const, value: [DEFAULT_RUNS] }
      : parseIntegers(f.runs, '--runs');
  if (!runs.ok) {
    return runs;
  }
  return runs.value.length === 1
    ? { ok: true, value: { sizes: sizes.value, runs: runs.value[0] ?? DEFAULT_RUNS } }
    : fail('--runs takes one whole number');
}

export function parseBenchArgs(argv: readonly string[]): Parsed<BenchArgs> {
  const flags = readFlags(argv);
  if (!flags.ok) {
    return flags;
  }
  const scope = readScope(flags.value);
  if (!scope.ok) {
    return scope;
  }
  const counts = readCounts(flags.value);
  if (!counts.ok) {
    return counts;
  }
  return {
    ok: true,
    value: {
      ...scope.value,
      ...(flags.value.missing === true ? { only: 'missing' as const } : {}),
      ...counts.value,
      json: flags.value.json === true,
    },
  };
}

// ── output ───────────────────────────────────────────────────────────────────────────────────

/** The part of the `BenchmarkView` the CLI reads (`GET /v1/benchmark`). */
export interface BenchSize {
  readonly targetTokens: number;
  readonly inputTokens?: number | null;
  readonly p50Ms?: number | null;
  readonly p95Ms?: number | null;
  readonly answer?: string | null;
  readonly error?: string | null;
}

export interface BenchViewTarget {
  readonly engine: string;
  readonly model: string;
  readonly device?: string | null;
  readonly state?: string | null;
  readonly loadMs?: number | null;
  readonly error?: string | null;
  readonly sizes?: readonly BenchSize[];
}

export interface BenchView {
  readonly state?: string | null;
  readonly runs?: number | null;
  readonly targets?: readonly BenchViewTarget[];
  readonly restore?: { readonly engine?: string | null; readonly model?: string | null } | null;
  readonly restoredOk?: boolean | null;
  readonly restoreError?: string | null;
  readonly cancelReason?: string | null;
  readonly error?: string | null;
}

/** `fastflowlm d3:mini (NPU)`; without a backend word, just the engine and model. */
export function formatTarget(
  t: { readonly engine: string; readonly model: string },
  backendWord: string | null,
): string {
  const base = `${t.engine} ${t.model}`;
  return backendWord === null || backendWord === '' ? base : `${base} (${backendWord})`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function sizeLine(s: BenchSize, provisional: boolean): string {
  const head = `${String(s.targetTokens).padStart(5)} tok`;
  if (s.p50Ms == null || s.p95Ms == null) {
    return `${head}: failed: ${s.error ?? 'no answer'}`;
  }
  const line = `${head} (engine ${String(s.inputTokens ?? '?')}): p50 ${s.p50Ms.toFixed(0)} ms, p95 ${s.p95Ms.toFixed(0)} ms, answer=${s.answer ?? '?'}`;
  return provisional ? `${line} provisional` : line;
}

const TARGET_NOTES: Readonly<Record<string, string>> = {
  'discarded': '  not measured (cancelled)',
  'not-run': '  not run',
};

function targetLines(t: BenchViewTarget, provisional: boolean): string[] {
  const lines = [formatTarget(t, t.device ?? null)];
  const note = TARGET_NOTES[t.state ?? ''];
  if (note !== undefined) {
    return [...lines, note];
  }
  if (t.loadMs != null) {
    lines.push(`  load ${seconds(t.loadMs)}`);
  }
  lines.push(...(t.sizes ?? []).map((s) => sizeLine(s, provisional)));
  if (t.state === 'failed') {
    lines.push(`  failed: ${t.error ?? 'unknown error'}`);
  }
  return lines;
}

function endLines(view: BenchView): string[] {
  const lines: string[] = [];
  const r = view.restore;
  if (view.restoredOk === true && r?.engine != null) {
    lines.push(`restored ${r.engine} ${r.model ?? ''}`.trimEnd());
  }
  if (view.restoredOk === false) {
    lines.push(`restore failed: ${view.restoreError ?? 'unknown error'}`);
  }
  if (view.state === 'cancelled') {
    lines.push(`cancelled (${view.cancelReason ?? 'unknown'})`);
  }
  if (view.state === 'failed') {
    lines.push(`benchmark failed: ${view.error ?? 'unknown error'}`);
  }
  return lines;
}

/** The text of a finished run: each target, then the restore result and how it ended. */
export function formatFinal(view: BenchView): string[] {
  const provisional = view.runs != null && view.runs < 3;
  return [...(view.targets ?? []).flatMap((t) => targetLines(t, provisional)), ...endLines(view)];
}

/**
 * 0: done with at least one finished target. 130: Ctrl-C. 1: everything else (all targets
 * failed, a failed job, cancelled by someone else or preempted, no view).
 */
export function exitCodeFor(
  view: BenchView | null,
  options: { readonly interrupted: boolean },
): 0 | 1 | 130 {
  if (options.interrupted) {
    return 130;
  }
  const finished = view?.targets?.some((t) => t.state === 'done') === true;
  return view?.state === 'done' && finished ? 0 : 1;
}
