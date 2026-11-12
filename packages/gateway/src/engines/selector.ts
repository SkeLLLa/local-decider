import { modelFits } from '../models.ts';
import type { Device, EngineDescriptor, HostInfo, ModelDescriptor } from './descriptor.ts';
import type { CapabilityResult, HostCapabilities } from './host-capabilities.ts';
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
  input: SelectorInput,
): Candidate | undefined {
  const model = engine === undefined ? undefined : recommendedModel(engine);
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
  const ladder = LADDER.flatMap((rung) => rungCandidate(rung, byId.get(rung.engine), input) ?? []);
  const extra = input.engines.flatMap((e) => uncalibrated(e, input.installed) ?? []);
  const candidates = [
    ...ladder.filter((c) => c.eligible),
    ...ladder.filter((c) => !c.eligible),
    ...extra,
  ];
  const first = candidates.find((c) => c.eligible);
  const automatic = first === undefined ? null : target(first);
  const { explicit } = input;
  const recommended =
    explicit === null ? automatic : { ...explicit, reason: 'explicit selection', explicit: true };
  return { candidates, recommended, automatic };
}
