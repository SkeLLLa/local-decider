/**
 * The mod's pure decisions: when a plain `ask` may be upgraded, which calls the local decider
 * never gets to allow, and how a refused call reads. No I/O, no `node:` imports.
 */
import { asRecord, resolveSegments, type DecideResponse } from '@ziptie-soft/local-decider-core';

import { baseName, commandWords, splitShell, type Segment } from '../shell.ts';
import type { ToolCallResult, ToolCheckEvent, ToolCheckResult } from './types.ts';

/** First Claude Code release whose mod API has what this mod relies on (`agentId`, `ceiling`). */
const MIN_VERSION = '2.1.304';

const CALL_ID = /^[\w-]{1,128}$/;

/** Numeric compare of dotted versions (`2.1.319` ≥ `2.1.304`); anything unparsable is too old. */
export function versionAtLeast(version: unknown, min: string = MIN_VERSION): boolean {
  const base =
    typeof version === 'object' && version !== null ? asRecord(version)?.['base'] : version;
  if (typeof base !== 'string' || !/^\d+(?:\.\d+)*$/.test(base)) {
    return false;
  }
  const have = base.split('.').map(Number);
  const want = min.split('.').map(Number);
  for (let i = 0; i < Math.max(have.length, want.length); i += 1) {
    const diff = (have[i] ?? 0) - (want[i] ?? 0);
    if (diff !== 0) {
      return diff > 0;
    }
  }
  return true;
}

/**
 * An `ask` that nothing but the default permission flow produced: not an ask rule, a PreToolUse
 * hook, a setting, a host asker or a ceiling, and from the engine itself, not another mod.
 */
export function isPlainAsk(
  e: ToolCheckEvent,
  decided: ToolCheckResult,
  origin: { readonly plugin?: string } | undefined,
): boolean {
  return (
    decided.decision === 'ask' &&
    decided.rule === undefined &&
    decided.hook === undefined &&
    decided.setting === undefined &&
    decided.decider === undefined &&
    decided.ceiling === undefined &&
    e.ceiling !== 'ask' &&
    typeof e.tool_use_id === 'string' &&
    CALL_ID.test(e.tool_use_id) &&
    origin?.plugin === 'engine'
  );
}

/** The gateway's `GET /v1/calls/:id` body, as far as the mod reads it. */
export interface CallInfo {
  readonly permissionMode?: string;
  readonly decisions?: Readonly<
    Record<string, { readonly action?: string; readonly answered?: boolean } | undefined>
  >;
  readonly scopes?: Readonly<Record<string, string | undefined>>;
}

/**
 * Auto mode only (a mod allow would also run commands in `dontAsk` mode) and only when the
 * command-risk policy answered and found nothing to flag. A missing record never allows.
 */
export function callAllows(call: CallInfo | null): boolean {
  if (call?.permissionMode !== 'auto') {
    return false;
  }
  const risk = call.decisions?.['command-risk'];
  return risk?.answered === true && risk.action === 'log';
}

/** Whether this call may be allowed (not just shadowed): act mode for the scope, no subagent. */
export function mayAct(call: CallInfo, e: ToolCheckEvent): boolean {
  return call.scopes?.['claude-auto'] === 'act' && e.agentId === undefined;
}

export function reasonOf(res: Pick<DecideResponse, 'policy' | 'decisionId'>): string {
  return `local-decider ${res.policy} allowed this (decision ${res.decisionId})`;
}

/** Text starts of the refusal that the auto mode classifier itself issued. */
export const CLASSIFIER_DENIAL_PREFIXES: readonly string[] = [
  'Permission for this action was denied by the Claude Code auto mode classifier',
];

/**
 * Refusals that say nothing about the classifier's verdict: its fallback, plain permission asks,
 * and the classifier giving no verdict (a PreToolUse hook rewrote the input after its review).
 */
export const UNDECIDED_PREFIXES: readonly string[] = [
  'This command requires approval',
  'Claude requested permissions to use',
  'Permission to use',
  'The server-side auto mode classifier gave no verdict',
];

/** Phrases that mark an undecided refusal wherever they sit in the first part of the text. */
const UNDECIDED_PHRASES: readonly string[] = [
  "you haven't granted it yet",
  'classifier gave no verdict',
];

const PHRASE_WINDOW = 300;

function refusalText(result: ToolCallResult): string | undefined {
  const text = typeof result.text === 'string' ? result.text : result.result;
  return typeof text === 'string' ? text.replace(/^Error:\s*/, '') : undefined;
}

/**
 * What the auto mode classifier decided about a call, from the result of `tool.call`:
 * `deny` for its denial text, `null` when the permission outcome is unknown (its fallback prompt,
 * any other permission refusal), else `allow` (the tool ran, even if it then failed).
 */
export function classifierVerdict(result: unknown): 'allow' | 'deny' | null {
  const fields = asRecord(result);
  if (fields === undefined) {
    return null;
  }
  if (fields['isError'] !== true) {
    return 'allow';
  }
  const text = refusalText(fields) ?? '';
  if (CLASSIFIER_DENIAL_PREFIXES.some((p) => text.startsWith(p))) {
    return 'deny';
  }
  const head = text.slice(0, PHRASE_WINDOW);
  const undecided =
    UNDECIDED_PREFIXES.some((p) => text.startsWith(p)) ||
    UNDECIDED_PHRASES.some((p) => head.includes(p));
  return undecided ? null : 'allow';
}

