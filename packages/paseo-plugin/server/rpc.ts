/**
 * Daemon-side RPC handlers: status, stats, feedback and `/decide`. Engines: engines.ts.
 * Permission labels: labels.ts.
 */
import type { GatewayHealth } from '../shared/decision.ts';
import { parseProgress } from '../shared/machine.ts';
import { manualInput } from '../shared/manual.ts';
import { toRowData, type DecisionRow } from '../shared/row.ts';
import { parsePolicyStats, type PolicyStats } from '../shared/stats.ts';
import type { HookDeps, PaseoLike } from './deps.ts';
import { appendRow } from './timeline.ts';

const STATUS_TIMEOUT_MS = 1500;
const STATS_MAX_CHARS = 20_000;

export interface StatusResult {
  up: boolean;
  status: GatewayHealth['status'];
  engine: string | null;
  engineTag: string | null;
  engineState: string | null;
  detail: string | null;
  model: string | null;
  p50Ms: number | null;
  benchmark: { completed: number; total: number } | null;
  gatewayUrl: string;
  downStreak: number;
  checkedAt: string;
}

type HealthFields = Pick<
  StatusResult,
  'status' | 'engine' | 'engineTag' | 'engineState' | 'detail' | 'model' | 'p50Ms' | 'benchmark'
>;

function clip(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function healthFields(health: GatewayHealth | null): HealthFields {
  return {
    status: health?.status ?? 'down',
    engine: health?.engine ?? null,
    engineTag: clip(health?.engineTag, 40),
    engineState: health?.engineState ?? null,
    detail: clip(health?.detail, 300),
    model: health?.model ?? null,
    p50Ms: typeof health?.p50Ms === 'number' ? health.p50Ms : null,
    benchmark: parseProgress(health?.benchmark),
  };
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
      ...healthFields(health),
      gatewayUrl: gateway?.baseUrl ?? (await deps.settings()).gatewayUrl,
      downStreak,
      checkedAt: now().toISOString(),
    };
  };
}

export async function statsText(
  deps: Pick<HookDeps, 'gateway'>,
): Promise<{ ok: boolean; text: string; policies: PolicyStats[] }> {
  const gateway = await deps.gateway();
  const body = gateway === null ? null : await gateway.stats({ timeoutMs: 5000 });
  if (body === null) {
    return {
      ok: false,
      text: 'The gateway is unreachable or has no /v1/stats. Try `local-decider stats`.',
      policies: [],
    };
  }
  const text = JSON.stringify(body, null, 2) ?? '';
  return {
    ok: true,
    text: text.length > STATS_MAX_CHARS ? `${text.slice(0, STATS_MAX_CHARS)}\n…` : text,
    policies: parsePolicyStats(body),
  };
}

/**
 * The user says `outcome` was the right answer: report it as a `user` outcome (ground truth for
 * `local-decider stats`) and redraw the row with the feedback. Throws so the client can toast.
 */
export async function recordFeedback(
  deps: Pick<HookDeps, 'gateway'>,
  paseo: PaseoLike,
  input: { agentId: string; row: DecisionRow; outcome: string },
): Promise<DecisionRow> {
  const { row, outcome } = input;
  if (row.source === 'permission') {
    // Accept/Deny on the prompt is the outcome; a second, possibly contradicting one would win.
    throw new Error('Permission rows take your Accept or Decline; label a decline with the chips.');
  }
  if (!row.options.includes(outcome)) {
    throw new Error(`"${outcome}" is not an option of this decision.`);
  }
  const gateway = await deps.gateway();
  const reported =
    gateway !== null && (await gateway.reportOutcome(row.decisionId, outcome, 'user'));
  if (!reported) {
    throw new Error('local-decider: the gateway did not record the feedback (is it running?).');
  }
  const next: DecisionRow = { ...row, feedback: outcome };
  if (row.rowId !== '') {
    await appendRow(paseo.agents.ref(input.agentId), next);
  }
  return next;
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
  const row = toRowData(res, {
    source: 'manual',
    key: res.decisionId,
    enforced: false,
    note: 'via /decide',
  });
  if (input.agentId !== null) {
    await appendRow(paseo.agents.ref(input.agentId), row);
  }
  return row;
}
