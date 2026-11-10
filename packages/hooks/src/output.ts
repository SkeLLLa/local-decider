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

/** Thinking levels (`low` … `max`) are quoted into model-facing text too: a short, plain id. */
const THINKING_LEVEL = /^[a-z][a-z0-9-]{0,30}$/;

/** A validated model target; `thinking` is dropped when it is not a plain level id. */
interface Advice {
  readonly model: string;
  readonly thinking?: string;
}

function adviceOf(res: DecideResponse): Advice | undefined {
  const model = res.route?.model;
  if (model === undefined || !MODEL_ID.test(model)) {
    return undefined;
  }
  const thinking = res.route?.thinking;
  return thinking !== undefined && THINKING_LEVEL.test(thinking) ? { model, thinking } : { model };
}

/** `(model opus, effort high)` for Claude Code, `(model x, reasoning high)` for Codex. */
function targetLabel(harness: HookHarness, advice: Advice): string {
  if (advice.thinking === undefined) {
    return `model ${advice.model}`;
  }
  const kind = harness === 'claude' ? 'effort' : 'reasoning';
  return `model ${advice.model}, ${kind} ${advice.thinking}`;
}

/**
 * Neither harness lets a hook switch the session's model, so the mapped model
 * (`routing.presets.<harness>` in config.yaml) becomes advice: Claude Code can pass it to the
 * subagents it starts (they take no effort parameter), and the user can switch with `/model` and
 * the harness's effort or reasoning controls.
 */
function routingAdvice(harness: HookHarness, { model, thinking }: Advice): string {
  if (harness === 'claude') {
    const effort = thinking === undefined ? '' : ` and set effort ${thinking}`;
    return ` Start subagents for it with model "${model}"; to run this session on it, the user can type /model ${model}${effort}.`;
  }
  const reasoning = thinking === undefined ? '' : ` with ${thinking} reasoning`;
  return ` To run this session on it, the user can type /model and pick ${model}${reasoning}.`;
}

function routingContext(harness: HookHarness, res: DecideResponse): string {
  const preset = res.action.slice('route:'.length);
  const advice = adviceOf(res);
  const text =
    advice === undefined
      ? `${PREFIX}: routing suggests the "${preset}" model preset for this task.`
      : `${PREFIX}: routing suggests the "${preset}" preset (${targetLabel(harness, advice)}) for this task.${routingAdvice(harness, advice)}`;
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
