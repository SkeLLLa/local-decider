import {
  buildState,
  canonicalJson,
  CHARS_PER_TOKEN,
  evaluateRules,
  inputHash,
  normaliseAnswers,
  type OutcomeRecord,
  policyQuestions,
  policySections,
  policyThresholds,
  redactDeep,
  withThresholds,
  sortKeysDeep,
  type Answers,
  type DecideRequest,
  type DecideResponse,
  type LogRecord,
  minMode,
  type Mode,
  type Policy,
  type PolicyThreshold,
  type PrecedentTally,
  type Scope,
  type ShadowRecord,
  type SystemOneRequest,
  type SystemOneResponse,
} from '@local-decider/core';
import { randomUUID } from 'node:crypto';

import { CallStore, type CallDecision } from './call-store.ts';
import type { Engine } from './engines/types.ts';
import type { LoadedPolicy } from './policies.ts';
import { PrecedentStore } from './precedent.ts';
import { LatencyWindow, SerialQueue, type Priority } from './queue.ts';
import type { LogStore } from './shadow.ts';

const CACHE_MAX = 500;
/** Decisions waiting for the engine before new ones are refused (fail open, logged). */
export const QUEUE_MAX = 8;

export class UnknownPolicyError extends Error {
  override readonly name = 'UnknownPolicyError';
}

export interface DeciderOptions {
  readonly engine: Engine;
  readonly policies: ReadonlyMap<string, LoadedPolicy>;
  readonly log: LogStore;
  readonly decisionTimeoutMs: number;
  readonly now?: () => Date;
}

interface CacheEntry {
  readonly answers: Answers;
  readonly expires: number;
}

interface EngineResult {
  readonly answers: Answers;
  readonly latencyMs: number;
  readonly cached: boolean;
  readonly error?: string;
}

interface PrecedentDecision {
  readonly key: string;
  readonly tally: PrecedentTally;
  readonly allows: boolean;
}

/** Strings pass through; everything else becomes key-sorted JSON. */
export function renderValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : canonicalJson(value);
}

/** The policy pipeline: redact → state → cache → engine (serial) → rules → shadow log. */
export class Decider {
  #engine: Engine;
  #policies: Map<string, LoadedPolicy>;
  /** Policy id → the variant answering for it, when not the policy itself. */
  readonly #variants = new Map<string, string>();
  /** Policy id → rule threshold overrides by `<question>.<answer>`, for that policy's own rules. */
  readonly #thresholds = new Map<string, Readonly<Record<string, number>>>();
  readonly #log: LogStore;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #queue = new SerialQueue();
  readonly #latency = new LatencyWindow();
  readonly #cache = new Map<string, CacheEntry>();
  readonly #precedent: PrecedentStore;
  /** Recent harness tool calls and what each policy decided for them. */
  readonly calls = new CallStore();

