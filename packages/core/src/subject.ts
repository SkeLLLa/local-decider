/**
 * What a tool call is, as one stable line (`Bash: npm test`, `Edit: src/a.ts`): the precedent
 * subject and the shell-command helpers behind it. No `node:` imports, so a Claude Code mod can
 * bundle it; paths use the small POSIX helpers below.
 */
import { canonicalJson } from './canonical.ts';

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

/** Build the shared, cross-harness subject from native tool metadata. */
export function canonicalSubject(
  tool: string,
  toolInput: unknown,
  cwd: string | undefined,
): string | undefined {
  const fields = validSubjectFields(tool, toolInput, cwd);
  if (fields === undefined || cwd === undefined) return undefined;
  const mapped = canonicalTool(tool);
  const command = subjectCommand(mapped, toolInput);
  const rawPath = firstString(fields, SUBJECT_PATH_FIELDS);
  if (!hasRequiredSubject(mapped, tool, fields, rawPath, command)) return undefined;
  return subjectLine({
    tool: mapped,
    cwd,
    input: toolInput,
    command,
    path: rawPath,
    url: firstString(fields, SUBJECT_URL_FIELDS),
  });
}

const SUBJECT_PATH_FIELDS = ['file_path', 'filePath', 'notebook_path', 'path'] as const;
const SUBJECT_URL_FIELDS = ['url'] as const;

function validSubjectFields(
  tool: string,
  toolInput: unknown,
  cwd: string | undefined,
): Record<string, unknown> | undefined {
  if (tool.trim() !== tool || tool === '' || cwd === undefined || cwd.trim() === '') {
    return undefined;
  }
  const fields = asRecord(toolInput);
  return fields !== undefined && validPathFields(fields) ? fields : undefined;
}

function validPathFields(fields: Record<string, unknown>): boolean {
  return SUBJECT_PATH_FIELDS.every((key) => {
    const value = fields[key];
    return value === undefined || (typeof value === 'string' && value !== '');
  });
}

function subjectCommand(mapped: string, toolInput: unknown): string | undefined {
  if (mapped !== 'shell') return undefined;
  const command = commandOf({ tool_input: toolInput });
  return command === undefined || command.trim() === '' ? undefined : command;
}

function hasRequiredSubject(
  mapped: string,
  tool: string,
  fields: Record<string, unknown>,
  path: string | undefined,
  command: string | undefined,
): boolean {
  if (mapped === 'shell') return command !== undefined;
  if (mapped !== 'edit' && mapped !== 'notebook') return true;
  return path !== undefined || (tool === 'apply_patch' && typeof fields['command'] === 'string');
}

function canonicalTool(tool: string): string {
  if (['Bash', 'shell', 'exec_command'].includes(tool)) return 'shell';
  if (['Edit', 'Write', 'MultiEdit', 'apply_patch'].includes(tool)) return 'edit';
  if (tool === 'NotebookEdit') return 'notebook';
  if (!tool.startsWith('mcp__')) return tool;
  const rest = tool.slice(5);
  const separator = rest.indexOf('__', 1);
  return separator > 0 && separator + 2 < rest.length
    ? `mcp:${rest.slice(0, separator)}:${rest.slice(separator + 2)}`
    : tool;
}

export interface SubjectParts {
  readonly tool: string;
  readonly cwd: string;
  /** The raw tool input, used only when there is no command, path or url. */
  readonly input: unknown;
  readonly command?: string | undefined;
  readonly path?: string | undefined;
  readonly url?: string | undefined;
}

/** `Tool: value` from already-extracted parts: command (cwd prefix dropped), cwd-relative path, url, else stable input. */
export function subjectLine(parts: SubjectParts): string {
  const { tool, cwd, input, command, path, url } = parts;
  const value =
    command !== undefined
      ? stripCwd(command, cwd)
      : path !== undefined
        ? posixRelative(cwd, path).replaceAll('\\', '/')
        : (url ?? stableToolInput(input));
  return collapse(`${tool}: ${value}`);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function firstString(
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

type Quote = '' | "'" | '"' | '`';

interface CollapseState {
  out: string;
  quote: Quote;
  escaped: boolean;
  pendingSpace: boolean;
}

function collapse(value: string): string {
  const state: CollapseState = { out: '', quote: '', escaped: false, pendingSpace: false };
  for (const char of value) {
    if (state.quote === '') appendUnquoted(char, state);
    else appendQuoted(char, state);
  }
  return state.out.trim();
}

function appendUnquoted(char: string, state: CollapseState): void {
  if (/\s/.test(char)) {
    state.pendingSpace = state.out !== '';
    return;
  }
  if (state.pendingSpace) state.out += ' ';
  state.pendingSpace = false;
  if (isQuote(char)) state.quote = char;
  state.out += char;
}

function appendQuoted(char: string, state: CollapseState): void {
  state.out += char;
  if (state.escaped) state.escaped = false;
  else if (char === '\\' && state.quote !== "'") state.escaped = true;
  else if (char === state.quote) state.quote = '';
}

function isQuote(char: string): char is Exclude<Quote, ''> {
  return char === "'" || char === '"' || char === '`';
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
export function resolveSegments(base: string, path: string): string[] {
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
