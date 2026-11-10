/**
 * Shapes Paseo timeline items and requests into the bounded, structured inputs the gateway's
 * policies expect. Pure: no I/O. The gateway redacts and truncates again; these bounds only keep
 * requests small.
 */
import type {
  AgentPermissionRequest,
  AgentTimelineItem,
  ToolCallDetail,
} from '@getpaseo/protocol/agent-types';
import { canonicalJson } from '@local-decider/core';
import { relative, resolve } from 'node:path';

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

export interface RecentContext {
  readonly task: string;
  readonly history: string;
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

function detailSummary(detail: ToolCallDetail | undefined): string {
  if (detail === undefined) {
    return '';
  }
  let value: string | undefined;
  switch (detail.type) {
    case 'shell':
      value = detail.command;
      break;
    case 'read':
    case 'edit':
    case 'write':
      value = detail.filePath;
      break;
    case 'search':
      value = detail.query;
      break;
    case 'fetch':
      value = detail.url;
      break;
    case 'sub_agent':
      value = detail.description;
      break;
    case 'plain_text':
      value = detail.label;
      break;
    default:
      return '';
  }
  return head(oneLine(value ?? ''), 200);
}

function toolLine(item: Extract<AgentTimelineItem, { type: 'tool_call' }>): string {
  const summary = detailSummary(item.detail);
  return `tool ${item.name} (${item.status})${summary === '' ? '' : `: ${summary}`}`;
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

export function firstOfType<T extends AgentTimelineItem['type']>(
  items: readonly AgentTimelineItem[],
  type: T,
): Extract<AgentTimelineItem, { type: T }> | undefined {
  for (const item of items) {
    if (item.type === type) {
      return item as Extract<AgentTimelineItem, { type: T }>;
    }
  }
  return undefined;
}

/** First and latest user requests in the fetched window, or the agent title when none were seen. */
export function taskText(
  items: readonly AgentTimelineItem[],
  firstKnown: string | undefined,
  title: string | null | undefined,
): string {
  const first = firstKnown?.trim() || firstOfType(items, 'user_message')?.text.trim() || '';
  if (first === '') {
    const fallback = (title ?? '').trim();
    return fallback === '' ? '' : `Agent title: ${head(fallback, 1500)}`;
  }
  const initial = `First request: ${head(first, 1500)}`;
  const latest = lastOfType(items, 'user_message')?.text.trim();
  return latest === undefined || latest === '' || latest === first
    ? initial
    : `${initial}\nLatest request: ${head(latest, 1500)}`;
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
  readonly task: string;
  readonly tool: string;
  readonly request: string;
  readonly subject: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === 'string' && candidate !== '') {
      return candidate;
    }
  }
  return undefined;
}

function relativePath(cwd: string, path: string): string {
  return relative(cwd, resolve(cwd, path)).replaceAll('\\', '/');
}

function stableInput(value: unknown): string {
  const fields = record(value);
  if (fields === undefined) {
    return canonicalJson(value) ?? '';
  }
  const input = { ...fields };
  delete input['description'];
  return canonicalJson(input);
}

function permissionSubject(cwd: string, request: AgentPermissionRequest): string {
  const fields = record(request.input);
  const detail = request.detail;
  const command = detail?.type === 'shell' ? detail.command : firstString(fields, ['command']);
  const detailPath =
    detail?.type === 'read' || detail?.type === 'edit' || detail?.type === 'write'
      ? detail.filePath
      : undefined;
  const path = detailPath ?? firstString(fields, ['file_path', 'filePath', 'path']);
  const url = detail?.type === 'fetch' ? detail.url : firstString(fields, ['url']);
  const value =
    command !== undefined
      ? stripCwd(command, cwd)
      : path !== undefined
        ? relativePath(cwd, path)
        : (url ?? stableInput(request.input));
  return oneLine(`${request.name}: ${value}`);
}

function stripCwd(command: string, cwd: string): string {
  const line = oneLine(command);
  const prefix = `cd ${oneLine(cwd)} && `;
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

export function buildPermissionInput(
  cwd: string,
  history: string,
  task: string,
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
    task: head(task, LIMITS.task),
    tool: head(tool, 500),
    request: safeJson(body, LIMITS.request),
    subject: permissionSubject(cwd, request),
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
