import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Device, HostInfo } from '../descriptor.ts';

function pythonVersions(venv: string): string[] {
  try {
    return readdirSync(join(venv, 'lib'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^python3\.\d+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Checks the managed venv without starting Python. */
function venvHasMlx(venv: string): boolean {
  return pythonVersions(venv).some((version) => {
    try {
      return readdirSync(join(venv, 'lib', version, 'site-packages'), {
        withFileTypes: true,
      }).some((entry) => entry.name === 'mlx_lm' && entry.isDirectory());
    } catch {
      return false;
    }
  });
}

/** `auto` prefers MLX only for Apple Silicon venvs that contain mlx_lm. */
function resolveDevice(device: Device, host?: HostInfo, venv?: string): Device | undefined {
  if (device !== 'auto') {
    return device;
  }
  if (host?.platform !== 'darwin' || host.arch !== 'arm64' || venv === undefined) {
    return undefined;
  }
  return venvHasMlx(venv) ? 'mlx' : undefined;
}

/** Backend tag per concrete device. */
const BACKENDS: Readonly<Record<Exclude<Device, 'auto'>, string>> = {
  mlx: 'MLX',
  mps: 'MPS',
  cuda: 'CUDA',
  cpu: 'CPU',
};

export interface DeviceResolution {
  readonly requested: Device;
  /** Undefined when `auto` has no cheap evidence; the child then picks and reports its own. */
  readonly resolved: Exclude<Device, 'auto'> | undefined;
  /** `MLX`, `MPS`, `CUDA` or `CPU`; undefined while the backend is unknown. */
  readonly backend: string | undefined;
}

/** The venv an executable lives in: `<venv>/bin/<name>`, following symlinks. */
function venvOfExecutable(binary: string): string {
  let real = binary;
  try {
    real = realpathSync(binary);
  } catch {
    // Not installed yet: the lexical location is still the venv it would live in.
  }
  return dirname(dirname(real));
}

/** Resolves `device` once, from the venv that `binary` belongs to. Explicit devices win. */
export function resolveStrandsDevice(
  device: Device,
  host: HostInfo | undefined,
  binary: string | undefined,
): DeviceResolution {
  const resolved = resolveDevice(
    device,
    host,
    binary === undefined ? undefined : venvOfExecutable(binary),
  );
  const concrete = resolved === undefined || resolved === 'auto' ? undefined : resolved;
  return {
    requested: device,
    resolved: concrete,
    backend: concrete === undefined ? undefined : BACKENDS[concrete],
  };
}