  constructor(options: DeciderOptions) {
    this.#engine = options.engine;
    this.#policies = new Map(options.policies);
    this.#log = options.log;
    this.#timeoutMs = options.decisionTimeoutMs;
    this.#now = options.now ?? (() => new Date());
    this.#precedent = new PrecedentStore(
      (id) => this.#policies.get(id)?.policy.precedent,
      () => this.#now().getTime(),
    );
  }

  get policies(): ReadonlyMap<string, LoadedPolicy> {
    return this.#policies;
  }

  get engine(): Engine {
    return this.#engine;
  }

  /** Change a policy's run mode in place; false when the policy is unknown. */
  setMode(id: string, mode: Mode): boolean {
    const loaded = this.#policies.get(id);
    if (loaded === undefined) {
      return false;
    }
    this.#policies.set(id, { ...loaded, mode });
    return true;
  }

  /** Set the per-scope mode caps of policy `id`; `{}` clears them. False for an unknown policy. */
  setScopeModes(id: string, modes: Partial<Record<Scope, Mode>>): boolean {
    const loaded = this.#policies.get(id);
    if (loaded === undefined) {
      return false;
    }
    this.#policies.set(id, { ...loaded, scopes: modes });
    return true;
  }

  /** The mode policy `id` runs in for `scope`: its own, capped by the scope's (default shadow). */
  effectiveMode(id: string, scope?: Scope): Mode {
    const loaded = this.#policies.get(id);
    const mode = loaded?.mode ?? 'off';
    return scope === undefined ? mode : minMode(mode, loaded?.scopes?.[scope] ?? 'shadow');
  }

  /**
   * Override rule thresholds of policy `id` (its own rules, also when it answers as a variant);
   * `{}` restores the file's. Keys naming no rule are dropped. False when the policy is unknown.
   */
  setThresholds(id: string, thresholds: Readonly<Record<string, number>>): boolean {
    const loaded = this.#policies.get(id);
    if (loaded === undefined) {
      return false;
    }
    const known = new Set(policyThresholds(loaded.policy).map((t) => t.key));
    const kept = Object.entries(thresholds).filter(([key]) => known.has(key));
    if (kept.length === 0) {
      this.#thresholds.delete(id);
    } else {
      this.#thresholds.set(id, Object.fromEntries(kept));
    }
    return true;
  }

  /** The rule thresholds of policy `id` with their defaults and values in effect. */
  thresholdsOf(id: string): PolicyThreshold[] {
    const loaded = this.#policies.get(id);
    return loaded === undefined
      ? []
      : policyThresholds(loaded.policy, this.#thresholds.get(id) ?? {});
  }

  /** Answer `id` with policy `variant` (`id` itself restores the default); false when it can't. */
  setVariant(id: string, variant: string): boolean {
    if (!this.#canAnswer(id, variant)) {
      return false;
    }
    if (variant === id) {
      this.#variants.delete(id);
    } else {
      this.#variants.set(id, variant);
    }
    return true;
  }

  /** The policy that answers for `id` now. */
  activeVariant(id: string): string {
    return this.#variants.get(id) ?? id;
  }

  /** Policies that can answer for `id`: itself first, then its variants by id. */
  variantsOf(id: string): string[] {
    const variants = [...this.#policies.values()]
      .filter(({ policy }) => policy.variantOf === id)
      .map(({ policy }) => policy.id)
      .toSorted();
    const base = this.#policies.get(id);
    return base === undefined || base.policy.variantOf !== undefined ? [] : [id, ...variants];
  }

  /**
   * Serve reloaded policies. Cached answers belong to the old questions and are dropped, and a
   * variant choice whose policy is gone falls back to the default, and threshold overrides keep
   * only keys that still name a rule. Modes come with `next`.
   */
  replacePolicies(next: ReadonlyMap<string, LoadedPolicy>): void {
    this.#policies = new Map(next);
    this.#cache.clear();
    for (const [id, thresholds] of this.#thresholds) {
      if (!this.setThresholds(id, thresholds)) {
        this.#thresholds.delete(id);
      }
    }
    for (const [id, variant] of this.#variants) {
      if (!this.#canAnswer(id, variant)) {
        this.#variants.delete(id);
      }
    }
    this.#precedent.rebuild(this.#recentPrecedentRecords());
  }

  /** Rebuild precedent once from the append-only decision log during startup. */
  /** Rebuild from the selected backend, allowing SQLite to query only verified outcomes. */
  rebuildPrecedent(records?: readonly LogRecord[]): void {
    this.#precedent.rebuild(records ?? this.#recentPrecedentRecords());
  }

  /** Add a reported outcome to recent precedent evidence. */
  noteOutcome(outcome: OutcomeRecord): void {
    this.#precedent.noteOutcome(outcome);
  }

  #canAnswer(id: string, variant: string): boolean {
    const base = this.#policies.get(id);
    if (base === undefined || base.policy.variantOf !== undefined) {
      return false;
    }
    return variant === id || this.#policies.get(variant)?.policy.variantOf === id;
  }

  #recentPrecedentRecords(): LogRecord[] {
    const log = this.#log as LogStore & {
      readVerifiedPrecedent?: (days: number, now?: number) => LogRecord[];
    };
    return (
      log.readVerifiedPrecedent?.(90, this.#now().getTime()) ??
      this.#log.readRecent(90, this.#now().getTime())
    );
  }

  /**
   * The requested policy's mode with the selected variant's questions and rules, the rules with
   * that variant's threshold overrides.
   */
  #resolve(policyId: string, scope?: Scope): { mode: Mode; policy: Policy; variant?: string } {
    const loaded = this.#policies.get(policyId);
    if (loaded === undefined) {
      throw new UnknownPolicyError(`unknown policy "${policyId}"`);
    }
    const selected = this.#policies.get(this.activeVariant(policyId));
    const answering = selected ?? loaded;
    const policy = withThresholds(
      answering.policy,
      this.#thresholds.get(answering.policy.id) ?? {},
    );
    const mode = this.effectiveMode(policyId, scope);
    return answering === loaded ? { mode, policy } : { mode, policy, variant: answering.policy.id };
  }

  /**
   * Serve later decisions from `next` and drop cached answers, which belong to the old model.
   * Stopping the old engine is the caller's job; decisions already queued on it fail open.
   */
  replaceEngine(next: Engine): Engine {
    const previous = this.#engine;
    this.#engine = next;
    this.#cache.clear();
    return previous;
  }

  get queueDepth(): number {
    return this.#queue.depth;
  }

  latency(p: number): number | undefined {
    return this.#latency.percentile(p);
  }

  /** Pass-through `/v1/systemone`: keys sorted, strings redacted, one request at a time. */
  async systemOne(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> {
    const clean = sortKeysDeep(redactDeep(request));
    const started = performance.now();
    const bounded = this.#signal(signal);
    const response = await this.#queue.run(bounded, () => this.#engine.decide(clean, bounded));
    this.#latency.add(performance.now() - started);
    return response;
  }

  async decide(
    policyId: string,
    request: DecideRequest,
    signal: AbortSignal,
  ): Promise<DecideResponse> {
    const { policy, mode, variant } = this.#resolve(policyId, request.scope);
    const decisionId = randomUUID();
    const base = {
      decisionId,
      policy: policyId,
      ...(variant === undefined ? {} : { variant }),
      mode,
      ...(request.scope === undefined ? {} : { scope: request.scope }),
      engine: this.#engine.id,
      model: this.#engine.model,
    };
    if (mode === 'off') {
      this.#noteCall(request, policyId, {
        decisionId,
        action: 'abstain',
        enforced: false,
        answered: false,
      });
      return {
        ...base,
        action: 'abstain',
        enforced: false,
        answers: {},
        rule: -1,
        latencyMs: 0,
        cached: false,
      };
    }
    const input = redactDeep(request.input);
    const precedent = this.#precedentFor(policy, input);
    const modelInput = { ...input };
    delete modelInput['subject'];
    if (policy.precedent !== undefined) {
      delete modelInput[policy.precedent.from];
    }
    const sections = policySections(policy, modelInput, renderValue);
    const state = buildState(sections, policy.state.maxTokens);
    const questions = sortKeysDeep(policyQuestions(policy));
    const hash = inputHash({ id: policy.id, version: policy.version, state, questions });
    // Nobody acts on a shadow decision, so it outlives a caller that gave up (a hook's 1.5 s
    // budget is shorter than a CPU decision) and is still logged, within decisionTimeoutMs.
    const callerSignal = mode === 'shadow' ? new AbortController().signal : signal;
    const result = await this.#answers(
      { state, questions },
      hash,
      policy.cache.ttlSeconds,
      callerSignal,
      policy.priority,
    );
    const match = evaluateRules(policy, result.answers, {
      precedentAllows: precedent?.allows ?? false,
    });
    const enforced = mode === 'act' && result.error === undefined;
    const response: DecideResponse = {
      ...base,
      action: match.action,
      enforced,
      answers: result.answers,
      rule: match.rule,
      latencyMs: result.latencyMs,
      cached: result.cached,
      ...(precedent === undefined
        ? {}
        : { precedentKey: precedent.key, precedent: precedent.tally }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
    this.#record(request, response, {
      hash,
      stateTokens: Math.ceil(state.length / CHARS_PER_TOKEN),
    });
    this.#noteCall(request, policyId, {
      decisionId,
      action: response.action,
      enforced: response.enforced,
      answered: response.error === undefined,
    });
    return response;
  }

  /** Index the decision under the request's call id, even if its HTTP caller is gone. */
  #noteCall(request: DecideRequest, policyId: string, decision: CallDecision): void {
    if (request.call !== undefined) {
      this.calls.note(request.call.id, policyId, decision, request.call.permissionMode);
    }
  }

  #precedentFor(
    policy: Policy,
    input: Readonly<Record<string, unknown>>,
  ): PrecedentDecision | undefined {
    const settings = policy.precedent;
    if (settings === undefined) {
      return undefined;
    }
    const subject = renderValue(input[settings.from]).replace(/\s+/g, ' ').trim();
    if (subject === '') {
      return undefined;
    }
    const key = inputHash([policy.id, input['project'], subject]);
    const tally = this.#precedent.tally(key);
    return {
      key,
      tally,
      allows: tally.allows >= settings.minAllows && tally.denies === 0,
    };
  }

  async #answers(
    request: SystemOneRequest,
    hash: string,
    ttlSeconds: number,
    signal: AbortSignal,
    priority: Priority = 'normal',
  ): Promise<EngineResult> {
    const hit = this.#cache.get(hash);
    if (hit !== undefined && hit.expires > Date.now()) {
      return { answers: hit.answers, latencyMs: 0, cached: true };
    }
    // A managed engine loads on demand and waits inside decide(); others must already be up.
    if (this.#engine.ensureReady === undefined && this.#engine.health().state !== 'ready') {
      return {
        answers: {},
        latencyMs: 0,
        cached: false,
        error: `engine ${this.#engine.health().state}`,
      };
    }
    if (this.#queue.depth >= QUEUE_MAX) {
      return { answers: {}, latencyMs: 0, cached: false, error: 'engine queue full' };
    }
    const started = performance.now();
    try {
      const bounded = this.#signal(signal);
      const response = await this.#queue.run(
        bounded,
        () => this.#engine.decide(request, bounded),
        priority,
      );
      const answers = normaliseAnswers(request.questions, response);
      const latencyMs = performance.now() - started;
      this.#latency.add(latencyMs);
      this.#remember(hash, answers, ttlSeconds);
      return { answers, latencyMs, cached: false };
    } catch (error) {
      return {
        answers: {},
        latencyMs: performance.now() - started,
        cached: false,
        error: errorMessage(error),
      };
    }
  }

  #remember(hash: string, answers: Answers, ttlSeconds: number): void {
    if (ttlSeconds <= 0) {
      return;
    }
    if (this.#cache.size >= CACHE_MAX) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) {
        this.#cache.delete(oldest);
      }
    }
    this.#cache.set(hash, { answers, expires: Date.now() + ttlSeconds * 1000 });
  }

  #signal(caller: AbortSignal): AbortSignal {
    return AbortSignal.any([caller, AbortSignal.timeout(this.#timeoutMs)]);
  }

  #record(
    request: DecideRequest,
    response: DecideResponse,
    state: { hash: string; stateTokens: number },
  ): void {
    const record: ShadowRecord = {
      kind: 'decision',
      ts: this.#now().toISOString(),
      decisionId: response.decisionId,
      harness: request.harness,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      policy: response.policy,
      ...(response.variant === undefined ? {} : { variant: response.variant }),
      mode: response.mode,
      ...callFields(request),
      inputHash: state.hash,
      ...(response.precedentKey === undefined ? {} : { precedentKey: response.precedentKey }),
      ...(response.precedent === undefined ? {} : { precedent: response.precedent }),
      stateTokens: state.stateTokens,
      ...modelFields(request, response.action),
      answers: response.answers,
      action: response.action,
      enforced: response.enforced,
      engine: response.engine,
      model: response.model,
      latencyMs: Math.round(response.latencyMs),
      ...(response.error === undefined ? {} : { error: response.error }),
    };
    this.#log.append(record);
    this.#precedent.noteDecision(record);
  }
}

/** `scope`, `callId`, `permissionMode` and `subagent`, from the request's `scope` and `call`. */
function callFields(
  request: DecideRequest,
): Pick<ShadowRecord, 'scope' | 'callId' | 'permissionMode' | 'subagent'> {
  const { call, scope } = request;
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(call === undefined ? {} : { callId: call.id }),
    ...(call?.permissionMode === undefined ? {} : { permissionMode: call.permissionMode }),
    ...(call?.agent === undefined ? {} : { subagent: call.agent }),
  };
}

/** `requestedModel` and the model `action` routes to, from the request's `models`. */
function modelFields(
  request: DecideRequest,
  action: string,
): { requestedModel?: string; routedModel?: string } {
  const requested = request.models?.requested;
  const routed = request.models?.routes?.[action];
  return {
    ...(requested === undefined ? {} : { requestedModel: requested }),
    ...(routed === undefined ? {} : { routedModel: routed }),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'decision timed out';
  }
  return error instanceof Error ? error.message : String(error);
}
