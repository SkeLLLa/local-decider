/**
 * Optional preload (Settings → "Load the model when Paseo starts", off by default): when the
 * plugin starts with Paseo, ask the gateway to load its engine once, so the first decision
 * doesn't pay the model load (~5 s on FastFlowLM, longer for Strands on CPU). With the lazy
 * lifecycle the model still unloads after the idle timeout, so this only moves the load earlier.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type { HookDeps } from './deps.ts';

/** The gateway may start after Paseo; keep looking for it this long. */
const WAIT_MS = 120_000;
const POLL_MS = 5_000;

export type PreloadResult =
  | 'disabled'
  | 'loaded'
  | 'already-loaded'
  | 'gateway-unreachable'
  | 'failed';

/** One attempt: undefined while the gateway is unreachable, else the final result. */
async function tryLoad(deps: HookDeps): Promise<PreloadResult | undefined> {
  const gateway = await deps.gateway();
  const health = gateway === null ? null : await gateway.health();
  if (gateway === null || health === null) {
    return undefined;
  }
  if (health.engineState === 'ready' || health.engineState === 'starting') {
    return 'already-loaded';
  }
  const res = await gateway.engineLoad('load', { timeoutMs: 15_000 });
  deps.log(`preload: ${res.ok ? 'engine loading' : `failed: ${res.error ?? 'unknown'}`}`);
  return res.ok ? 'loaded' : 'failed';
}

export async function preloadOnStart(
  deps: HookDeps,
  signal: AbortSignal,
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<PreloadResult> {
  if (!(await deps.settings()).preloadOnStart) {
    return 'disabled';
  }
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  while (!signal.aborted && Date.now() < deadline) {
    const result = await tryLoad(deps);
    if (result !== undefined) {
      return result;
    }
    await sleep(options.pollMs ?? POLL_MS, undefined, { signal }).catch(() => undefined);
  }
  if (!signal.aborted) {
    deps.log('preload: gateway not reachable; the model loads on the first decision instead');
  }
  return 'gateway-unreachable';
}
