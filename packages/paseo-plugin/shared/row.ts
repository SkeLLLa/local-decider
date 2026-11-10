/** The plugin's timeline row: one compact decision, drawn by `client/decision-row.tsx`. */
import { z } from 'zod';

import { MCP_SERVER_NAME, type RowVisibility } from './constants.ts';
import type { Answer, DecideResponse, Mode } from './decision.ts';
import { shortModel } from './models.ts';

const MAX_OPTIONS = 12;
/** Below this confidence a shadow row counts as notable. */
const LOW_CONFIDENCE = 0.7;

export const decisionRowSchema = z.object({
  decisionId: z.string(),
  policy: z.string(),
  source: z.enum(['turn', 'permission', 'manual']),
  /** Primary answer and its confidence, if the engine answered. */
  question: z.string(),
  answer: z.string(),
  confidence: z.number(),
  action: z.string(),
  gatewayMode: z.enum(['off', 'shadow', 'act']),
  /** Gateway said enforced AND the plugin's own mode for this policy is `act`. */
  enforced: z.boolean(),
  /** The plugin changed something (e.g. allowed the permission). */
  applied: z.boolean(),
  /** Enforced `notify`: surface it. */
  attention: z.boolean(),
  engine: z.string(),
  model: z.string(),
  latencyMs: z.number(),
  cached: z.boolean(),
  error: z.string().nullable(),
  note: z.string().nullable(),
  /** The row's own timeline id, so feedback can replace it. '' on rows from older versions. */
  rowId: z.string().max(200).default(''),
  /** Options of the primary question, offered as feedback. */
  options: z.array(z.string().max(100)).max(MAX_OPTIONS).default([]),
  /** The answer the user reported as right. */
  feedback: z.string().max(100).nullable().default(null),
});

export type DecisionRow = z.output<typeof decisionRowSchema>;

/** The policy's first question in policy order, which is the one the rules key on. */
function primaryAnswer(res: DecideResponse): [string, Answer] | null {
  const first = Object.entries(res.answers)[0];
  return first ?? null;
}

export interface RowContext {
  readonly source: DecisionRow['source'];
  /** Stable subject key: turn, permission request or decision id. */
  readonly key: string;
  readonly enforced: boolean;
  readonly applied?: boolean;
  readonly note?: string;
}

function gatewayMode(mode: Mode | undefined): DecisionRow['gatewayMode'] {
  return mode === 'act' || mode === 'off' ? mode : 'shadow';
}

export function toRowData(res: DecideResponse, ctx: RowContext): DecisionRow {
  const primary = primaryAnswer(res);
  return {
    decisionId: res.decisionId,
    policy: res.policy,
    source: ctx.source,
    question: primary?.[0] ?? '',
    answer: primary?.[1].answer ?? '',
    confidence: primary?.[1].confidence ?? 0,
    action: res.action,
    gatewayMode: gatewayMode(res.mode),
    enforced: ctx.enforced,
    applied: ctx.applied ?? false,
    attention: ctx.enforced && res.action === 'notify',
    engine: res.engine,
    model: res.model,
    latencyMs: Number.isFinite(res.latencyMs) ? res.latencyMs : 0,
    cached: res.cached,
    error: typeof res.error === 'string' ? res.error.slice(0, 300) : null,
    note: ctx.note ?? null,
    rowId: rowId(ctx.source, ctx.key),
    options: Object.keys(primary?.[1].probabilities ?? {}).slice(0, MAX_OPTIONS),
    feedback: null,
  };
}

/**
 * Whether a row is appended under the user's chat-row setting. `notable` keeps rows that changed
 * something, need attention, failed, or were unsure.
 */
export function rowVisible(row: DecisionRow, show: RowVisibility): boolean {
  if (row.source === 'manual' || show === 'all') {
    return true;
  }
  if (show === 'off') {
    return false;
  }
  return (
    row.applied ||
    row.attention ||
    row.enforced ||
    row.error !== null ||
    (row.answer !== '' && row.confidence < LOW_CONFIDENCE)
  );
}

/** Row ids are stable per subject, so re-appending replaces the row. */
export function rowId(source: DecisionRow['source'], key: string): string {
  return `${MCP_SERVER_NAME}-${source}-${key}`;
}

function percent(confidence: number): string {
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}

/** One-line summary: `turn-outcome · needs_input 82% · notify · shadow`. */
export function rowSummary(row: DecisionRow): string {
  const answer = row.answer === '' ? 'no answer' : `${row.answer} ${percent(row.confidence)}`;
  const mode = row.enforced
    ? 'act'
    : row.gatewayMode === 'act'
      ? 'act (plugin: shadow)'
      : row.gatewayMode;
  return `${row.policy} · ${answer} · ${row.action} · ${mode}`;
}

export function rowDetail(row: DecisionRow): string {
  const parts = [
    shortModel(row.model),
    `${Math.round(row.latencyMs)} ms${row.cached ? ' cached' : ''}`,
  ];
  if (row.note !== null) {
    parts.unshift(row.note);
  }
  if (row.error !== null) {
    parts.push(`engine error: ${row.error}`);
  }
  return parts.filter((p) => p !== '').join(' · ');
}
