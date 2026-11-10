import {
  buildState,
  canonicalJson,
  evaluateRules,
  inputHash,
  normaliseAnswers,
  policyQuestions,
  policySections,
  redactDeep,
  sortKeysDeep,
  type Answers,
  type DecideRequest,
  type DecideResponse,
  type Mode,
  type ShadowRecord,
  type SystemOneRequest,
  type SystemOneResponse,
} from '@local-decider/core';
import { randomUUID } from 'node:crypto';

import type { Engine } from './engines/types.ts';
import type { LoadedPolicy } from './policies.ts';
import { LatencyWindow, SerialQueue, type Priority } from './queue.ts';
import type { ShadowLog } from './shadow.ts';

const CACHE_MAX = 500;
/** Decisions waiting for the engine before new ones are refused (fail open, logged). */
export const QUEUE_MAX = 8;

export class UnknownPolicyError extends Error {
  override readonly name = 'UnknownPolicyError';
}

export interface DeciderOptions {
  readonly engine: Engine;
  readonly policies: ReadonlyMap<string, LoadedPolicy>;
  readonly log: ShadowLog;
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
  readonly #policies: Map<string, LoadedPolicy>;
  readonly #log: ShadowLog;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #queue = new SerialQueue();
  readonly #latency = new LatencyWindow();
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: DeciderOptions) {
    this.#engine = options.engine;
    this.#policies = new Map(options.policies);
    this.#log = options.log;
    this.#timeoutMs = options.decisionTimeoutMs;
    this.#now = options.now ?? (() => new Date());
  }

  get policies(): ReadonlyMap<string, LoadedPolicy> {
    return this.#policies;
  }

  get engine(): Engine {
    return this.#engine;
  }

  /**
   * Serve later decisions from `next` and drop cached answers, which belong to the old model.
   * Stopping the old engine is the caller's job; decisions already queued on it fail open.
   */
  /** Change a policy's run mode in place; false when the policy is unknown. */
  setMode(id: string, mode: Mode): boolean {
    const loaded = this.#policies.get(id);
    if (loaded === undefined) {
      return false;
    }
    this.#policies.set(id, { ...loaded, mode });
    return true;
  }

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
    const loaded = this.#policies.get(policyId);
    if (loaded === undefined) {
      throw new UnknownPolicyError(`unknown policy "${policyId}"`);
    }
    const { policy, mode } = loaded;
    const decisionId = randomUUID();
    const base = {
      decisionId,
      policy: policy.id,
      mode,
      engine: this.#engine.id,
      model: this.#engine.model,
    };
    if (mode === 'off') {
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
    const sections = policySections(policy, redactDeep(request.input), renderValue);
    const state = buildState(sections, policy.state.maxTokens);
    const questions = sortKeysDeep(policyQuestions(policy));
    const hash = inputHash({ id: policy.id, version: policy.version, state, questions });
    // Nobody acts on a shadow decision, so it outlives a caller that gave up (a hook's 1.5 s
    // budget is shorter than a CPU decision) and is still logged, within decisionTimeoutMs.
    const callerSignal = mode === 'shadow' ? new AbortController().signal : signal;
    const result = await this.#answers(
      { state, questions },
      hash,
      loaded.policy.cache.ttlSeconds,
      callerSignal,
      policy.priority,
    );
    const match = evaluateRules(policy, result.answers);
    const enforced = mode === 'act' && result.error === undefined;
    const response: DecideResponse = {
      ...base,
      action: match.action,
      enforced,
      answers: result.answers,
      rule: match.rule,
      latencyMs: result.latencyMs,
      cached: result.cached,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
    this.#record(request, response, hash);
    return response;
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

  #record(request: DecideRequest, response: DecideResponse, hash: string): void {
    const record: ShadowRecord = {
      kind: 'decision',
      ts: this.#now().toISOString(),
      decisionId: response.decisionId,
      harness: request.harness,
      policy: response.policy,
      mode: response.mode,
      inputHash: hash,
      answers: response.answers,
      action: response.action,
      enforced: response.enforced,
      engine: response.engine,
      model: response.model,
      latencyMs: Math.round(response.latencyMs),
      ...(response.error === undefined ? {} : { error: response.error }),
    };
    this.#log.append(record);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'decision timed out';
  }
  return error instanceof Error ? error.message : String(error);
}
