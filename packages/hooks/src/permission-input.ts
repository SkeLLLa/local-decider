import { trimTrailingSlashes } from '@ziptie-soft/local-decider-core';

/**
 * The `permission` policy's input, built the same way for the hook runner (transcript file) and the
 * Claude Code mod (`$.session.messages()`). No `node:` imports.
 */
import { firstUserText, historyText, lastUserText, taskText, type Turn } from './turns.ts';

/** `name (cwd)`: how the policies refer to the project. */
export function projectLabel(cwd: string): string {
  const name = trimTrailingSlashes(cwd).split('/').at(-1) ?? '';
  return `${name === '' ? cwd : name} (${cwd})`;
}

export interface PermissionParts {
  readonly cwd?: string | undefined;
  readonly tool?: string | undefined;
  readonly request: unknown;
  readonly subject?: string | undefined;
  /** The start of the conversation (for the first request) and its recent end (history, latest). */
  readonly head: readonly Turn[];
  readonly tail: readonly Turn[];
}

/** Keys the policy's `state.sections` read; empty values are left out. */
export function permissionInput(parts: PermissionParts): Record<string, unknown> {
  const input: Record<string, unknown> = {
    project: parts.cwd === undefined ? undefined : projectLabel(parts.cwd),
    history: historyText(parts.tail),
    task: taskText(firstUserText(parts.head), lastUserText(parts.tail)),
    tool: parts.tool,
    request: parts.request,
    subject: parts.subject,
  };
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== ''));
}
