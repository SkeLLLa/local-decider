/**
 * What decisions saved (enforced) or would have saved (shadow): tokens moved to another model by
 * routing, priced only when the user configured a price table, and time spent on permission
 * prompts a policy would have answered. Estimates: the counterfactual run never happens.
 */
import type { OutcomeRecord, ShadowRecord, UsageRecord } from '@ziptie-soft/local-decider-core';
import { z } from 'zod';

/** USD per million tokens. `cachedInput` defaults to `input`. */
const priceSchema = z.strictObject({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative().optional(),
  output: z.number().nonnegative(),
});

/** `provider/model` or a bare model id → price. */
export const pricingSchema = z.record(z.string().min(1), priceSchema);

export type Price = z.infer<typeof priceSchema>;
export type Pricing = Readonly<Record<string, Price>>;

export interface TokenTotals {
  /** Uncached input tokens. */
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
}

/** Tasks whose tokens ran (or would run) on `to` instead of `from`. */
export interface ModelMove {
  readonly from: string;
  readonly to: string;
  readonly tasks: number;
  readonly tokens: TokenTotals;
  /** cost(from) − cost(to) for these tokens; absent unless both models are priced. */
  readonly savedUsd?: number;
}

export interface SavingsTotals {
  /** Decisions with reported usage and a known requested and routed model. */
  readonly tasks: number;
  /** Of those, tasks routed to a different model. */
  readonly moved: number;
  readonly tokens: TokenTotals;
  /** Net over priced moves; negative when routing picked dearer models. */
  readonly savedUsd?: number;
  /** Moves without a price for both models, left out of `savedUsd`. */
  readonly unpricedMoves: number;
  readonly moves: readonly ModelMove[];
}

export interface Savings {
  /** Shadow decisions: what enforcing them would have changed. */
  readonly potential: SavingsTotals;
  /** Enforced decisions: what they changed. */
  readonly realized: SavingsTotals;
}

const ZERO: TokenTotals = { input: 0, cachedInput: 0, output: 0 };

function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    output: a.output + b.output,
  };
}

/** Exact `provider/model` first, then the id after the first `/`. */
function priceOf(pricing: Pricing, model: string): Price | undefined {
  const exact = pricing[model];
  if (exact !== undefined) {
    return exact;
  }
  const slash = model.indexOf('/');
  return slash < 0 ? undefined : pricing[model.slice(slash + 1)];
}

function costUsd(price: Price, tokens: TokenTotals): number {
  return (
    (tokens.input * price.input +
      tokens.cachedInput * (price.cachedInput ?? price.input) +
      tokens.output * price.output) /
    1e6
  );
}

