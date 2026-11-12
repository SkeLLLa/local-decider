import { modelFits } from '../models.ts';
import type { Device, EngineDescriptor, HostInfo, ModelDescriptor } from './descriptor.ts';
import { familyId, familyOf, isKnownFamily } from './families.ts';
import type { CapabilityResult, HostCapabilities } from './host-capabilities.ts';
import {
  familyOrder,
  machineView,
  type MachineOption,
  type MachineRecommendation,
  type Measured,
  type Measurements,
  type MeasurementView,
} from './ranking.ts';
import type { EngineId } from './registry.ts';

export type Backend = 'NPU' | 'CUDA' | 'Vulkan' | 'MLX' | 'MPS' | 'CPU';

/** The slice of an engine descriptor the selector reads. */
export type SelectorEngine = Pick<
  EngineDescriptor<{ type: string; model: string }>,
  'id' | 'selectable' | 'calibrated' | 'supports' | 'models'
>;

/** Why a candidate is or is not eligible, stable for clients (the `reason` is English prose). */
export type CandidateCode =
  | 'available'
  | 'no-hardware'
  | 'not-confirmed'
  | 'unsupported-platform'
  | 'no-memory'
  | 'not-installed'
  | 'uncalibrated';

export interface Candidate {
  readonly engine: string;
  /** Strands device; null for engines without one. */
  readonly device: Device | null;
  readonly backend: Backend | null;
  readonly model: string;
  /** May be chosen automatically. */
  readonly eligible: boolean;
  /** False when the engine can never run on this host (e.g. FastFlowLM off Linux). */
  readonly supported: boolean;
  /** The engine is installed; false means it would need installing first. */
  readonly ready: boolean;
  readonly reason: string;
  readonly code: CandidateCode;
}

export interface Target {
  readonly engine: string;
  readonly device: Device | null;
  readonly model: string;
  readonly reason: string;
  readonly explicit: boolean;
}

export interface Ranking {
  /** Eligible candidates in ladder order, then ineligible ones. */
  readonly candidates: readonly Candidate[];
  /** The explicit selection when set, otherwise `automatic`. */
  readonly recommended: Target | null;
  /** What automatic selection would pick; null when nothing is eligible. */
  readonly automatic: Target | null;
  readonly machine: MachineRecommendation | null;
}

export interface SelectorInput {
  readonly host: HostInfo;
  readonly capabilities: HostCapabilities | undefined;
  readonly engines: readonly SelectorEngine[];
  /** Engine ids that are installed. */
  readonly installed: ReadonlySet<string>;
  readonly explicit: {
    readonly engine: string;
    readonly model: string;
    readonly device: Device | null;
  } | null;
  readonly measurements?: Measurements;
  /** `${engine}|${model}` → downloaded. */
  readonly present?: ReadonlyMap<string, boolean>;
  readonly preferredFamily?: string | null;
  readonly active?: {
    readonly engine: string;
    readonly model: string;
    readonly device: Device | null;
    readonly resolvedDevice: string | null;
  } | null;
}

interface Rung {
  readonly engine: string;
  readonly device: Device | null;
  readonly backend: Backend;
  /** Capability that must be `available`; undefined means always. */
  readonly needs?: (caps: HostCapabilities) => CapabilityResult;
  readonly label: string;
}

const LADDER: readonly Rung[] = [
  { engine: 'fastflowlm', device: null, backend: 'NPU', needs: (c) => c.npu, label: 'AMD NPU' },
  {
    engine: 'strands-decider',
    device: 'cuda',
    backend: 'CUDA',
    needs: (c) => c.nvidia,
    label: 'NVIDIA GPU',
  },
  {
    engine: 'llama-vulkan',
    device: null,
    backend: 'Vulkan',
    needs: (c) => c.vulkan,
    label: 'Vulkan GPU',
  },
  {
    engine: 'strands-decider',
    device: 'mlx',
    backend: 'MLX',
    needs: appleVariant('mlx'),
    label: 'MLX/Metal',
  },
  {
    engine: 'strands-decider',
    device: 'mps',
    backend: 'MPS',
    needs: appleVariant('mps'),
    label: 'PyTorch MPS',
  },
  { engine: 'strands-decider', device: 'cpu', backend: 'CPU', label: 'CPU' },
];

