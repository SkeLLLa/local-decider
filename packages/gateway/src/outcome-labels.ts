/** Fixed meanings of outcome values for precedent and statistics (ADR-0006 addendum 2026-11-12). */
export type OutcomeClass = 'allow' | 'veto' | 'neutral' | 'other';

/**
 * How far back startup replays keyed auto-allows without outcomes, so a first veto after a
 * restart still lands. The Paseo plugin's label window (24 h, `LABEL_WINDOW_MS` in
 * paseo-plugin/shared/row.ts) plus an hour of slack; keep it at least that window.
 */
export const ALLOW_VETO_REPLAY_MS = 25 * 60 * 60 * 1000;

export function outcomeClass(outcome: string): OutcomeClass {
  if (outcome === 'allow') {
    return 'allow';
  }
  if (outcome === 'deny' || outcome === 'unsafe') {
    return 'veto';
  }
  if (outcome === 'decline' || outcome === 'interrupted') {
    return 'neutral';
  }
  return 'other';
}

/**
 * The effective outcome once `next` arrives, given the current one (undefined: none yet). The
 * first outcome is final, except that a neutral one may be corrected once to a veto.
 * Undefined: `next` is ignored. Never yields a move towards allow.
 */
export function correctedOutcome(current: string | undefined, next: string): string | undefined {
  if (current === undefined) {
    return next;
  }
  return outcomeClass(current) === 'neutral' && outcomeClass(next) === 'veto' ? next : undefined;
}

/** Outcomes precedent and calibration may learn from: token-verified, from a real source. */
export function isVerifiedOutcome(o: { verified?: boolean; source: string }): boolean {
  return o.verified === true && o.source !== 'unverified';
}

/** The value agreement statistics compare with the model's answer; undefined excludes it. */
export function comparableOutcome(outcome: string): string | undefined {
  if (outcomeClass(outcome) === 'neutral') {
    return undefined;
  }
  return outcome === 'unsafe' ? 'deny' : outcome;
}
