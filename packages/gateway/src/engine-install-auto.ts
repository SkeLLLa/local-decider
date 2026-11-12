import type { InstallFlavor } from './engine-install.ts';
import type { HostInfo } from './engines/descriptor.ts';
import type { EngineId } from './engines/registry.ts';
import type { Backend, Candidate, Ranking } from './engines/selector.ts';
import { modelFits } from './models.ts';

/** Automatic install input: the P3 ranking for this host. Absent when config is explicit. */
export interface AutoInstall {
  readonly ranking: Ranking;
}

export interface AutoTarget {
  readonly engine: 'strands-decider' | 'fastflowlm' | 'llama-vulkan';
  readonly flavor: InstallFlavor;
  readonly model: string;
  readonly reason: string;
}

const FLAVOR: Readonly<Record<Backend, InstallFlavor>> = {
  NPU: 'cpu',
  CUDA: 'cuda',
  Vulkan: 'cpu',
  MLX: 'mlx',
  // Torch wheels on macOS include MPS.
  MPS: 'cpu',
  CPU: 'cpu',
};

const isInstallable = (c: Candidate): boolean =>
  c.engine === 'strands-decider' || c.engine === 'fastflowlm' || c.engine === 'llama-vulkan';

function appleSiliconDefault(host: HostInfo, chosen: Candidate): boolean {
  return host.platform === 'darwin' && host.arch === 'arm64' && chosen.backend === 'CPU';
}

function describe(chosen: Candidate, flavor: InstallFlavor, why: string): AutoTarget {
  return {
    engine: chosen.engine as AutoTarget['engine'],
    flavor,
    model: chosen.model,
    reason: `${why} — ${chosen.engine}${chosen.backend === null ? '' : ` (${chosen.backend})`}, model ${chosen.model}`,
  };
}

/** A fresh Mac has no environment to probe, so Apple Silicon implies the mlx flavor. */
function appleFresh(host: HostInfo, chosen: Candidate): AutoTarget | undefined {
  if (!appleSiliconDefault(host, chosen) || chosen.engine !== 'strands-decider') {
    return undefined;
  }
  if (!modelFits(chosen.model, host.totalMemoryBytes, 'mlx', 'strands-decider')) {
    return undefined;
  }
  return describe(
    { ...chosen, backend: 'MLX' },
    'mlx',
    'Apple Silicon, MLX not yet confirmed (installing the mlx flavor)',
  );
}

/**
 * The install target for `want` (a CLI `--engine`) or, without one, the top eligible candidate.
 * Models that do not fit are rejected rather than substituted. Returns a refusal message when
 * nothing fits.
 */
export function autoTarget(
  auto: AutoInstall,
  host: HostInfo,
  want: string | undefined,
): AutoTarget | string {
  const pool = auto.ranking.candidates.filter(
    (c) => isInstallable(c) && (want === undefined || c.engine === want),
  );
  // An explicit `--engine` is honoured even when its accelerator is not confirmed.
  const chosen = pool.find((c) => c.eligible) ?? (want === undefined ? undefined : pool[0]);
  if (chosen === undefined) {
    return 'no installable engine fits this host';
  }
  const device = chosen.device;
  if (
    !chosen.eligible &&
    !modelFits(chosen.model, host.totalMemoryBytes, device, chosen.engine as EngineId)
  ) {
    return `${chosen.engine}: ${chosen.reason}`;
  }
  const fresh = appleFresh(host, chosen);
  if (fresh !== undefined) {
    return fresh;
  }
  return describe(chosen, FLAVOR[chosen.backend ?? 'CPU'], chosen.reason);
}
