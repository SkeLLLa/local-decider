/**
 * Event → policy mapping. Each hook event becomes one gateway policy call whose input keys match
 * the policy's `state.sections[].from` (see policies/*.yaml).
 */
import {
  commandOf,
  permissionSubject,
  PERMISSION_MODES,
  str,
  type DecideCall,
  type HookInput,
  type PermissionMode,
} from '@ziptie-soft/local-decider-core';

import { permissionInput, projectLabel } from './permission-input.ts';
import { parseTurns, type TranscriptSlice } from './transcript.ts';
import { firstUserText, historyText, lastAssistantText, type Turn } from './turns.ts';

const HOOK_HARNESSES = ['claude', 'codex'] as const;
export type HookHarness = (typeof HOOK_HARNESSES)[number];

const HOOK_EVENTS = ['PreToolUse', 'PermissionRequest', 'Stop', 'UserPromptSubmit'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

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
  return cwd === undefined ? undefined : projectLabel(cwd);
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

function permissionHookInput(hook: HookInput, t: Transcript): Record<string, unknown> {
  return permissionInput({
    cwd: str(hook['cwd']),
    tool: str(hook['tool_name']),
    request: hook['tool_input'],
    subject: permissionSubject(hook),
    head: t.head(),
    tail: t.tail(),
  });
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
  PermissionRequest: permissionHookInput,
  Stop: turnOutcomeInput,
  UserPromptSubmit: (hook) => routingInput(hook),
};

const CALL_ID = /^[\w-]{1,128}$/;

/**
 * The Claude Code tool call a PreToolUse event is about (`tool_use_id`, `permission_mode`), so the
 * gateway can serve it to other callers; absent or malformed values are left out.
 */
export function callOf(
  harness: HookHarness,
  event: HookEvent,
  hook: HookInput,
): DecideCall | undefined {
  const id = str(hook['tool_use_id']);
  if (harness !== 'claude' || event !== 'PreToolUse' || id === undefined || !CALL_ID.test(id)) {
    return undefined;
  }
  const mode = hook['permission_mode'];
  const permissionMode = (PERMISSION_MODES as readonly unknown[]).includes(mode)
    ? (mode as PermissionMode)
    : undefined;
  return { id, ...(permissionMode === undefined ? {} : { permissionMode }) };
}

/** Build the gateway call for an event. Transcript reads happen only for policies that use them. */
export function mapEvent(event: HookEvent, hook: HookInput, read: ReadTranscript): PolicyCall {
  const input = BUILDERS[event](hook, new Transcript(str(hook['transcript_path']), read));
  return { policy: EVENT_POLICY[event], input: compact(input) };
}
