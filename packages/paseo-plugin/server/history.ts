/**
 * Shapes Paseo timeline items and requests into the bounded, structured inputs the gateway's
 * policies expect. Pure: no I/O. The gateway redacts and truncates again; these bounds only keep
 * requests small.
 */
import type { AgentPermissionRequest, AgentTimelineItem } from '@getpaseo/protocol/agent-types';

export const LIMITS = {
  line: 600,
  task: 4000,
  history: 12_000,
  lastMessage: 4000,
  request: 6000,
  prompt: 6000,
} as const;

export interface TimelineEntryLike {
  readonly item: AgentTimelineItem;
  readonly turnId?: string | undefined;
}

export interface TurnInput {
  readonly task: string;
  readonly history: string;
  readonly lastMessage: string;
}

/** Keep the head of `text` within `max` characters. */
export function head(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Keep the tail of `text` within `max` characters (most recent last). */
export function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - Math.max(0, max - 1))}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function toolLine(item: Extract<AgentTimelineItem, { type: 'tool_call' }>): string {
  return `tool ${item.name} (${item.status})`;
}

/** One transcript line per item, or null for items that carry no conversational signal. */
function itemLine(item: AgentTimelineItem): string | null {
  switch (item.type) {
    case 'user_message':
      return `user: ${head(oneLine(item.text), LIMITS.line)}`;
    case 'assistant_message':
      return `assistant: ${head(oneLine(item.text), LIMITS.line)}`;
    case 'tool_call':
      return toolLine(item);
    case 'error':
      return `error: ${head(oneLine(item.message), LIMITS.line)}`;
    case 'notification':
      return `${item.level}: ${head(oneLine(item.message), LIMITS.line)}`;
    default:
      return null;
  }
}

/**
 * Merge consecutive assistant chunks (streamed text can arrive as several items with the same
 * `messageId`) so the transcript and the final message read as whole messages.
 */
export function mergeAssistantChunks(items: readonly AgentTimelineItem[]): AgentTimelineItem[] {
  const out: AgentTimelineItem[] = [];
  for (const item of items) {
    const prev = out.at(-1);
    if (
      item.type === 'assistant_message' &&
      prev?.type === 'assistant_message' &&
      (prev.messageId === undefined ||
        item.messageId === undefined ||
        prev.messageId === item.messageId)
    ) {
      out[out.length - 1] = { ...prev, text: prev.text + item.text };
      continue;
    }
    out.push(item);
  }
  return out;
}

/** Items of the turn: the entries tagged with `turnId`, else everything after the last user message. */
export function turnItems(
  entries: readonly TimelineEntryLike[],
  turnId: string | null,
): AgentTimelineItem[] {
  const tagged = turnId === null ? [] : entries.filter((e) => e.turnId === turnId);
  if (tagged.length > 0) {
    return tagged.map((e) => e.item);
  }
  const items = entries.map((e) => e.item);
  let start = 0;
  items.forEach((item, i) => {
    if (item.type === 'user_message') {
      start = i;
    }
  });
  return items.slice(start);
}

function lastOfType<T extends AgentTimelineItem['type']>(
  items: readonly AgentTimelineItem[],
  type: T,
): Extract<AgentTimelineItem, { type: T }> | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.type === type) {
      return item as Extract<AgentTimelineItem, { type: T }>;
    }
  }
  return undefined;
}

export function transcript(items: readonly AgentTimelineItem[], max: number): string {
  const lines = items.map(itemLine).filter((l): l is string => l !== null);
  return tail(lines.join('\n'), max);
}

/** `{task, history, lastMessage}` for `turn-outcome`; null when the turn has no assistant output. */
export function buildTurnInput(
  entries: readonly TimelineEntryLike[],
  turnId: string | null,
): TurnInput | null {
  const all = mergeAssistantChunks(entries.map((e) => e.item));
  const turn = mergeAssistantChunks(turnItems(entries, turnId));
  const last = lastOfType(turn, 'assistant_message') ?? lastOfType(turn, 'error');
  if (last === undefined) {
    return null;
  }
  const task = lastOfType(turn, 'user_message') ?? lastOfType(all, 'user_message');
  const lastText = last.type === 'assistant_message' ? last.text : `error: ${last.message}`;
  return {
    task: head(task?.text.trim() ?? '', LIMITS.task),
    history: transcript(turn, LIMITS.history),
    lastMessage: tail(lastText.trim(), LIMITS.lastMessage),
  };
}

function safeJson(value: unknown, max: number): string {
  try {
    return head(JSON.stringify(value) ?? '', max);
  } catch {
    return '';
  }
}

export interface PermissionInput {
  readonly project: string;
  readonly history: string;
  readonly tool: string;
  readonly request: string;
}

export function buildPermissionInput(
  cwd: string,
  history: string,
  request: AgentPermissionRequest,
): PermissionInput {
  const tool = [request.name, request.kind, request.title].filter(Boolean).join(' · ');
  const body = {
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(request.input === undefined ? {} : { input: request.input }),
    ...(request.detail === undefined ? {} : { detail: request.detail }),
  };
  return {
    project: head(cwd, 500),
    history: tail(history, LIMITS.history / 2),
    tool: head(tool, 500),
    request: safeJson(body, LIMITS.request),
  };
}

export interface RoutingInput {
  readonly project: string;
  readonly prompt: string;
}

/**
 * `{project, prompt}` for `routing`. Paseo 0.15.3's `agent.create.before` does not carry the
 * first prompt, so the agent title is the only task text available; null when there is none.
 */
export function buildRoutingInput(
  cwd: string,
  title: string | null | undefined,
): RoutingInput | null {
  const prompt = (title ?? '').trim();
  if (prompt === '') {
    return null;
  }
  return { project: head(cwd, 500), prompt: head(prompt, LIMITS.prompt) };
}
