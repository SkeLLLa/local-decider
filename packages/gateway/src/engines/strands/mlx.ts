import { readdirSync } from 'node:fs';
import { join } from 'node:path';

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
export function resolveDevice(device: Device, host?: HostInfo, venv?: string): Device | undefined {
  if (device !== 'auto') {
    return device;
  }
  if (host?.platform !== 'darwin' || host.arch !== 'arm64' || venv === undefined) {
    return undefined;
  }
  return venvHasMlx(venv) ? 'mlx' : undefined;
}