/** Where `(engine, device)` sits on the ladder (lower is tried first); engines off it sort last. */
export function ladderIndex(engine: string, device: string | null): number {
  const exact = LADDER.findIndex((rung) => rung.engine === engine && rung.device === device);
  const any = LADDER.findIndex((rung) => rung.engine === engine);
  return exact >= 0 ? exact : any >= 0 ? any : LADDER.length;
}

function appleVariant(want: 'mlx' | 'mps'): (c: HostCapabilities) => CapabilityResult {
  return (c) => {
    const confirmed = c.apple.variant === want || (want === 'mps' && c.apple.mps === true);
    if (c.apple.status !== 'available' || c.apple.variant === want) {
      return c.apple;
    }
    // MPS confirmed next to MLX: report MPS's own evidence, not MLX's.
    return confirmed
      ? { status: 'available', evidence: 'PyTorch MPS', variant: 'mps', mps: true }
      : { status: 'unknown', evidence: `${want.toUpperCase()} not confirmed` };
  };
}

/** The model we recommend for an engine: the catalogue's `recommended` entry. */
function recommendedModel(engine: SelectorEngine): ModelDescriptor | undefined {
  return engine.models.find((m) => m.recommended === true);
}

interface Verdict {
  readonly ok: boolean;
  readonly reason: string;
  readonly code: CandidateCode;
}

function verdict(rung: Rung, caps: HostCapabilities | undefined): Verdict {
  if (rung.needs === undefined) {
    return { ok: true, reason: 'always available', code: 'available' };
  }
  const result = caps === undefined ? undefined : rung.needs(caps);
  if (result?.status === 'available') {
    return { ok: true, reason: `${rung.label}: ${result.evidence}`, code: 'available' };
  }
  const state = result?.status ?? 'unknown';
  return {
    ok: false,
    reason: `${rung.label} ${state === 'unknown' ? 'not confirmed' : 'not present'}`,
    code: state === 'unknown' ? 'not-confirmed' : 'no-hardware',
  };
}

function rungCandidate(
  rung: Rung,
  engine: SelectorEngine | undefined,
  model: ModelDescriptor | undefined,
  input: SelectorInput,
): Candidate | undefined {
  if (engine === undefined || model === undefined) {
    return undefined;
  }
  const base = {
    engine: rung.engine,
    device: rung.device,
    backend: rung.backend,
    model: model.id,
    ready: input.installed.has(rung.engine),
  };
  const support = engine.supports(input.host);
  if (!support.ok) {
    return {
      ...base,
      eligible: false,
      supported: false,
      reason: support.reason,
      code: 'unsupported-platform',
    };
  }
  if (!modelFits(model.id, input.host.totalMemoryBytes, rung.device, rung.engine as EngineId)) {
    return {
      ...base,
      eligible: false,
      supported: true,
      reason: `${model.id} does not fit in memory`,
      code: 'no-memory',
    };
  }
  if (rung.engine === 'llama-vulkan' && !base.ready) {
    return {
      ...base,
      eligible: false,
      supported: true,
      reason: 'llama-server binary or URL is not available',
      code: 'not-installed',
    };
  }
  const { ok, reason, code } = verdict(rung, input.capabilities);
  return { ...base, eligible: ok, supported: true, reason, code };
}

function uncalibrated(
  engine: SelectorEngine,
  installed: ReadonlySet<string>,
): Candidate | undefined {
  const model = recommendedModel(engine) ?? engine.models[0];
  if (!engine.selectable || engine.calibrated) {
    return undefined;
  }
  return {
    engine: engine.id,
    device: null,
    backend: null,
    model: model?.id ?? '',
    eligible: false,
    supported: true,
    ready: installed.has(engine.id),
    reason: 'uncalibrated: explicit choice only',
    code: 'uncalibrated',
  };
}

function target(candidate: Candidate): Target {
  return {
    engine: candidate.engine,
    device: candidate.device,
    model: candidate.model,
    reason: candidate.reason,
    explicit: false,
  };
}

