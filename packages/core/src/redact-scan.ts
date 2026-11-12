/**
 * Linear-time value scanners for redaction. Every scanner uses one forward cursor with no length
 * cap, and every `Step` reports where the next regex search may resume so that each character is
 * scanned O(1) times per rule.
 */
const LABEL_EXACT = /^\[REDACTED:[a-z0-9-]{1,40}\]$/;

export const label = (kind: string): string => `[REDACTED:${kind}]`;
export const isLabel = (s: string): boolean => LABEL_EXACT.test(s);

export interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind: string;
}

/** `end`: where the next regex search resumes. `spans`: ordered, non-overlapping replacements. */
export interface Step {
  readonly end: number;
  readonly spans: readonly Span[];
}

/** `words`: fish list values, every shell word up to the end of the command segment. */
export type Mode = 'shell' | 'field' | 'line' | 'words';

const REF = String.raw`\$[A-Za-z_]\w{0,127}|\$\{[A-Za-z_]\w{0,127}\}|%[A-Za-z_]\w{0,127}%|\$?\{\{ ?(?:secrets|env|vars)\.[A-Za-z_]\w{0,127} ?\}\}|(?:process\.env|import\.meta\.env)\.[A-Za-z_]\w{0,127}|(?:process\.env|os\.environ)\[(["'])[A-Za-z_]\w{0,127}\1\]|os\.(?:getenv|environ\.get)\((["'])[A-Za-z_]\w{0,127}\2\)`;
const PLACEHOLDER = new RegExp(`^(?:${REF})$`);
const PLACEHOLDER_AT = new RegExp(`(?:${REF})`, 'y');
const LABEL_AT = /\[REDACTED:[a-z0-9-]{1,40}\]/y;
const SCHEME_RE = /(?:bearer|basic|token|digest|negotiate|ntlm)[ \t]+/iy;

export const isPlaceholder = (s: string): boolean => PLACEHOLDER.test(s);

const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t';
const isSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isQuote = (c: string | undefined): c is string => c === '"' || c === "'" || c === '`';

/** `text[i]` is the opening quote `q`; returns the index of the closing one or `text.length`. */
export function scanQuoted(text: string, start: number, q: string): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === q && q === "'" && text[i + 1] === "'") i += 2;
    else if (c === q) return i;
    else i++;
  }
  return text.length;
}

function backslashRun(text: string, from: number): number {
  let n = 0;
  while (text[from + n] === '\\') n++;
  return n;
}

/** `text[i..i+1]` is `\q`; returns the start of the closing `\q` or `text.length`. */
function scanEscapedQuoted(text: string, start: number, q: string): number {
  let i = start + 2;
  while (i < text.length) {
    const c = text[i];
    if (c === q) return i;
    if (c !== '\\') {
      i++;
      continue;
    }
    const n = backslashRun(text, i);
    const closes = text[i + n] === q;
    if (closes && n % 4 === 1) return i + n - 1;
    i += n + (closes ? 1 : 0);
  }
  return text.length;
}

const SHELL_STOP = ';|&()<>';

export function scanShellWord(text: string, start: number, stopChar = ''): number {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === undefined || isSpace(c) || SHELL_STOP.includes(c) || c === stopChar) break;
    if (isQuote(c)) i = scanQuoted(text, i, c) + 1;
    else if (c === '\\') i += 2;
    else i++;
  }
  return Math.min(i, text.length);
}

function trimBlanks(text: string, from: number, end: number): number {
  let e = end;
  while (e > from && isBlank(text[e - 1])) e--;
  return e;
}

/** True at the end of a value that sits inside quote context `ctx` (`"`, `'`, `\"` or `\'`). */
function quoteStop(text: string, i: number, ctx: string): boolean {
  if (ctx === '') return false;
  if (ctx.length === 2) return text[i] === '\\' && text[i + 1] === ctx[1];
  return text[i] === ctx && text[i - 1] !== '\\';
}

function isFieldStop(text: string, i: number, ctx: string): boolean {
  const c = text[i];
  if (c === '\r' || c === '\n' || c === ',' || c === ';' || c === '}' || c === ']') return true;
  return (isBlank(c) && text[i + 1] === '#') || quoteStop(text, i, ctx);
}

function isLineStop(text: string, i: number, ctx: string): boolean {
  const c = text[i];
  if (c === '\r' || c === '\n' || quoteStop(text, i, ctx)) return true;
  // A literal `\n` is only a serialized newline inside an escaped string context.
  return ctx.length === 2 && c === '\\' && (text[i + 1] === 'n' || text[i + 1] === 'r');
}

