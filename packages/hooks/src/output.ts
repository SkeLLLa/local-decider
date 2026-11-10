/**
 * DecideResponse → harness stdout. An empty string means "abstain": exit 0 with no output, so the
 * harness runs its normal flow. Only enforced decisions produce output (ADR-0005).
 */
import type { DecideResponse } from '@local-decider/core';

import type { GuardHit } from './guard.ts';
import type { HookEvent, HookHarness } from './mapping.ts';

const PREFIX = 'local-decider';

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function preToolUse(decision: 'deny' | 'ask', reason: string): string {
  return json({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

export function guardDeny(hit: GuardHit): string {
  return preToolUse('deny', `${PREFIX} guard (${hit.rule}): ${hit.reason}.`);
}

function permissionAllow(): string {
  return json({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
}

function routingContext(preset: string): string {
  return json({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `${PREFIX}: routing suggests the "${preset}" model tier for this task.`,
    },
  });
}

/** Short, model-facing explanation: policy, primary answer and confidence. */
function reasonOf(res: DecideResponse): string {
  const answer = Object.entries(res.answers)[0];
  const detail =
    answer === undefined
      ? ''
      : ` (${answer[0]}=${answer[1].answer}, confidence ${answer[1].confidence.toFixed(2)})`;
  return `${PREFIX} ${res.policy} policy: ${res.action}${detail}. Decision ${res.decisionId}.`;
}

function preToolUseOutput(harness: HookHarness, res: DecideResponse): string {
  if (res.action === 'deny') {
    return preToolUse('deny', reasonOf(res));
  }
  // Codex rejects `ask` (and `allow` without `updatedInput`) from PreToolUse: deny-only there.
  if (res.action === 'ask' && harness === 'claude') {
    return preToolUse('ask', reasonOf(res));
  }
  return '';
}

/** Translate a gateway answer for an event. `null` (gateway down, slow, error) → abstain. */
export function translate(
  harness: HookHarness,
  event: HookEvent,
  res: DecideResponse | null,
): string {
  if (res === null || !res.enforced) {
    return '';
  }
  if (event === 'PreToolUse') {
    return preToolUseOutput(harness, res);
  }
  if (event === 'PermissionRequest') {
    // v1 never denies from the model: anything but an enforced allow leaves the normal prompt
    // (Claude) or the auto-reviewer (Codex) in charge.
    return res.action === 'allow' ? permissionAllow() : '';
  }
  if (event === 'UserPromptSubmit' && res.action.startsWith('route:')) {
    return routingContext(res.action.slice('route:'.length));
  }
  // Stop is log only: any Stop output would continue the turn.
  return '';
}