/** Pure: ranks engine/device/model candidates for a host. Never changes any selection. */
export function rankEngines(input: SelectorInput): Ranking {
  const byId = new Map(input.engines.map((e) => [e.id, e]));
  const ladder = LADDER.flatMap((rung) => {
    const engine = byId.get(rung.engine);
    return (
      rungCandidate(
        rung,
        engine,
        engine === undefined ? undefined : recommendedModel(engine),
        input,
      ) ?? []
    );
  });
  const allOptions = allFamilyOptions(input, byId);
  const defaultPick = ladder.find((candidate) => candidate.eligible);
  const defaultFamily =
    defaultPick === undefined ? null : familyOf(defaultPick.model, defaultPick.engine);
  const preferredFamily =
    input.preferredFamily !== undefined &&
    input.preferredFamily !== null &&
    isKnownFamily(input.preferredFamily)
      ? input.preferredFamily
      : null;
  const manualFamily =
    input.explicit === null ? null : familyOf(input.explicit.model, input.explicit.engine);
  const autoFamily = preferredFamily ?? defaultFamily;
  const machineFamily = input.explicit === null ? autoFamily : manualFamily;
  const source =
    input.explicit !== null ? 'manual' : preferredFamily !== null ? 'preferred' : 'default';
  const members =
    autoFamily === null ? [] : allOptions.filter((option) => option.family === autoFamily);
  const ordered = familyOrder(members);
  const rankedPicks = ordered.ranked.map((group) => group.pick);
  const rankedAlternates = ordered.ranked.flatMap((group) =>
    group.variants.filter((variant) => variant !== group.pick),
  );
  const failedPicks = ordered.failed.map((group) => group.pick);
  const familyKeys = new Set(members.map(candidateKey));
  const rest = ladder.filter((candidate) => !familyKeys.has(candidateKey(candidate)));
  const autoOptions = [...rankedPicks, ...rankedAlternates, ...failedPicks];
  const candidates = [
    ...autoOptions,
    ...rest.filter((candidate) => candidate.eligible),
    ...ordered.ineligible.map((group) => group.pick),
    ...rest.filter((candidate) => !candidate.eligible),
  ];
  const extra = input.engines.flatMap((e) => uncalibrated(e, input.installed) ?? []);
  candidates.push(...extra);
  const first = candidates.find((c) => c.eligible);
  const automatic = first === undefined ? null : target(first);
  const { explicit } = input;
  const recommended =
    explicit === null ? automatic : { ...explicit, reason: 'explicit selection', explicit: true };
  return {
    candidates,
    recommended,
    automatic,
    machine:
      machineFamily === null ? null : machineView(machineFamily, source, allOptions, allOptions),
  };
}

function candidateKey(candidate: Pick<Candidate, 'engine' | 'model' | 'device'>): string {
  return `${candidate.engine}|${candidate.model}|${candidate.device ?? ''}`;
}

function measuredOption(view: MeasurementView | undefined): {
  measured: Measured | null;
  failed: MeasurementView['failed'];
} {
  return { measured: view?.ok ?? null, failed: view?.failed ?? null };
}

function makeMachineOption(
  rung: Rung,
  engine: SelectorEngine,
  model: ModelDescriptor,
  input: SelectorInput,
): MachineOption | undefined {
  const candidate = rungCandidate(rung, engine, model, input);
  if (candidate === undefined) return undefined;
  const active = input.active;
  const activeDevice =
    active?.device === rung.device ||
    (active?.device === 'auto' && active.resolvedDevice === rung.device);
  const measurement = measuredOption(
    input.measurements?.get(`${rung.engine}|${model.id}|${rung.device ?? ''}`),
  );
  return {
    ...candidate,
    family: familyId(model),
    quant: model.quant ?? null,
    downloaded: input.present?.get(`${rung.engine}|${model.id}`) ?? false,
    calibrated: engine.calibrated,
    active: active?.engine === rung.engine && active.model === model.id && activeDevice,
    measured: measurement.measured,
    failed: measurement.failed,
    recommended: model.recommended === true,
  };
}

function allFamilyOptions(
  input: SelectorInput,
  engines: ReadonlyMap<string, SelectorEngine>,
): MachineOption[] {
  return LADDER.flatMap((rung) => {
    const engine = engines.get(rung.engine);
    if (engine === undefined) return [];
    return engine.models.flatMap((model) => makeMachineOption(rung, engine, model, input) ?? []);
  });
}
