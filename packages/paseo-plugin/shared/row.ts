/** The plugin's timeline row: one compact decision, drawn by `client/decision-row.tsx`. */
import { z } from 'zod';

import { MCP_SERVER_NAME, type RowVisibility } from './constants.ts';
import type { Answer, DecideResponse, Mode } from './decision.ts';
import { shortModel } from './models.ts';

const MAX_OPTIONS = 12;
/** Below this confidence a shadow row counts as notable. */
const LOW_CONFIDENCE = 0.7;
/** Below this confidence the summary says `unsure` instead of presenting the answer. */
const UNSURE_CONFIDENCE = 0.5;

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
 * something, need attention or failed, plus unsure rows only while not enforced (shadow), where
 * they help calibration. A routine enforced row (e.g. `log` after every turn in act) is hidden.
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
    row.error !== null ||
    (!row.enforced && row.answer !== '' && row.confidence < LOW_CONFIDENCE)
  );
}

/** Row ids are stable per subject, so re-appending replaces the row. */
export function rowId(source: DecisionRow['source'], key: string): string {
  return `${MCP_SERVER_NAME}-${source}-${key}`;
}

function percent(confidence: number): string {
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}

/** The model's answer, never presented as the answer when weak: `leaned done 80%`, `unsure 40%`. */
function leaning(row: DecisionRow): string {
  if (row.answer === '') {
    return 'no answer';
  }
  const pct = percent(row.confidence);
  return row.confidence < UNSURE_CONFIDENCE ? `unsure ${pct}` : `leaned ${row.answer} ${pct}`;
}

/** What happened: permission rows say whether we allowed or left it to the user. */
function outcome(row: DecisionRow): string {
  if (row.source !== 'permission') {
    return row.action;
  }
  if (row.applied) {
    return 'auto-allowed';
  }
  return !row.enforced && row.action === 'allow' ? 'asked you · would auto-allow' : 'asked you';
}

function modeLabel(row: DecisionRow): string {
  if (row.enforced) {
    return 'act';
  }
  return row.gatewayMode === 'act' ? 'act (plugin: shadow)' : row.gatewayMode;
}

/**
 * One line, what happened first: `permission · asked you · leaned allow 72% · act`,
 * `turn-outcome · notify · leaned needs_input 82% · shadow`.
 */
export function rowSummary(row: DecisionRow): string {
  return `${row.policy} · ${outcome(row)} · ${leaning(row)} · ${modeLabel(row)}`;
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
