import { canonicalJson } from '@local-decider/core';
/**
 * Event → policy mapping. Each hook event becomes one gateway policy call whose input keys match
 * the policy's `state.sections[].from` (see policies/*.yaml).
 */
import { basename, relative, resolve } from 'node:path';

import {
  firstUserText,
  historyText,
  lastUserText,
  lastAssistantText,
  parseTurns,
  taskText,
  type TranscriptSlice,
  type Turn,
} from './transcript.ts';

const HOOK_HARNESSES = ['claude', 'codex'] as const;
export type HookHarness = (typeof HOOK_HARNESSES)[number];

const HOOK_EVENTS = ['PreToolUse', 'PermissionRequest', 'Stop', 'UserPromptSubmit'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookInput = Readonly<Record<string, unknown>>;

/** The gateway policy each hook event runs. */
export const EVENT_POLICY: Readonly<Record<HookEvent, string>> = {
  PreToolUse: 'command-risk',
  PermissionRequest: 'permission',
  Stop: 'turn-outcome',
  UserPromptSubmit: 'routing',
};

export interface PolicyCall {
  readonly policy: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export type ReadTranscript = (path: string) => TranscriptSlice | null;

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Accept `PreToolUse` and `pre-tool-use` spellings. */
export function parseEvent(name: string): HookEvent | undefined {
  const pascal = name.replace(/(?:^|[-_])([a-z])/g, (_m, c: string) => c.toUpperCase());
  return HOOK_EVENTS.find((e) => e === pascal);
}

export function parseHarness(name: string): HookHarness | undefined {
  return HOOK_HARNESSES.find((h) => h === name);
}

function projectOf(hook: HookInput): string | undefined {
  const cwd = str(hook['cwd']);
  return cwd === undefined ? undefined : `${basename(cwd)} (${cwd})`;
}

/**
 * The shell command a tool call runs: Bash (`command` string or argv array), Codex `apply_patch`
 * (patch text in `command`), else `undefined`.
 */
export function commandOf(hook: HookInput): string | undefined {
  const toolInput = hook['tool_input'];
  if (typeof toolInput !== 'object' || toolInput === null) {
    return undefined;
  }
  const command = (toolInput as Record<string, unknown>)['command'];
  if (Array.isArray(command)) {
    return command.filter((c) => typeof c === 'string').join(' ');
  }
  return str(command);
}

/** Tools whose `command` is file content, not a shell command. */
export function isShellTool(hook: HookInput): boolean {
  const tool = str(hook['tool_name']) ?? '';
  return tool !== 'apply_patch' && !/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(tool);
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== ''));
}

class Transcript {
  readonly #path: string | undefined;
  readonly #read: ReadTranscript;
  #slice: TranscriptSlice | null | undefined;

  constructor(path: string | undefined, read: ReadTranscript) {
    this.#path = path;
    this.#read = read;
  }

  #get(): TranscriptSlice | null {
    if (this.#slice === undefined) {
      this.#slice = this.#path === undefined ? null : this.#read(this.#path);
    }
    return this.#slice;
  }

  tail(): Turn[] {
    return parseTurns(this.#get()?.tail ?? '');
  }

  head(): Turn[] {
    return parseTurns(this.#get()?.head ?? '');
  }
}

function permissionInput(hook: HookInput, t: Transcript): Record<string, unknown> {
  const head = t.head();
  const tail = t.tail();
  const subject = permissionSubject(hook);
  return {
    project: projectOf(hook),
    history: historyText(tail),
    task: taskText(firstUserText(head), lastUserText(tail)),
    tool: str(hook['tool_name']),
    request: hook['tool_input'],
    ...(subject === undefined ? {} : { subject }),
  };
}

function permissionSubject(hook: HookInput): string | undefined {
  const tool = str(hook['tool_name']);
  if (tool === undefined) {
    return undefined;
  }
  const input = hook['tool_input'];
  const fields = asRecord(input);
  const command = isShellTool(hook) ? commandOf(hook) : undefined;
  const path = firstString(fields, ['file_path', 'filePath', 'path']);
  const url = firstString(fields, ['url']);
  const cwd = str(hook['cwd']) ?? '';
  const value =
    command !== undefined
      ? stripCwd(command, cwd)
      : path !== undefined
        ? relative(cwd, resolve(cwd, path)).replaceAll('\\', '/')
        : (url ?? stableToolInput(input));
  return collapse(`${tool}: ${value}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
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

function stableToolInput(value: unknown): string {
  const fields = asRecord(value);
  if (fields === undefined) {
    return canonicalJson(value) ?? '';
  }
  const input = { ...fields };
  delete input['description'];
  return canonicalJson(input);
}

function stripCwd(command: string, cwd: string): string {
  const line = collapse(command);
  const prefix = `cd ${collapse(cwd)} && `;
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function commandRiskInput(hook: HookInput): Record<string, unknown> {
  return {
    project: projectOf(hook),
    tool: str(hook['tool_name']),
    command: commandOf(hook) ?? hook['tool_input'],
  };
}

function turnOutcomeInput(hook: HookInput, t: Transcript): Record<string, unknown> {
  const tail = t.tail();
  return {
    task: firstUserText(t.head()),
    history: historyText(tail),
    lastMessage: str(hook['last_assistant_message']) ?? lastAssistantText(tail),
  };
}

function routingInput(hook: HookInput): Record<string, unknown> {
  return { project: projectOf(hook), prompt: str(hook['prompt']) };
}

type InputBuilder = (hook: HookInput, t: Transcript) => Record<string, unknown>;

const BUILDERS: Record<HookEvent, InputBuilder> = {
  PreToolUse: (hook) => commandRiskInput(hook),
  PermissionRequest: permissionInput,
  Stop: turnOutcomeInput,
  UserPromptSubmit: (hook) => routingInput(hook),
};

/** Build the gateway call for an event. Transcript reads happen only for policies that use them. */
export function mapEvent(event: HookEvent, hook: HookInput, read: ReadTranscript): PolicyCall {
  const input = BUILDERS[event](hook, new Transcript(str(hook['transcript_path']), read));
  return { policy: EVENT_POLICY[event], input: compact(input) };
}
