import { familyLabel } from './families.ts';
import type { Device } from './descriptor.ts';
import type { Backend, Candidate } from './selector.ts';

export const TYPICAL_TOKENS = 1024;
export const LONG_TOKENS = 3800;
export const CLOSE_CALL = 0.1;
export const MIN_RANK_RUNS = 3;

export interface Timings {
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface Measured {
  readonly typical: Timings;
  readonly long: Timings | null;
  readonly runs: number;
  readonly measuredAt: string;
  readonly freshness: 'fresh' | 'stale' | 'unknown';
  readonly staleReason: string | null;
  readonly provisional: boolean;
}

export interface MeasurementView {
  readonly ok: Measured | null;
  readonly failed: { readonly error: string; readonly at: string } | null;
}

export type Measurements = ReadonlyMap<string, MeasurementView>;

export const rankable = (measurement: Measured | null): measurement is Measured =>
  measurement !== null && measurement.freshness === 'fresh' && !measurement.provisional;

function hasRankableMeasurement(
  option: MachineOption | null,
): option is MachineOption & { readonly measured: Measured } {
  return option !== null && rankable(option.measured);
}

export interface MachineOption extends Candidate {
  readonly family: string;
  readonly quant: string | null;
  readonly downloaded: boolean;
  readonly calibrated: boolean;
  readonly active: boolean;
  readonly measured: Measured | null;
  readonly failed: { readonly error: string; readonly at: string } | null;
  readonly recommended: boolean;
}

export interface RuntimeGroup {
  readonly engine: string;
  readonly device: Device | null;
  readonly backend: Backend | null;
  readonly pick: MachineOption;
  readonly variants: readonly MachineOption[];
}

export type MachineReason =
  | 'fastest-measured'
  | 'tie-dedicated'
  | 'tie-steadier'
  | 'tie-ladder'
  | 'only-measured'
  | 'estimated'
  | 'only-option';

export interface MachineRecommendation {
  readonly family: string;
  readonly familyLabel: string;
  readonly source: 'manual' | 'preferred' | 'default';
  readonly availability: 'ok' | 'family-unavailable';
  readonly best: MachineOption | null;
  readonly runnerUp: MachineOption | null;
  readonly ratio: number | null;
  readonly reason: MachineReason | null;
  readonly action: 'none' | 'use' | 'download' | 'install';
  readonly partial: boolean;
  readonly stale: boolean;
  readonly staleReason: string | null;
  readonly runtimes: readonly RuntimeGroup[];
  readonly fasterFamily: {
    readonly family: string;
    readonly label: string;
    readonly best: MachineOption;
    readonly ratio: number;
  } | null;
}

export interface FamilyOrder {
  readonly ranked: readonly RuntimeGroup[];
  readonly failed: readonly RuntimeGroup[];
  readonly ineligible: readonly RuntimeGroup[];
}

export function pickVariant(variants: readonly MachineOption[]): MachineOption {
  const measured = variants
    .filter((variant) => variant.eligible && variant.failed === null && rankable(variant.measured))
    .toSorted((left, right) => (left.measured?.typical.p50Ms ?? 0) - (right.measured?.typical.p50Ms ?? 0));
  if (measured[0] !== undefined) return measured[0];
  return variants.find((variant) => variant.recommended) ?? variants[0]!;
}

export function groupRuntimes(options: readonly MachineOption[]): RuntimeGroup[] {
  const groups = new Map<string, MachineOption[]>();
  for (const option of options) {
    const key = runtimeKey(option.engine, option.device);
    const variants = groups.get(key) ?? [];
    variants.push(option);
    groups.set(key, variants);
  }
  return [...groups.values()].map((variants) => runtimeGroup(variants));
}

function runtimeGroup(variants: readonly MachineOption[]): RuntimeGroup {
  const first = variants[0]!;
  return {
    engine: first.engine,
    device: first.device,
    backend: first.backend,
    pick: pickVariant(variants),
    variants,
  };
}

function runtimeKey(engine: string, device: Device | null): string {
  return `${engine}|${device ?? ''}`;
}

function orderMeasured(groups: readonly RuntimeGroup[]): RuntimeGroup[] {
  const result = [...groups];
  const slots = result.flatMap((group, index) => (rankable(group.pick.measured) ? [index] : []));
  const ordered = tournament(slots.map((index) => result[index]!));
  slots.forEach((slot, index) => {
    result[slot] = ordered[index]!;
  });
  return result;
}

export function familyOrder(options: readonly MachineOption[]): FamilyOrder {
  const groups = groupRuntimes(options);
  const eligible = groups.filter((group) => group.pick.eligible);
  const failed = eligible.filter((group) => group.pick.failed !== null);
  const ranked = orderMeasured(eligible.filter((group) => group.pick.failed === null));
  return {
    ranked,
    failed,
    ineligible: groups.filter((group) => !group.pick.eligible),
  };
}

export function beats(
  challenger: MachineOption,
  incumbent: MachineOption,
): { readonly wins: boolean; readonly reason: MachineReason } {
  const a = challenger.measured!;
  const b = incumbent.measured!;
  const pa = a.typical.p50Ms;
  const pb = b.typical.p50Ms;
  if (pa < pb * (1 - CLOSE_CALL)) return { wins: true, reason: 'fastest-measured' };
  if (pb < pa * (1 - CLOSE_CALL)) return { wins: false, reason: 'fastest-measured' };
  const aDedicated = challenger.backend === 'NPU';
  const bDedicated = incumbent.backend === 'NPU';
  if (aDedicated !== bDedicated) return { wins: aDedicated, reason: 'tie-dedicated' };
  const qa = a.typical.p95Ms;
  const qb = b.typical.p95Ms;
  if (qa < qb * (1 - CLOSE_CALL)) return { wins: true, reason: 'tie-steadier' };
  if (qb < qa * (1 - CLOSE_CALL)) return { wins: false, reason: 'tie-steadier' };
  return { wins: false, reason: 'tie-ladder' };
}

export function tournament(groups: readonly RuntimeGroup[]): RuntimeGroup[] {
  const remaining = [...groups];
  const ordered: RuntimeGroup[] = [];
  while (remaining.length > 0) {
    const champion = championOf(remaining);
    ordered.push(champion);
    remaining.splice(remaining.indexOf(champion), 1);
  }
  return ordered;
}

function championOf(groups: readonly RuntimeGroup[]): RuntimeGroup {
  let champion = groups[0]!;
  for (const challenger of groups.slice(1)) {
    if (beats(challenger.pick, champion.pick).wins) champion = challenger;
  }
  return champion;
}

function chooseBest(order: FamilyOrder): RuntimeGroup | undefined {
  const eligible = [...order.ranked, ...order.failed];
  return eligible.find((group) => group.pick.ready && group.pick.downloaded) ?? eligible[0];
}

function bringFirst(groups: readonly RuntimeGroup[], selected: RuntimeGroup | undefined): RuntimeGroup[] {
  if (selected === undefined) return [...groups];
  return [selected, ...groups.filter((group) => group !== selected)];
}

function runnerUpFor(best: RuntimeGroup | undefined, order: FamilyOrder): MachineOption | null {
  if (best === undefined) return null;
  return (
    [...order.ranked, ...order.failed]
      .filter((group) => group !== best)
      .find((group) => rankable(group.pick.measured))?.pick ?? null
  );
}

function measurementReason(
  best: MachineOption | null,
  runnerUp: MachineOption | null,
  runtimeCount: number,
): MachineReason | null {
  if (best === null) return null;
  if (runtimeCount === 1) return 'only-option';
  if (!rankable(best.measured)) return 'estimated';
  if (runnerUp === null) return 'only-measured';
  return beats(best, runnerUp).reason;
}

function actionFor(best: MachineOption | null): MachineRecommendation['action'] {
  if (best === null || best.active) return 'none';
  if (!best.ready) return 'install';
  if (!best.downloaded) return 'download';
  return 'use';
}

function staleView(options: readonly MachineOption[]): { stale: boolean; staleReason: string | null } {
  const stale = options.find((option) => option.measured?.freshness === 'stale');
  return { stale: stale !== undefined, staleReason: stale?.measured?.staleReason ?? null };
}

function familyBest(options: readonly MachineOption[]): MachineOption | null {
  const order = familyOrder(options);
  return chooseBest(order)?.pick ?? null;
}

function fasterFamily(
  best: MachineOption | null,
  allOptions: readonly MachineOption[],
): MachineRecommendation['fasterFamily'] {
  if (!hasRankableMeasurement(best)) return null;
  const families = [...new Set(allOptions.map((option) => option.family))].filter(
    (family) => family !== best.family,
  );
  const faster = families
    .map((family) => familyBest(allOptions.filter((option) => option.family === family)))
    .filter(hasRankableMeasurement)
    .toSorted((left, right) => left.measured.typical.p50Ms - right.measured.typical.p50Ms)[0];
  if (faster === undefined || faster.measured.typical.p50Ms >= best.measured.typical.p50Ms * (1 - CLOSE_CALL)) {
    return null;
  }
  return {
    family: faster.family,
    label: familyLabel(faster.family),
    best: faster,
    ratio: best.measured.typical.p50Ms / faster.measured.typical.p50Ms,
  };
}

function measurementRatio(best: MachineOption | null, runnerUp: MachineOption | null): number | null {
  if (!hasRankableMeasurement(best) || !hasRankableMeasurement(runnerUp)) return null;
  return runnerUp.measured.typical.p50Ms / best.measured.typical.p50Ms;
}

export function machineView(
  family: string,
  source: MachineRecommendation['source'],
  options: readonly MachineOption[],
  allOptions: readonly MachineOption[] = options,
): MachineRecommendation {
  const members = options.filter((option) => option.family === family);
  const order = familyOrder(members);
  const chosen = chooseBest(order);
  const runtimes = bringFirst(
    [...order.ranked, ...order.failed, ...order.ineligible],
    chosen,
  );
  const best = chosen?.pick ?? null;
  const runtimeCount = order.ranked.length + order.failed.length;
  const runnerUp = runnerUpFor(chosen, order);
  const stale = staleView(members);
  const partial =
    order.failed.length > 0 ||
    order.ranked.some(
      (group) => group.pick.ready && group.pick.downloaded && !rankable(group.pick.measured),
    );
  return {
    family,
    familyLabel: familyLabel(family),
    source,
    availability: runtimeCount === 0 ? 'family-unavailable' : 'ok',
    best,
    runnerUp,
    ratio: measurementRatio(best, runnerUp),
    reason: measurementReason(best, runnerUp, runtimeCount),
    action: actionFor(best),
    partial,
    stale: stale.stale,
    staleReason: stale.staleReason,
    runtimes,
    fasterFamily: fasterFamily(best, allOptions),
  };
}
