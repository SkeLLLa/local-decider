/**
 * "Keep this model": a gateway restart reloads config.yaml, so a model chosen in settings is lost.
 * When `keepModel` is on, a periodic check switches the gateway back. Each selection is retried
 * at most once per `RETRY_MS`, so a failing switch never turns into a download loop.
 */
import { pendingSelection } from '../shared/models.ts';
import { errorText, type HookDeps } from './deps.ts';

export const KEEP_MODEL_INTERVAL_MS = 60_000;
const RETRY_MS = 10 * 60_000;

export function createModelKeeper(
  deps: Pick<HookDeps, 'gateway' | 'settings' | 'log'>,
  now: () => number = Date.now,
): () => Promise<void> {
  const attempts = new Map<string, number>();
  return async () => {
    try {
      const settings = await deps.settings();
      if (!settings.keepModel || settings.model === '') {
        return;
      }
      const gateway = await deps.gateway();
      const models = gateway === null ? null : await gateway.models({ timeoutMs: 3000 });
      if (gateway === null || models === null || typeof models !== 'object') {
        return;
      }
      const live = models as { active?: unknown; device?: unknown; switchable?: unknown };
      if (live.switchable !== true) {
        return;
      }
      const wanted = pendingSelection(settings, {
        model: typeof live.active === 'string' ? live.active : null,
        device: typeof live.device === 'string' ? live.device : null,
      });
      if (wanted === null) {
        return;
      }
      const key = `${wanted.model}|${wanted.device}`;
      const last = attempts.get(key);
      if (last !== undefined && now() - last < RETRY_MS) {
        return;
      }
      attempts.set(key, now());
      const res = await gateway.selectEngine(wanted, { timeoutMs: 15_000 });
      deps.log(`restored model ${wanted.model}: ${res.ok ? 'accepted' : res.error}`);
    } catch (error) {
      deps.log(`model check failed: ${errorText(error)}`);
    }
  };
}
