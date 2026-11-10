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
}

export interface DecideResponse {
  readonly decisionId: string;
  readonly policy: string;
  readonly mode: Mode;
  readonly action: Action;
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
  readonly policy: string;
  readonly mode: Mode;
  readonly inputHash: string;
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

export type LogRecord = ShadowRecord | OutcomeRecord;