/** Path-bearing tools and the input fields that name the path. */
const PATH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;

const PROTECTED_DIRS = new Set(['.git', '.claude', '.vscode', '.idea', '.husky']);
const PROTECTED_FILES = new Set([
  '.mcp.json',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.cshrc',
  '.kshrc',
  'config.fish',
]);

/** Segments of `path` under `cwd`, or null when it resolves outside. */
function insideCwd(cwd: string, path: string): string[] | null {
  const base = resolveSegments('', cwd);
  const target = resolveSegments(cwd, path);
  const inside = base.every((part, i) => target[i] === part);
  return inside ? target.slice(base.length) : null;
}

function isProtected(relative: readonly string[]): boolean {
  const name = relative.at(-1) ?? '';
  return (
    relative.some((part) => PROTECTED_DIRS.has(part)) ||
    PROTECTED_FILES.has(name) ||
    name === '.env' ||
    name.startsWith('.env.')
  );
}

/** A reason when `path` is outside the working directory or a protected file; else null. */
function pathBlock(cwd: string, path: string): string | null {
  if (path === '' || path === '/dev/null') {
    return null;
  }
  const relative = insideCwd(cwd, path);
  if (relative === null) {
    return `path outside the working directory: ${path}`;
  }
  return isProtected(relative) ? `protected path: ${path}` : null;
}

function filePathBlock(input: unknown, cwd: string): string | null {
  const fields = asRecord(input);
  const paths = PATH_FIELDS.map((k) => fields?.[k]).filter((v) => v !== undefined);
  if (paths.length === 0) {
    return 'no file path';
  }
  for (const path of paths) {
    const block = typeof path === 'string' ? pathBlock(cwd, path) : 'unreadable file path';
    if (block !== null) {
      return block;
    }
  }
  return null;
}

/** Commands that reach the network, other machines, containers, or hosted services. */
const BLOCKED_COMMANDS = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'nc',
  'ncat',
  'netcat',
  'sudo',
  'doas',
  'docker',
  'podman',
  'kubectl',
  'gh',
  'eval',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Constructs the splitter cannot see through: substitutions, process substitution. */
const OPAQUE = /\$\(|`|<\(|>\(/;
const RECURSIVE_FLAG = /^-[a-zA-Z]*[rR]/;

function commandBlock(command: string, args: readonly string[]): string | null {
  if (BLOCKED_COMMANDS.has(command)) {
    return `${command} is never allowed here`;
  }
  const flags = args.filter((a) => a.startsWith('-'));
  const reasons: [boolean, string][] = [
    [command === 'git' && args.includes('push'), 'git push'],
    [PUBLISHERS.has(command) && args.includes('publish'), `${command} publish`],
    [command === 'rm' && flags.some((f) => RECURSIVE_FLAG.test(f) || f === '--recursive'), 'rm -r'],
    [SHELLS.has(command) && flags.some((f) => /^-[a-zA-Z]*c/.test(f)), `${command} -c script`],
  ];
  return reasons.find(([hit]) => hit)?.[1] ?? null;
}

/** The path a word names, with `>file`, `--out=/x` and `-C/x` shapes unwrapped; null when it names none. */
function wordPath(word: string): string | null | undefined {
  const bare = word.replace(/^\d*>{1,2}/, '').replace(/^--?[\w-]+=/, '');
  if (bare === '' || bare.startsWith('-')) {
    return undefined;
  }
  if (/^[~$]/.test(bare)) {
    return null;
  }
  return bare.startsWith('/') || bare.startsWith('.') || bare.includes('/') ? bare : undefined;
}

function wordsBlock(words: readonly string[], cwd: string): string | null {
  for (const word of words) {
    const path = wordPath(word);
    if (path === null) {
      return `unresolved path: ${word}`;
    }
    const block = path === undefined ? null : pathBlock(cwd, path);
    if (block !== null) {
      return block;
    }
  }
  return null;
}

function segmentBlock(segment: Segment, cwd: string): string | null {
  const words = commandWords(segment.words);
  // `sudo`/`doas` are stripped as prefixes to find the real command; they still block.
  const prefixes = segment.words.slice(0, segment.words.length - words.length).map(baseName);
  const elevated = prefixes.find((p) => p === 'sudo' || p === 'doas');
  const command = baseName(words[0] ?? '');
  const args = words.slice(1);
  return (
    (elevated === undefined ? null : `${elevated} is never allowed here`) ??
    commandBlock(command, args) ??
    wordsBlock(args, cwd)
  );
}

function bashBlock(input: unknown, cwd: string): string | null {
  const command = asRecord(input)?.['command'];
  if (typeof command !== 'string' || command.trim() === '') {
    return 'no command';
  }
  if (OPAQUE.test(command)) {
    return 'command substitution';
  }
  for (const segment of splitShell(command)) {
    const block = segmentBlock(segment, cwd);
    if (block !== null) {
      return block;
    }
  }
  return null;
}

/**
 * Why the local decider must not be asked to allow this call (the classifier decides instead), or
 * null. Claude Code's own path-safety asks carry no field the mod can read, so this is where
 * paths outside the working directory and in protected places are kept away from an allow.
 */
export function deterministicBlock(tool: string, input: unknown, cwd: string): string | null {
  if (tool === 'Bash') {
    return bashBlock(input, cwd);
  }
  return PATH_TOOLS.has(tool) ? filePathBlock(input, cwd) : `tool ${tool} is not covered`;
}
