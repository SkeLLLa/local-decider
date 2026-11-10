// fallow-ignore-file code-duplication -- the Paseo plugin bundles its own copy (server/history.ts)
/**
 * What a tool call is, as one stable line (`Bash: npm test`, `Edit: src/a.ts`): the precedent
 * subject and the shell-command helpers behind it. No `node:` imports, so a Claude Code mod can
 * bundle it; paths use the small POSIX helpers below.
 */
import { canonicalJson } from '@local-decider/core';

export type HookInput = Readonly<Record<string, unknown>>;

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
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
    // Quoted, so an argv like ["bash", "-lc", "rm -rf /"] keeps its inline script as one word.
    return command
      .filter((c) => typeof c === 'string')
      .map(shellQuote)
      .join(' ');
  }
  return str(command);
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

function shellQuote(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", String.raw`'\''`)}'`;
}

/** Tools whose `command` is file content, not a shell command. */
export function isShellTool(hook: HookInput): boolean {
  const tool = str(hook['tool_name']) ?? '';
  return tool !== 'apply_patch' && !/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(tool);
}

export function permissionSubject(hook: HookInput): string | undefined {
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
        ? posixRelative(cwd, path).replaceAll('\\', '/')
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

/** Collapse `.`, `..` and repeated slashes of an absolute path's segments. */
function normalizeSegments(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      out.pop();
    } else if (part !== '' && part !== '.') {
      out.push(part);
    }
  }
  return out;
}

/** `path` against `base` (POSIX), as absolute segments; a relative `base` is taken from `/`. */
function resolveSegments(base: string, path: string): string[] {
  return normalizeSegments(path.startsWith('/') ? path : `/${base}/${path}`);
}

/** `path` relative to `base`, both POSIX; `path` resolves against `base` first. */
function posixRelative(base: string, path: string): string {
  const from = resolveSegments('', base);
  const to = resolveSegments(base.startsWith('/') ? base : `/${base}`, path);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common += 1;
  }
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
}