function endWhere(
  text: string,
  from: number,
  ctx: string,
  stop: (t: string, i: number, ctx: string) => boolean,
): number {
  let i = from;
  while (i < text.length && !stop(text, i, ctx)) i++;
  return trimBlanks(text, from, i);
}

/** End of the last shell word of a segment (fish list values). */
function wordsEnd(text: string, from: number): number {
  let i = from;
  let last = from;
  while (i < text.length) {
    const e = scanShellWord(text, i);
    if (e === i) break;
    last = e;
    i = e;
    while (isBlank(text[i])) i++;
  }
  return last;
}

function decide(
  text: string,
  range: readonly [number, number],
  end: number,
  mode: Mode,
  kind: string,
): Step {
  let [s, e] = range;
  if (mode === 'line') {
    SCHEME_RE.lastIndex = s;
    const m = SCHEME_RE.exec(text);
    if (m !== null) s = Math.min(s + m[0].length, e);
  }
  if (s >= e) return { end, spans: [] };
  const value = text.slice(s, e);
  if (isLabel(value) || isPlaceholder(value)) return { end, spans: [] };
  return { end, spans: [{ start: s, end: e, kind }] };
}

type Located = [[number, number], number];

/** Where the value ends: a reference or label at the start is skipped, the rest is still scanned. */
function referenceEnd(text: string, start: number): number {
  PLACEHOLDER_AT.lastIndex = start;
  LABEL_AT.lastIndex = start;
  const m = PLACEHOLDER_AT.exec(text) ?? LABEL_AT.exec(text);
  return m === null ? start : start + m[0].length;
}

function shellValue(text: string, start: number, from: number, ctx: string): Located {
  const wEnd = scanShellWord(text, from, ctx.length === 2 ? '\\' : ctx);
  const q = text[start];
  if (from === start && isQuote(q) && wEnd - 1 > start && scanQuoted(text, start, q) === wEnd - 1) {
    return [[start + 1, wEnd - 1], wEnd];
  }
  return [[start, wEnd], wEnd];
}

function quotedValue(text: string, start: number, q: string): Located {
  const close = scanQuoted(text, start, q);
  return [[start + 1, close], Math.min(close + 1, text.length)];
}

function escapedValue(text: string, start: number, q: string): Located {
  const close = scanEscapedQuoted(text, start, q);
  return [[start + 2, close], Math.min(close + 2, text.length)];
}

function plainValue(text: string, start: number, from: number, mode: Mode, ctx: string): Located {
  const stop = mode === 'line' ? isLineStop : isFieldStop;
  const end = endWhere(text, from, ctx, stop);
  return [[start, end], end];
}

function locate(text: string, start: number, mode: Mode, ctx: string): Located {
  const c = text[start];
  const next = text[start + 1];
  const from = referenceEnd(text, start);
  if (from === start && c === '\\' && (next === '"' || next === "'")) {
    return escapedValue(text, start, next);
  }
  if (mode === 'words') {
    const end = wordsEnd(text, start);
    return [[start, end], end];
  }
  if (mode === 'shell') return shellValue(text, start, from, ctx);
  if (from === start && isQuote(c)) return quotedValue(text, start, c);
  return plainValue(text, start, from, mode, ctx);
}

const BLOCK_RE = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/;

function lineBounds(text: string, from: number): [number, number] {
  const nl = text.indexOf('\n', from);
  return [from, nl < 0 ? text.length : nl];
}

function indentOf(text: string, from: number, to: number): number {
  let n = 0;
  while (from + n < to && isBlank(text[from + n])) n++;
  return n;
}

/** End of the YAML block scalar body that follows a key at `column`. */
function blockEnd(text: string, from: number, column: number): number {
  let end = from;
  let pos = text.indexOf('\n', from);
  while (pos >= 0 && pos < text.length) {
    const [s, e] = lineBounds(text, pos + 1);
    const indent = indentOf(text, s, e);
    const blank = s + indent === e;
    if (!blank && indent <= column) break;
    if (!blank) end = e;
    pos = e < text.length ? e : -1;
  }
  return end;
}

/** Widens a `|`/`>` block-scalar indicator to cover the indented lines below it. */
function widenBlock(text: string, step: Step, keyStart: number): Step {
  const sp = step.spans[0];
  if (sp === undefined || !BLOCK_RE.test(text.slice(sp.start, sp.end))) return step;
  const column = keyStart - (text.lastIndexOf('\n', keyStart - 1) + 1);
  const end = blockEnd(text, sp.end, column);
  return { end: Math.max(step.end, end), spans: [{ ...sp, end }] };
}

