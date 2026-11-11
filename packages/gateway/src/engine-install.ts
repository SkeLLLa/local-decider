import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Paths } from './paths.ts';

export type InstallFlavor = 'cpu' | 'mlx' | 'cuda';

export function defaultFlavor(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): InstallFlavor {
  return platform === 'darwin' && arch === 'arm64' ? 'mlx' : 'cpu';
}

/** The pinned uv project shipped with the gateway (`engines/strands-decider`). */
function engineProjectDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'engines', 'strands-decider');
}

/**
 * `uv sync` the pinned project into ~/.local/share/local-decider/venvs/strands-decider, then
 * pre-download the adapter and base weights into the Hugging Face cache.
 */
export function installStrandsEngine(
  paths: Paths,
  flavor: InstallFlavor,
  model: string | undefined,
): void {
  const project = engineProjectDir();
  if (!existsSync(join(project, 'pyproject.toml'))) {
    throw new Error(`engine project not found at ${project}`);
  }
  const venv = join(paths.venvs, 'strands-decider');
  execFileSync('uv', ['sync', '--project', project, '--frozen', '--extra', flavor], {
    stdio: 'inherit',
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: venv },
  });
  if (model !== undefined) {
    const hf = join(venv, 'bin', 'hf');
    execFileSync(hf, ['download', model], { stdio: 'inherit' });
    const info = execFileSync(join(venv, 'bin', 'python'), ['-I', '-c', BASE_MODEL_SCRIPT, model], {
      encoding: 'utf8',
    }).trim();
    if (info !== '') {
      execFileSync(hf, ['download', info], { stdio: 'inherit' });
    }
  }
}

/** Reads `base_model` from the adapter's config in the HF cache; prints nothing if absent. */
const BASE_MODEL_SCRIPT = `
import json, sys
from huggingface_hub import hf_hub_download
try:
    cfg = json.load(open(hf_hub_download(sys.argv[1], "strands_decider_config.json")))
    print(cfg.get("base_model", ""))
except Exception:
    pass
`;
