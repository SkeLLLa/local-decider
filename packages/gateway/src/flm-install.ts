import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FLM_DIR } from './engines/fastflowlm/server.ts';
import type { Paths } from './paths.ts';

/** The FastFlowLM release this gateway is tested against (`/v1/systemone` with d3 models). */
export const FLM_VERSION = '1.0.12';
const REPO = 'FastFlowLM/FastFlowLM';

/**
 * SHA-256 of each supported release archive, pinned here rather than taken from the GitHub API, so
 * a replaced release asset is refused. Add the digest from the release page when bumping
 * `FLM_VERSION`.
 */
const FLM_SHA256: Readonly<Record<string, string>> = {
  '1.0.12': 'sha256:626fbee5e5206a215a8c2c4d3d961055cbf7289d257d36599e9fef38f2f555a8',
};

interface Asset {
  readonly name: string;
  readonly browser_download_url: string;
}

function flmAssetName(version: string): string {
  return `fastflowlm_${version}_linux.tar.gz`;
}

async function releaseAsset(version: string): Promise<Asset> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub release v${version}: HTTP ${String(res.status)}`);
  }
  const release = (await res.json()) as { assets?: Asset[] };
  const asset = release.assets?.find((a) => a.name === flmAssetName(version));
  if (asset === undefined) {
    throw new Error(`release v${version} has no ${flmAssetName(version)}`);
  }
  return asset;
}

/**
 * Install the upstream portable FastFlowLM build (Linux, AMD XDNA NPU) into
 * `engines/fastflowlm/<version>/dist`, verified against the SHA-256 pinned in `FLM_SHA256`. The
 * archive is unpacked into a fresh directory and only then moved into place.
 */
export async function installFlm(paths: Paths, version: string = FLM_VERSION): Promise<string> {
  if (process.platform !== 'linux') {
    throw new Error('the FastFlowLM portable build is Linux-only (Windows: use the FLM installer)');
  }
  const root = join(paths.engines, FLM_DIR, version);
  const dist = join(root, 'dist');
  const launcher = join(dist, 'flm');
  if (existsSync(launcher)) {
    return launcher;
  }
  const expected = FLM_SHA256[version];
  if (expected === undefined) {
    throw new Error(`no pinned checksum for FastFlowLM ${version}; refusing to install it`);
  }
  const asset = await releaseAsset(version);
  const res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) {
    throw new Error(`download ${asset.name}: HTTP ${String(res.status)}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}`);
  }
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, 'staging-'));
  try {
    const archive = join(staging, 'flm.tar.gz');
    writeFileSync(archive, bytes);
    const out = join(staging, 'dist');
    mkdirSync(out);
    execFileSync('tar', ['-xzf', archive, '-C', out, '--no-same-owner'], { stdio: 'inherit' });
    if (!existsSync(join(out, 'flm'))) {
      throw new Error(`${asset.name} has no flm launcher`);
    }
    renameSync(out, dist);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return launcher;
}
