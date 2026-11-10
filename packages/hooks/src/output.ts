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

/** Model ids from config.yaml are quoted into model-facing text: keep them to id characters. */
const MODEL_ID = /^[\w.:@+/[\]-]{1,200}$/;

/**
 * Neither harness lets a hook switch the session's model, so the mapped model
 * (`routing.presets.<harness>` in config.yaml) becomes advice: Claude Code can pass it to the
 * subagents it starts, and the user can switch with `/model`.
 */
function routingAdvice(harness: HookHarness, model: string): string {
  return harness === 'claude'
    ? ` Start subagents for it with model "${model}"; to run this session on it, the user can type /model ${model}.`
    : ` To run this session on it, the user can type /model and pick ${model}.`;
}

function routingContext(harness: HookHarness, res: DecideResponse): string {
  const preset = res.action.slice('route:'.length);
  const model = res.route?.model;
  const mapped = model !== undefined && MODEL_ID.test(model);
  const text = mapped
    ? `${PREFIX}: routing suggests the "${preset}" preset (model ${model}) for this task.${routingAdvice(harness, model)}`
    : `${PREFIX}: routing suggests the "${preset}" model preset for this task.`;
  return json({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
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
    return routingContext(harness, res);
  }
  // Stop is log only: any Stop output would continue the turn.
  return '';
}
