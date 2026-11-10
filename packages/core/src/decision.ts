/**
 * The gateway's policy API (`POST /v1/decide/:policy`), shared by the gateway and every harness
 * adapter, and the shadow-log records it writes.
 */
import type { Action, Mode } from './policy.ts';
import type { Answers } from './systemone.ts';

export const HARNESSES = ['paseo', 'claude-code', 'codex', 'mcp', 'cli'] as const;
export type Harness = (typeof HARNESSES)[number];

export interface DecideRequest {
  readonly harness: Harness;
  /** Harness session or agent id, for joining outcomes later. Never sent to the engine. */
  readonly sessionId?: string;
  /** Structured, untrusted input; the policy's `state.sections` say which keys become state. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Models for savings stats (`provider/model`). Logged, never sent to the engine. */
  readonly models?: DecisionModels;
}

export interface DecisionModels {
  /** The model the harness uses when the decision changes nothing. */
  readonly requested?: string;
  /** Action (`route:fast`) → the model the harness switches to when it is enforced. */
  readonly routes?: Readonly<Record<string, string>>;
}

/** A routing preset resolved for one harness (`routing.presets.<harness>.<preset>`). */
export interface RouteTarget {
  readonly preset: string;
  /** Paseo: `provider/model`; Claude Code and Codex: a model name or id. */
  readonly model: string;
  /** Paseo only: provider mode id. */
  readonly mode?: string;
}

export interface DecideResponse {
  readonly decisionId: string;
  readonly policy: string;
  /** The policy that answered when the user selected a variant of `policy`. */
  readonly variant?: string;
  readonly mode: Mode;
  readonly action: Action;
  /** Where `action` (`route:<preset>`) sends this harness, from config.yaml; absent if unmapped. */
  readonly route?: RouteTarget;
  /**
   * True only in `act` mode with an engine answer. Adapters must not change harness behaviour
   * unless this is true; in shadow mode the action is what *would* have happened.
   */
  readonly enforced: boolean;
  readonly answers: Answers;
  /** Matching rule index, -1 for the policy default. */
  readonly rule: number;
  readonly engine: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly cached: boolean;
  /** Set when the engine failed; the action is then the policy default and never enforced. */
  readonly error?: string;
}

export interface ShadowRecord {
  readonly kind: 'decision';
  readonly ts: string;
  readonly decisionId: string;
  readonly harness: Harness;
  readonly sessionId?: string;
  readonly policy: string;
  readonly variant?: string;
  readonly mode: Mode;
  readonly inputHash: string;
  /** Estimated tokens of the state sent to the engine. */
  readonly stateTokens?: number;
  /** `DecideRequest.models.requested`. */
  readonly requestedModel?: string;
  /** The model `action` routes to, when the request mapped it. */
  readonly routedModel?: string;
  readonly answers: Answers;
  readonly action: Action;
  readonly enforced: boolean;
  readonly engine: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly error?: string;
}

/** What actually happened, reported later by an adapter (e.g. the user allowed the request). */
export interface OutcomeRecord {
  readonly kind: 'outcome';
  readonly ts: string;
  readonly decisionId: string;
  /** The ground-truth answer for the policy's primary question, in its answer space. */
  readonly outcome: string;
  readonly source: 'user' | 'harness' | 'heuristic';
}

/**
 * Tokens one agent turn used, reported by an adapter for the agent a decision applied to (e.g.
 * the agent a routing decision created). Numbers only: no prompt or response text.
 */
export interface UsageRecord {
  readonly kind: 'usage';
  readonly ts: string;
  readonly decisionId: string;
  /** Adapter-scoped turn id; a repeated (decisionId, turnId) pair is counted once. */
  readonly turnId?: string;
  /** The model the turn ran on (`provider/model`), when the harness says. */
  readonly model?: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /** The harness's own cost figure for the turn, when it has one. */
  readonly costUsd?: number;
}

export type LogRecord = ShadowRecord | OutcomeRecord | UsageRecord;
