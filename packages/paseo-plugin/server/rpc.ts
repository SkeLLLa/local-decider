/** Daemon-side RPC handlers: status, stats, gateway models and manual `/decide`. */
import { ROW_KIND, ROW_VERSION } from '../shared/constants.ts';
import type { GatewayHealth } from '../shared/decision.ts';
import { manualInput } from '../shared/manual.ts';
import { gatewayModelIds } from '../shared/presets.ts';
import { rowId, toRowData, type DecisionRow } from '../shared/row.ts';
import type { HookDeps, PaseoLike } from './deps.ts';

const STATUS_TIMEOUT_MS = 1500;
const STATS_MAX_CHARS = 20_000;

export interface StatusResult {
  up: boolean;
  status: GatewayHealth['status'];
  engine: string | null;
  model: string | null;
  p50Ms: number | null;
  gatewayUrl: string;
  downStreak: number;
  checkedAt: string;
}

export function createStatusHandler(
  deps: Pick<HookDeps, 'gateway' | 'settings'>,
  now: () => Date = () => new Date(),
  onResult: (up: boolean) => void = () => {},
): () => Promise<StatusResult> {
  let downStreak = 0;
  return async () => {
    const gateway = await deps.gateway();
    const health = gateway === null ? null : await gateway.health({ timeoutMs: STATUS_TIMEOUT_MS });
    const up = health !== null && health.status !== 'down';
    downStreak = up ? 0 : downStreak + 1;
    onResult(up);
    return {
      up,
      status: health?.status ?? 'down',
      engine: health?.engine ?? null,
      model: health?.model ?? null,
      p50Ms: typeof health?.p50Ms === 'number' ? health.p50Ms : null,
      gatewayUrl: gateway?.baseUrl ?? (await deps.settings()).gatewayUrl,
      downStreak,
      checkedAt: now().toISOString(),
    };
  };
}

export async function statsText(
  deps: Pick<HookDeps, 'gateway'>,
): Promise<{ ok: boolean; text: string }> {
  const gateway = await deps.gateway();
  const body = gateway === null ? null : await gateway.stats({ timeoutMs: 5000 });
  if (body === null) {
    return {
      ok: false,
      text: 'The gateway is unreachable or has no /v1/stats. Try `local-decider stats`.',
    };
  }
  const text = JSON.stringify(body, null, 2) ?? '';
  return {
    ok: true,
    text: text.length > STATS_MAX_CHARS ? `${text.slice(0, STATS_MAX_CHARS)}\n…` : text,
  };
}

export async function gatewayModels(
  deps: Pick<HookDeps, 'gateway'>,
): Promise<{ models: string[] }> {
  const gateway = await deps.gateway();
  const body = gateway === null ? null : await gateway.models({ timeoutMs: 3000 });
  return { models: gatewayModelIds(body) };
}

/** Throws on failure: Paseo shows a slash command's rejection as an error toast. */
export async function manualDecide(
  deps: Pick<HookDeps, 'gateway'>,
  paseo: PaseoLike,
  input: { policy: string; text: string; agentId: string | null },
): Promise<DecisionRow> {
  const gateway = await deps.gateway();
  if (gateway === null) {
    throw new Error('The local-decider gateway URL in settings is not a valid http(s) URL.');
  }
  const res = await gateway.decide(
    input.policy,
    {
      harness: 'paseo',
      ...(input.agentId === null ? {} : { sessionId: input.agentId }),
      input: manualInput(input.policy, input.text),
    },
    { timeoutMs: 25_000 },
  );
  if (res === null) {
    throw new Error(
      `local-decider: no decision for "${input.policy}" (gateway down, slow, or unknown policy).`,
    );
  }
  // A manual check never changes anything, so it is never enforced.
  const row = toRowData(res, { source: 'manual', enforced: false, note: 'via /decide' });
  if (input.agentId !== null) {
    await paseo.agents.ref(input.agentId).timeline.append({
      type: 'plugin',
      id: rowId('manual', res.decisionId),
      kind: ROW_KIND,
      version: ROW_VERSION,
      data: { ...row },
    });
  }
  return row;
}
