import type {
  LogRecord,
  OutcomeRecord,
  Policy,
  PrecedentTally,
  ShadowRecord,
} from '@ziptie-soft/local-decider-core';

import { correctedOutcome, isVerifiedOutcome, outcomeClass } from './outcome-labels.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 10_000;

type PrecedentSettings = NonNullable<Policy['precedent']>;
type SettingsFor = (policyId: string) => PrecedentSettings | undefined;

interface DecisionRef {
  readonly key: string;
  readonly policyId: string;
  readonly ts: string;
  readonly action: 'ask' | 'allow';
  /** The effective verified outcome so far: absent, or neutral (final ones leave the map). */
  readonly label?: string;
}

interface Evidence {
  readonly answer: 'allow' | 'deny';
  readonly expiresAt: number;
}

interface TallyEntry {
  readonly evidence: readonly Evidence[];
}

/**
 * Exact-match precedent from recent escalated decisions, their effective verified outcomes
 * (ADR-0006), and vetoes on keyed auto-allowed decisions.
 */
export class PrecedentStore {
  readonly #settingsFor: SettingsFor;
  readonly #now: () => number;
  readonly #decisions = new Map<string, DecisionRef>();
  readonly #allowed = new Map<string, DecisionRef>();
  readonly #tallies = new Map<string, TallyEntry>();

  constructor(settingsFor: SettingsFor, now: () => number = Date.now) {
    this.#settingsFor = settingsFor;
    this.#now = now;
  }

  /** Rebuild recent tallies from log records; old decisions are discarded by their policy age. */
  rebuild(records: readonly LogRecord[]): void {
    this.#decisions.clear();
    this.#allowed.clear();
    this.#tallies.clear();
    for (const record of records) {
      if (record.kind === 'decision') {
        this.noteDecision(record);
      } else if (record.kind === 'outcome') {
        this.noteOutcome(record);
      }
    }
  }

  /** Remember escalated decisions, and keyed auto-allowed ones for vetoes, until final. */
  noteDecision(record: ShadowRecord): void {
    const key = record.precedentKey;
    if (key === undefined || (record.action !== 'ask' && record.action !== 'allow')) {
      return;
    }
    const policyId = record.variant ?? record.policy;
    const settings = this.#settingsFor(policyId);
    if (settings === undefined || !isRecent(record.ts, settings.maxAgeDays, this.#now())) {
      return;
    }
    setLru(this.#pendingMap(record.action), record.decisionId, {
      key,
      policyId,
      ts: record.ts,
      action: record.action,
    });
  }

  /**
   * Count a verified outcome for a remembered decision: the first one is final, except that a
   * neutral one may be corrected once to a veto (ADR-0006 addendum).
   */
  noteOutcome(outcome: OutcomeRecord): void {
    if (!isVerifiedOutcome(outcome)) {
      this.#noteUnverifiedVeto(outcome);
      return;
    }
    const decision =
      this.#decisions.get(outcome.decisionId) ?? this.#allowed.get(outcome.decisionId);
    if (decision === undefined || !this.#mayCount(decision, outcome)) {
      return;
    }
    const next = this.#nextLabel(decision, outcome);
    if (next === undefined) {
      return;
    }
    const answer = evidenceFor(decision, next, outcome.source);
    const settings = answer === undefined ? undefined : this.#eligible(decision, outcome);
    if (answer === undefined || settings === undefined) {
      return;
    }
    const expiresAt =
      Math.min(Date.parse(decision.ts), Date.parse(outcome.ts)) + settings.maxAgeDays * DAY_MS;
    this.#add(decision.key, answer, expiresAt);
  }

  /** Unverified deny reports from configured sources may only tighten precedence. */
  #noteUnverifiedVeto(outcome: OutcomeRecord): void {
    const source = outcome.claimedSource;
    if (
      outcome.source !== 'unverified' ||
      source === undefined ||
      outcomeClass(outcome.outcome) !== 'veto'
    ) {
      return;
    }
    const decision =
      this.#decisions.get(outcome.decisionId) ?? this.#allowed.get(outcome.decisionId);
    const settings =
      decision === undefined ? undefined : this.#unverifiedVetoSettings(decision, outcome);
    if (decision === undefined || settings === undefined) return;
    const next = this.#nextLabel(decision, outcome);
    if (next === undefined || outcomeClass(next) !== 'veto') return;
    const expiresAt =
      Math.min(Date.parse(decision.ts), Date.parse(outcome.ts)) + settings.maxAgeDays * DAY_MS;
    this.#add(decision.key, 'deny', expiresAt);
  }

  #unverifiedVetoSettings(
    decision: DecisionRef,
    outcome: OutcomeRecord,
  ): PrecedentSettings | undefined {
    const settings = this.#settingsFor(decision.policyId);
    const source = outcome.claimedSource;
    const now = this.#now();
    if (
      settings === undefined ||
      source === undefined ||
      !(settings.vetoSources as readonly string[]).includes(source) ||
      !isRecent(decision.ts, settings.maxAgeDays, now) ||
      !isRecent(outcome.ts, settings.maxAgeDays, now)
    ) {
      return undefined;
    }
    return settings;
  }

  /** A keyed auto-allow only reacts to an eligible veto; anything else leaves it untouched. */
  #mayCount(decision: DecisionRef, outcome: OutcomeRecord): boolean {
    return (
      decision.action === 'ask' ||
      (outcomeClass(outcome.outcome) === 'veto' && this.#eligible(decision, outcome) !== undefined)
    );
  }

  #pendingMap(action: 'ask' | 'allow'): Map<string, DecisionRef> {
    return action === 'ask' ? this.#decisions : this.#allowed;
  }

  /** The new effective label, or undefined when the outcome is ignored. Updates pending state. */
  #nextLabel(decision: DecisionRef, outcome: OutcomeRecord): string | undefined {
    const next = correctedOutcome(decision.label, outcome.outcome);
    if (next === undefined) {
      return undefined;
    }
    const map = this.#pendingMap(decision.action);
    if (outcomeClass(next) === 'neutral') {
      // Still correctable: the label stays with its decision, so both are evicted together.
      setLru(map, outcome.decisionId, { ...decision, label: next });
    } else {
      map.delete(outcome.decisionId);
    }
    return next;
  }

  #eligible(decision: DecisionRef, outcome: OutcomeRecord): PrecedentSettings | undefined {
    const settings = this.#settingsFor(decision.policyId);
    const now = this.#now();
    if (
      settings === undefined ||
      !(settings.sources as readonly string[]).includes(outcome.source) ||
      !isRecent(decision.ts, settings.maxAgeDays, now) ||
      !isRecent(outcome.ts, settings.maxAgeDays, now)
    ) {
      return undefined;
    }
    return settings;
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

function evidenceFor(
  decision: DecisionRef,
  outcome: string,
  source: OutcomeRecord['source'],
): 'allow' | 'deny' | undefined {
  const cls = outcomeClass(outcome);
  if (cls === 'veto') {
    return 'deny';
  }
  return cls === 'allow' && decision.action === 'ask' && isAllowSource(source)
    ? 'allow'
    : undefined;
}

function isAllowSource(source: OutcomeRecord['source']): boolean {
  return source === 'user' || source === 'supervised';
}

function isRecent(timestamp: string, maxAgeDays: number, now: number): boolean {
  const time = Date.parse(timestamp);
  const age = now - time;
  return Number.isFinite(time) && age >= 0 && age <= maxAgeDays * DAY_MS;
}
