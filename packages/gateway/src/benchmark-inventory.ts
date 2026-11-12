/**
 * The `BenchmarkInventory` a benchmark job resolves its targets from, built from the data the
 * engines view and the ranking already use.
 */
import type { BenchmarkInventory, InventoryEngine, InventoryModel } from './benchmark-job.ts';
import type { ModelDescriptor } from './engines/descriptor.ts';
import { familyId } from './engines/families.ts';
import { rankable, type Measurements } from './engines/ranking.ts';
import { ladderIndex, type Candidate } from './engines/selector.ts';

const STRANDS = 'strands-decider';

export interface InventorySources {
  /** Selectable engines, as the engines view reports them. */
  readonly engines: readonly Omit<InventoryEngine, 'selectable'>[];
  /** The catalogue, including models discovered on custom servers. */
  readonly models: readonly ModelDescriptor[];
  /** Model id → downloaded. */
  readonly installed: ReadonlyMap<string, boolean>;
  readonly fits: (model: ModelDescriptor) => boolean;
  /** The ranking's candidates: which strands rungs may run here. */
  readonly candidates: readonly Candidate[];
  readonly current: BenchmarkInventory['current'];
  readonly preferredFamily: string | null;
  readonly measurements: Measurements;
}

/** Recommended variants first, then catalogue order, within each engine. */
function recommendedOrders(models: readonly ModelDescriptor[]): Map<ModelDescriptor, number> {
  const seen = new Map<string, number>();
  const orders = new Map<ModelDescriptor, number>();
  for (const m of models) {
    const index = seen.get(m.engine) ?? 0;
    seen.set(m.engine, index + 1);
    orders.set(m, (m.recommended === true ? 0 : 1000) + index);
  }
  return orders;
}

function inventoryModel(
  m: ModelDescriptor,
  sources: InventorySources,
  orders: ReadonlyMap<ModelDescriptor, number>,
): InventoryModel {
  return {
    engine: m.engine,
    id: m.id,
    family: familyId(m),
    downloaded: sources.installed.get(m.id) ?? false,
    fits: sources.fits(m),
    recommendedOrder: orders.get(m) ?? 0,
    quant: m.quant ?? null,
  };
}

function strandsDevices(candidates: readonly Candidate[]): string[] {
  const devices = candidates
    .filter((c) => c.engine === STRANDS && c.eligible && c.ready && c.device !== null)
    .map((c) => c.device as string);
  return [...new Set(devices)];
}

export function buildInventory(sources: InventorySources): BenchmarkInventory {
  const orders = recommendedOrders(sources.models);
  const engines = sources.engines
    .map((e) => ({ ...e, selectable: true }))
    .toSorted((a, b) => ladderIndex(a.id, null) - ladderIndex(b.id, null));
  return {
    engines,
    models: sources.models.map((m) => inventoryModel(m, sources, orders)),
    strandsDevices: strandsDevices(sources.candidates),
    current: sources.current,
    preferredFamily: sources.preferredFamily,
    ladderIndex,
    rankable: (engine, model, device) =>
      rankable(sources.measurements.get(`${engine}|${model}|${device ?? ''}`)?.ok ?? null),
  };
}
