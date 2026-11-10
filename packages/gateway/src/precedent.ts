import type {
  LogRecord,
  OutcomeRecord,
  Policy,
  PrecedentTally,
  ShadowRecord,
} from '@local-decider/core';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 10_000;

type PrecedentSettings = NonNullable<Policy['precedent']>;
type SettingsFor = (policyId: string) => PrecedentSettings | undefined;

interface DecisionRef {
  readonly key: string;
  readonly policyId: string;
  readonly ts: string;
}

interface Evidence {
  readonly answer: 'allow' | 'deny';
  readonly expiresAt: number;
}

interface TallyEntry {
  readonly evidence: readonly Evidence[];
}

/** Exact-match precedent built from recent escalated decisions and their first outcomes. */
export class PrecedentStore {
  readonly #settingsFor: SettingsFor;
  readonly #now: () => number;
  readonly #decisions = new Map<string, DecisionRef>();
  readonly #seenOutcomes = new Map<string, true>();
  readonly #tallies = new Map<string, TallyEntry>();

  constructor(settingsFor: SettingsFor, now: () => number = Date.now) {
    this.#settingsFor = settingsFor;
    this.#now = now;
  }

  /** Rebuild recent tallies from log records; old decisions are discarded by their policy age. */
  rebuild(records: readonly LogRecord[]): void {
    this.#decisions.clear();
    this.#seenOutcomes.clear();
    this.#tallies.clear();
    for (const record of records) {
      if (record.kind === 'decision') {
        this.noteDecision(record);
      } else if (record.kind === 'outcome') {
        this.noteOutcome(record);
      }
    }
  }

  /** Remember an escalated decision until its first outcome arrives. */
  noteDecision(record: ShadowRecord): void {
    const key = record.precedentKey;
    if (key === undefined || record.action !== 'ask') {
      return;
    }
    const policyId = record.variant ?? record.policy;
    const settings = this.#settingsFor(policyId);
    if (settings === undefined || !isRecent(record.ts, settings.maxAgeDays, this.#now())) {
      return;
    }
    setLru(this.#decisions, record.decisionId, { key, policyId, ts: record.ts });
  }

  /** Count the first eligible allow/deny outcome for a remembered escalated decision. */
  noteOutcome(outcome: OutcomeRecord): void {
    if (this.#seenOutcomes.has(outcome.decisionId)) {
      return;
    }
    setLru(this.#seenOutcomes, outcome.decisionId, true);
    const decision = this.#decisions.get(outcome.decisionId);
    this.#decisions.delete(outcome.decisionId);
    if (decision === undefined || !isAnswer(outcome.outcome)) {
      return;
    }
    const settings = this.#settingsFor(decision.policyId);
    if (
      settings === undefined ||
      !settings.sources.includes(outcome.source) ||
      !isRecent(decision.ts, settings.maxAgeDays, this.#now()) ||
      !isRecent(outcome.ts, settings.maxAgeDays, this.#now())
    ) {
      return;
    }
    const maxAgeMs = settings.maxAgeDays * DAY_MS;
    const expiresAt = Math.min(Date.parse(decision.ts), Date.parse(outcome.ts)) + maxAgeMs;
    this.#add(decision.key, outcome.outcome, expiresAt);
  }

  /** Current allow/deny counts for a key, evicting expired evidence and refreshing LRU order. */
  tally(key: string): PrecedentTally {
    const entry = this.#tallies.get(key);
    if (entry === undefined) {
      return { allows: 0, denies: 0 };
    }
    const now = this.#now();
    const evidence = entry.evidence.filter((item) => item.expiresAt > now);
    if (evidence.length === 0) {
      this.#tallies.delete(key);
      return { allows: 0, denies: 0 };
    }
    setLru(this.#tallies, key, { ...entry, evidence });
    return {
      allows: evidence.filter((item) => item.answer === 'allow').length,
      denies: evidence.filter((item) => item.answer === 'deny').length,
    };
  }

  #add(key: string, answer: 'allow' | 'deny', expiresAt: number): void {
    const current = this.#tallies.get(key);
    const evidence = current?.evidence.filter((item) => item.expiresAt > this.#now()) ?? [];
    setLru(this.#tallies, key, {
      evidence: [...evidence, { answer, expiresAt }],
    });
  }
}

function setLru<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
}

function isAnswer(value: string): value is 'allow' | 'deny' {
  return value === 'allow' || value === 'deny';
}

function isRecent(timestamp: string, maxAgeDays: number, now: number): boolean {
  const time = Date.parse(timestamp);
  const age = now - time;
  return Number.isFinite(time) && age >= 0 && age <= maxAgeDays * DAY_MS;
}