/** Usage per decision; a repeated (decisionId, turnId) report replaces the earlier one. */
export function groupUsage(records: readonly UsageRecord[]): Map<string, UsageRecord[]> {
  const byKey = new Map<string, UsageRecord>();
  let anonymous = 0;
  for (const r of records) {
    byKey.set(`${r.decisionId}\n${r.turnId ?? `#${String(anonymous++)}`}`, r);
  }
  const out = new Map<string, UsageRecord[]>();
  for (const r of byKey.values()) {
    const list = out.get(r.decisionId) ?? [];
    list.push(r);
    out.set(r.decisionId, list);
  }
  return out;
}

interface Move {
  readonly from: string;
  readonly to: string;
  readonly tokens: TokenTotals;
}

/** requested → routed for one decision with usage, or undefined when either is unknown. */
function moveOf(d: ShadowRecord, usage: readonly UsageRecord[]): Move | undefined {
  const ranOn = usage.findLast((u) => u.model !== undefined)?.model;
  // In shadow the task ran on the requested model, so the harness's report of it fills a gap.
  const from = d.requestedModel ?? (d.enforced ? undefined : ranOn);
  const to = d.routedModel;
  if (from === undefined || to === undefined) {
    return undefined;
  }
  const tokens = usage.reduce<TokenTotals>(
    (acc, u) =>
      addTokens(acc, {
        input: u.inputTokens,
        cachedInput: u.cachedInputTokens,
        output: u.outputTokens,
      }),
    ZERO,
  );
  return { from, to, tokens };
}

function moveSaving(pricing: Pricing, move: Move): number | undefined {
  const from = priceOf(pricing, move.from);
  const to = priceOf(pricing, move.to);
  return from === undefined || to === undefined
    ? undefined
    : costUsd(from, move.tokens) - costUsd(to, move.tokens);
}

function mergeMove(moves: Map<string, ModelMove>, move: Move, saved: number | undefined): void {
  const key = `${move.from}\n${move.to}`;
  const prev = moves.get(key);
  const savedUsd = saved === undefined ? undefined : (prev?.savedUsd ?? 0) + saved;
  moves.set(key, {
    from: move.from,
    to: move.to,
    tasks: (prev?.tasks ?? 0) + 1,
    tokens: addTokens(prev?.tokens ?? ZERO, move.tokens),
    ...(savedUsd === undefined ? {} : { savedUsd }),
  });
}

function totals(
  decisions: readonly ShadowRecord[],
  usage: ReadonlyMap<string, readonly UsageRecord[]>,
  pricing: Pricing,
): SavingsTotals {
  const moves = new Map<string, ModelMove>();
  let tasks = 0;
  let tokens = ZERO;
  for (const d of decisions) {
    const reported = usage.get(d.decisionId);
    const move = reported === undefined ? undefined : moveOf(d, reported);
    if (move === undefined) {
      continue;
    }
    tasks++;
    if (move.from !== move.to) {
      tokens = addTokens(tokens, move.tokens);
      mergeMove(moves, move, moveSaving(pricing, move));
    }
  }
  const list = [...moves.values()].toSorted((a, b) => b.tasks - a.tasks);
  const priced = list.filter((m) => m.savedUsd !== undefined);
  return {
    tasks,
    moved: list.reduce((acc, m) => acc + m.tasks, 0),
    tokens,
    ...(priced.length === 0
      ? {}
      : { savedUsd: priced.reduce((acc, m) => acc + (m.savedUsd ?? 0), 0) }),
    unpricedMoves: list.length - priced.length,
    moves: list,
  };
}

/** Routing savings of one policy's decisions; undefined when none names a routed model. */
export function computeSavings(
  decisions: readonly ShadowRecord[],
  usage: ReadonlyMap<string, readonly UsageRecord[]>,
  pricing: Pricing = {},
): Savings | undefined {
  if (!decisions.some((d) => d.routedModel !== undefined)) {
    return undefined;
  }
  return {
    potential: totals(
      decisions.filter((d) => !d.enforced),
      usage,
      pricing,
    ),
    realized: totals(
      decisions.filter((d) => d.enforced),
      usage,
      pricing,
    ),
  };
}

/** A prompt left open longer than this was not being watched; its wait is capped here. */
const MAX_WAIT_MS = 10 * 60_000;

export interface PromptTime {
  /** Shadow `allow` decisions the user answered. */
  readonly answered: number;
  /** Of those, the user allowed (the decision would have been right). */
  readonly userAllowed: number;
  /** Time from the decision to the user's answer, capped at 10 minutes each. */
  readonly waitTotalMs: number;
  readonly waitP50Ms?: number;
}

/**
 * Time spent answering prompts the policy would have auto-allowed. Measured from the decision
 * record, so it misses the decision's own latency; undefined when the policy never allowed.
 */
export function computePromptTime(
  decisions: readonly ShadowRecord[],
  outcomes: ReadonlyMap<string, OutcomeRecord>,
): PromptTime | undefined {
  const waits: number[] = [];
  let userAllowed = 0;
  for (const d of decisions) {
    const outcome = outcomes.get(d.decisionId);
    if (d.action !== 'allow' || d.enforced || outcome?.source !== 'user') {
      continue;
    }
    const wait = Date.parse(outcome.ts) - Date.parse(d.ts);
    waits.push(Number.isFinite(wait) ? Math.min(MAX_WAIT_MS, Math.max(0, wait)) : 0);
    if (outcome.outcome === 'allow') {
      userAllowed++;
    }
  }
  if (waits.length === 0) {
    return undefined;
  }
  const sorted = waits.toSorted((a, b) => a - b);
  return {
    answered: waits.length,
    userAllowed,
    waitTotalMs: waits.reduce((acc, w) => acc + w, 0),
    waitP50Ms: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
  };
}
