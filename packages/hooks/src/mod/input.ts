/**
 * The `permission` policy input for a mod call, built from `$.session.messages()` and the call
 * itself. Subagent calls get the tool and request only: `messages()` is the main conversation,
 * which is not the subagent's task.
 */
import { asRecord, firstString, subjectLine } from '@local-decider/core';

import { permissionInput } from '../permission-input.ts';
import type { Turn } from '../turns.ts';
import type { SessionMessage, ToolCheckEvent } from './types.ts';

const HEAD_TURNS = 20;
const TAIL_TURNS = 40;

/** User and assistant text turns; injected context (`<system-reminder>`, …) is not conversation. */
function turnsOf(messages: readonly SessionMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if ((message.role === 'user' || message.role === 'assistant') && text !== '') {
      if (!text.startsWith('<')) {
        turns.push({ role: message.role, text });
      }
    }
  }
  return turns;
}

function subjectOf(e: ToolCheckEvent, cwd: string): string {
  const fields = asRecord(e.input);
  return subjectLine({
    tool: e.tool,
    cwd,
    input: e.input,
    command: e.tool === 'Bash' ? firstString(fields, ['command']) : undefined,
    path: firstString(fields, ['file_path', 'notebook_path', 'path']),
    url: firstString(fields, ['url']),
  });
}

/** Messages are `undefined` for subagent calls, which never read the main conversation. */
export function buildInput(
  e: ToolCheckEvent,
  cwd: string,
  messages: readonly SessionMessage[] | undefined,
): Record<string, unknown> {
  const turns = messages === undefined ? [] : turnsOf(messages);
  return permissionInput({
    cwd,
    tool: e.tool,
    request: e.input,
    subject: subjectOf(e, cwd),
    head: turns.slice(0, HEAD_TURNS),
    tail: turns.slice(-TAIL_TURNS),
  });
}
