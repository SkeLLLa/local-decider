import { parsePolicy, type Mode, type Policy } from '@local-decider/core';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GatewayConfig } from './config.ts';
import type { Paths } from './paths.ts';

/** Default policies: `policies/` next to `dist/` when installed, the repo root in development. */
export function defaultPolicyDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '..', 'policies'), join(here, '..', '..', '..', 'policies')];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0] ?? 'policies';
}

/** Defaults, configured dirs, then `<config>/policies`, read even when created after start. */
export function policyDirs(config: GatewayConfig, paths: Paths): string[] {
  return [...new Set([defaultPolicyDir(), ...config.policyDirs, join(paths.config, 'policies')])];
}

export interface LoadedPolicy {
  readonly policy: Policy;
  readonly mode: Mode;
  readonly source: string;
}

function readDir(dir: string): { file: string; policy: Policy }[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .toSorted()
    .map((name) => {
      const file = join(dir, name);
      return { file, policy: parsePolicy(readFileSync(file, 'utf8'), file) };
    });
}

/** Load defaults then each configured dir; a later policy with the same id replaces earlier. */
export function loadPolicies(
  config: GatewayConfig,
  dirs?: readonly string[],
): Map<string, LoadedPolicy> {
  const out = new Map<string, LoadedPolicy>();
  for (const dir of dirs ?? [defaultPolicyDir(), ...config.policyDirs]) {
    for (const { file, policy } of readDir(dir)) {
      const mode = config.policies[policy.id]?.mode ?? policy.mode;
      out.set(policy.id, { policy, mode, source: file });
    }
  }
  return out;
}
