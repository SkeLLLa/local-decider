/**
 * Conversation turns as the permission policy wants them: recent history and the task. No `node:`
 * imports, so the Claude Code mod bundles it next to the hook runner.
 */
export interface Turn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

const HISTORY_CHARS = 8000;
const TURN_CHARS = 1500;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function clipTask(text: string): string {
  return text.length <= TURN_CHARS ? text : `${text.slice(0, TURN_CHARS - 1)}…`;
}

/** Recent turns as `User: …` / `Assistant: …` lines, newest last, bounded in size. */
export function historyText(turns: readonly Turn[], maxChars: number = HISTORY_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0 && used < maxChars; i--) {
    const turn = turns[i];
    if (turn !== undefined) {
      const line = `${turn.role === 'user' ? 'User' : 'Assistant'}: ${clip(turn.text, TURN_CHARS)}`;
      lines.unshift(line);
      used += line.length + 1;
    }
  }
  return lines.join('\n');
}

export function firstUserText(turns: readonly Turn[]): string | undefined {
  return turns.find((t) => t.role === 'user')?.text;
}

export function lastUserText(turns: readonly Turn[]): string | undefined {
  return turns.findLast((t) => t.role === 'user')?.text;
}

/** Format the first request and any later user steering for a permission decision. */
export function taskText(
  first: string | undefined,
  latest: string | undefined,
): string | undefined {
  const initial = first?.trim() ?? '';
  const current = latest?.trim() ?? '';
  if (initial === '' && current === '') {
    return undefined;
  }
  const lines: string[] = [];
  if (initial !== '') {
    lines.push(`First request: ${clipTask(initial)}`);
  }
  if (current !== '' && current !== initial) {
    lines.push(`Latest request: ${clipTask(current)}`);
  }
  return lines.join('\n');
}

export function lastAssistantText(turns: readonly Turn[]): string | undefined {
  return turns.findLast((t) => t.role === 'assistant')?.text;
}
