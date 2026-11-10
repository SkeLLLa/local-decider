// fallow-ignore-file code-duplication
/**
 * Wire types of the local-decider gateway, copied from `@local-decider/core` (decision.ts,
 * policy.ts, systemone.ts, client.ts). Paseo's bundler applies its runtime-boundary rules to type
 * imports too, and the published plugin does not ship the workspace package, so the plugin keeps
 * its own copy. `test/types.test.ts` fails the typecheck when the two drift apart.
 */

export type Mode = 'off' | 'shadow' | 'act';

/** `allow|ask|deny|log|abstain|notify|route:<preset>`. */
export type Action = string;

export interface Answer {
  readonly type: 'noul' | 'choice' | 'score';
  readonly answer: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly score?: number;
}

export type Answers = Readonly<Record<string, Answer>>;

export interface DecideRequest {
  readonly harness: 'paseo';
  readonly sessionId?: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface DecideResponse {
  readonly decisionId: string;
  readonly policy: string;
  readonly mode: Mode;
  readonly action: Action;
  readonly enforced: boolean;
  readonly answers: Answers;
  readonly rule: number;
  readonly engine: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly cached: boolean;
  readonly error?: string;
}

export interface GatewayHealth {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly engine?: string;
  readonly model?: string;
  readonly p50Ms?: number;
}

export type OutcomeSource = 'user' | 'harness' | 'heuristic';
