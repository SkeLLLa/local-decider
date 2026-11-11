import type { OutcomeRecord, ShadowRecord } from '@ziptie-soft/local-decider-core';

import { percentile, sortedLatencies, wilsonLower } from './numbers.ts';

const MAX_DISAGREEMENTS = 20;

/**
 * How a scope's decisions compare with the Claude Code auto-mode classifier, whose verdict the
 * mod reports as an outcome with source `classifier` after the call ran or was refused.
 */
export interface ClassifierAgreement {
  readonly scope: string;
  /** Decisions in the scope. */
  readonly decisions: number;
  /** Share of the scope's decisions where the decider would allow. */
  readonly coverage: number;
  /** Compared decisions: not auto-allowed by the mod, with a classifier outcome. */
  readonly n: number;
  /** Compared decisions where the decider would allow. */
  readonly wouldAllow: number;
  /** Of those, how many the classifier allowed. */
  readonly bothAllowed: number;
  /** P(classifier allowed | decider would allow); absent when the decider never would. */
  readonly allowPrecision?: number;
  /** Wilson 95% lower bound of `allowPrecision`. */
  readonly allowPrecisionLower?: number;
  /** Compared decisions the classifier allowed. */
  readonly classifierAllowed: number;
  /** Share of those the decider would have asked about. */
  readonly askRateOnClassifierAllowed?: number;
  /** First decision ids where the decider would allow and the classifier denied. */
  readonly disagreements: readonly string[];
  readonly latencyP50Ms?: number;
  readonly latencyP95Ms?: number;
  /** Decisions that timed out or errored. */
  readonly errors: number;
}

/** The mod applied `allow` itself, so no classifier verdict exists to compare against. */
function autoAllowed(d: ShadowRecord): boolean {
  return d.enforced && d.action === 'allow';
}

function compared(
  decisions: readonly ShadowRecord[],
  classifier: ReadonlyMap<string, OutcomeRecord>,
): { decision: ShadowRecord; verdict: string }[] {
  const out: { decision: ShadowRecord; verdict: string }[] = [];
  for (const decision of decisions) {
    const verdict = classifier.get(decision.decisionId)?.outcome;
    if (!autoAllowed(decision) && verdict !== undefined) {
      out.push({ decision, verdict });
    }
  }
  return out;
}

/** Undefined when the policy has no decisions in `scope`. */
export function classifierAgreement(
  scope: string,
  decisions: readonly ShadowRecord[],
  classifier: ReadonlyMap<string, OutcomeRecord>,
): ClassifierAgreement | undefined {
  const scoped = decisions.filter((d) => d.scope === scope);
  if (scoped.length === 0) {
    return undefined;
  }
  const pairs = compared(scoped, classifier);
  const wouldAllow = pairs.filter((p) => p.decision.action === 'allow');
  const bothAllowed = wouldAllow.filter((p) => p.verdict === 'allow').length;
  const allowed = pairs.filter((p) => p.verdict === 'allow');
  const asked = allowed.filter((p) => p.decision.action === 'ask').length;
  const latencies = sortedLatencies(scoped);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  return {
    scope,
    decisions: scoped.length,
    coverage: scoped.filter((d) => d.action === 'allow').length / scoped.length,
    n: pairs.length,
    wouldAllow: wouldAllow.length,
    bothAllowed,
    ...(wouldAllow.length === 0
      ? {}
      : {
          allowPrecision: bothAllowed / wouldAllow.length,
          allowPrecisionLower: wilsonLower(bothAllowed, wouldAllow.length),
        }),
    classifierAllowed: allowed.length,
    ...(allowed.length === 0 ? {} : { askRateOnClassifierAllowed: asked / allowed.length }),
    disagreements: wouldAllow
      .filter((p) => p.verdict === 'deny')
      .slice(0, MAX_DISAGREEMENTS)
      .map((p) => p.decision.decisionId),
    ...(p50 === undefined ? {} : { latencyP50Ms: p50 }),
    ...(p95 === undefined ? {} : { latencyP95Ms: p95 }),
    errors: scoped.filter((d) => d.error !== undefined).length,
  };
}