const AFTER_QUOTE_OK = ';|&()<>,}]';

/**
 * A value that stops at its context's closing quote may be glued to more text (`"password=a"TAIL`).
 * Unless a separator follows the quote, the span is widened through the adjoining shell word.
 */
function extendConcat(text: string, step: Step, ctx: string): Step {
  const sp = step.spans[0];
  if (sp === undefined || ctx === '') return step;
  let j = sp.end;
  while (isBlank(text[j])) j++;
  if (!quoteStop(text, j, ctx)) return step;
  const next = text[j + ctx.length];
  if (next === undefined || isSpace(next) || AFTER_QUOTE_OK.includes(next)) return step;
  const end = scanShellWord(text, j + ctx.length);
  return { end: Math.max(step.end, end), spans: [{ ...sp, end }] };
}

export interface ValueOptions {
  readonly mode: Mode;
  readonly kind: string;
  /** Quote the key sits in (`"`, `'`, `\"`, `\'`) or `''`. */
  readonly ctx: string;
  readonly keyStart: number;
}

/** Scans the value at `start`; `end` always covers everything scanned. */
export function scanValue(text: string, start: number, o: ValueOptions): Step {
  const [range, end] = locate(text, start, o.mode, o.ctx);
  const step = extendConcat(text, decide(text, range, end, o.mode, o.kind), o.ctx);
  return o.mode === 'field' ? widenBlock(text, step, o.keyStart) : step;
}

/** Applies `step` to each regex match, replacing the spans it returns. */
export function redactMatches(
  text: string,
  re: RegExp,
  counts: Record<string, number>,
  step: (m: RegExpExecArray) => Step | undefined,
): string {
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0] === '') {
      re.lastIndex += 1;
      continue;
    }
    const s = step(m);
    if (s === undefined) continue;
    for (const sp of s.spans) {
      if (sp.start < last) continue;
      out += text.slice(last, sp.start) + label(sp.kind);
      last = sp.end;
      counts[sp.kind] = (counts[sp.kind] ?? 0) + 1;
    }
    re.lastIndex = Math.max(re.lastIndex, s.end);
  }
  return last === 0 && out === '' ? text : out + text.slice(last);
}

interface Run {
  runEnd: number;
  lastAt: number;
}

function scanRun(text: string, from: number): Run {
  let i = from;
  let lastAt = -1;
  while (i < text.length) {
    const c = text[i];
    if (c === undefined || isSpace(c) || c === '"' || c === "'" || c === '<' || c === '>') break;
    if (c === '@') lastAt = i;
    i++;
  }
  return { runEnd: i, lastAt };
}

const PORT_RE = /\d{1,5}\/@/y;

/** `host:3000/@scope/pkg`: digits, then a path whose first character is the last `@` of the run. */
function isDevServerPath(text: string, p: number, at: number): boolean {
  PORT_RE.lastIndex = p;
  const m = PORT_RE.exec(text);
  return m !== null && at === p + m[0].length - 1;
}

/** Step for `scheme://user:` matches: the password runs to the last `@` of the run. */
export function makeUrlStep(text: string): (m: RegExpExecArray) => Step | undefined {
  let memo: Run = { runEnd: -1, lastAt: -1 };
  return (m) => {
    const p = m.index + m[0].length;
    if (p >= memo.runEnd) memo = scanRun(text, p);
    const at = memo.lastAt;
    if (at < p) return undefined;
    if (m[1] !== '' && isDevServerPath(text, p, at)) return undefined;
    const pw = text.slice(p, at);
    const skip = pw === '' || isLabel(pw);
    return { end: at, spans: skip ? [] : [{ start: p, end: at, kind: 'url-credentials' }] };
  };
}

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isBasicCredential(token: string): boolean {
  const body = token.replace(/=+$/, '');
  if (body.length < 6 || body.length % 4 === 1 || !/^[A-Za-z0-9+/]+$/.test(body)) return false;
  try {
    const decoded = atob(body + '='.repeat((4 - (body.length % 4)) % 4));
    return decoded.includes(':') && !hasControl(decoded);
  } catch {
    return false;
  }
}

export function isTokenish(token: string): boolean {
  if (token.length < 12) return false;
  if (/\d/.test(token)) return true;
  return token.length >= 20 && /[a-z]/.test(token) && /[A-Z]/.test(token);
}
