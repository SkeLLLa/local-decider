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
  readonly models?: DecisionModels;
}

/** Models for savings stats (`provider/model`). Logged, never sent to the engine. */
export interface DecisionModels {
  /** The model the harness uses when the decision changes nothing. */
  readonly requested?: string;
  /** Action (`route:fast`) → the model the harness switches to when it is enforced. */
  readonly routes?: Readonly<Record<string, string>>;
}

/** `POST /v1/usage`: one agent turn's tokens, for the decision that applied to the agent. */
export interface UsageReport {
  readonly decisionId: string;
  readonly turnId?: string;
  readonly model?: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

/** A routing preset resolved for one harness (`routing.presets.<harness>.<preset>`). */
export interface RouteTarget {
  readonly preset: string;
  /** Paseo: `provider/model`; Claude Code and Codex: a model name or id. Absent with a profile. */
  readonly model?: string;
  /** Paseo only: provider mode id. */
  readonly mode?: string;
  /** Thinking or reasoning level (Paseo: thinking option id). */
  readonly thinking?: string;
  /** Paseo only: agent profile id; the plugin expands it. */
  readonly profile?: string;
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
  readonly enforced: boolean;
  readonly answers: Answers;
  readonly rule: number;
  readonly engine: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly cached: boolean;
  readonly precedent?: PrecedentTally;
  readonly precedentKey?: string;
  readonly error?: string;
}

export interface PrecedentTally {
  readonly allows: number;
  readonly denies: number;
}

export interface GatewayHealth {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly engine?: string;
  readonly model?: string;
  /** `stopped|starting|ready|failed`; `detail` says why it is not ready. */
  readonly engineState?: string;
  readonly detail?: string;
  readonly p50Ms?: number;
}

export type OutcomeSource = 'user' | 'harness' | 'heuristic' | 'supervised';
