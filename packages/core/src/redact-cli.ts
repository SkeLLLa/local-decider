/**
 * Command-line redaction: one command-spec table and `cliHits`, shared by free text (through a
 * shell tokenizer over the command segment) and argv arrays.
 */
import { isSecretKey } from './redact-keys.ts';
import {
  isLabel,
  isPlaceholder,
  scanQuoted,
  scanShellWord,
  type Span,
  type Step,
} from './redact-scan.ts';

interface FlagSpec {
  readonly flag: string;
  readonly attached?: boolean;
  readonly spaced?: boolean;
  readonly eq?: boolean;
  readonly userPass?: boolean;
}

interface CommandSpec {
  readonly name: RegExp;
  readonly flags: readonly FlagSpec[];
}

// Spaced `mysql -p db` prompts for the password, so only the attached form carries a value.
const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: /^(?:mysql|mariadb)[a-z-]{0,12}$/, flags: [{ flag: '-p', attached: true }] },
  { name: /^sshpass$/, flags: [{ flag: '-p', attached: true, spaced: true }] },
  { name: /^redis-cli$/, flags: [{ flag: '-a', spaced: true }] },
  {
    name: /^curl$/,
    flags: [
      { flag: '-u', attached: true, spaced: true, userPass: true },
      { flag: '-U', attached: true, spaced: true, userPass: true },
      { flag: '--user', spaced: true, eq: true, userPass: true },
      { flag: '--proxy-user', spaced: true, eq: true, userPass: true },
    ],
  },
];

export interface CliHit {
  /** Token index in the argument list. */
  readonly index: number;
  /** Offsets of the secret inside that token. */
  readonly start: number;
  readonly end: number;
  readonly kind: string;
}

interface Found {
  readonly hit: CliHit | undefined;
  readonly consumed: number;
}

/** Strips one matching quote pair around a whole token; `off` is the shift of the inner text. */
function unquote(tok: string): { text: string; off: number } {
  const q = tok[0];
  const quoted = (q === '"' || q === "'") && tok.length >= 2 && tok.endsWith(q);
  return quoted ? { text: tok.slice(1, -1), off: 1 } : { text: tok, off: 0 };
}

function commandSpec(tok: string): CommandSpec | undefined {
  const bare = unquote(tok).text;
  const base = bare.slice(bare.lastIndexOf('/') + 1);
  return COMMAND_SPECS.find((s) => s.name.test(base));
}

/** Strips one surrounding quote pair when the value is a single quoted segment. */
function valueRange(tok: string, s: number, e: number): [number, number] {
  const q = tok[s];
  if (
    (q === '"' || q === "'") &&
    e - s >= 2 &&
    tok[e - 1] === q &&
    scanQuoted(tok, s, q) === e - 1
  ) {
    return [s + 1, e - 1];
  }
  return [s, e];
}

function makeHit(
  tok: string,
  index: number,
  range: readonly [number, number],
  kind: string,
  userPass: boolean,
): CliHit | undefined {
  let [s, e] = valueRange(tok, range[0], range[1]);
  if (userPass) {
    const colon = tok.slice(s, e).indexOf(':');
    if (colon < 0) return undefined;
    s += colon + 1;
  }
  const value = tok.slice(s, e);
  if (value === '' || isLabel(value) || isPlaceholder(value)) return undefined;
  return { index, start: s, end: e, kind };
}

function inlineValue(tok: string, f: FlagSpec): number | undefined {
  if (f.eq === true && tok.startsWith(`${f.flag}=`)) return f.flag.length + 1;
  const single = f.flag.length === 2 && f.flag[1] !== '-';
  if (f.attached === true && single && tok.startsWith(f.flag) && tok.length > 2) return 2;
  return undefined;
}

function flagHit(tokens: readonly string[], i: number, f: FlagSpec): Found | undefined {
  const raw = tokens[i] ?? '';
  const { text: tok, off } = unquote(raw);
  const up = f.userPass === true;
  const at = inlineValue(tok, f);
  if (at !== undefined) {
    return { hit: makeHit(raw, i, [at + off, tok.length + off], 'cli-password', up), consumed: 0 };
  }
  const next = tokens[i + 1];
  if (f.spaced === true && tok === f.flag && next !== undefined) {
    return { hit: makeHit(next, i + 1, [0, next.length], 'cli-password', up), consumed: 1 };
  }
  return undefined;
}

function specHit(spec: CommandSpec, tokens: readonly string[], i: number): Found | undefined {
  for (const f of spec.flags) {
    const found = flagHit(tokens, i, f);
    if (found !== undefined) return found;
  }
  return undefined;
}

const LONG_FLAG = /^--([A-Za-z][A-Za-z0-9-]{0,63})$/;

function genericHit(tokens: readonly string[], i: number): Found | undefined {
  const m = LONG_FLAG.exec(unquote(tokens[i] ?? '').text);
  const next = tokens[i + 1];
  if (m === null || next === undefined) return undefined;
  if (!isSecretKey(m[1] ?? '')) return undefined;
  return { hit: makeHit(next, i + 1, [0, next.length], 'cli-flag', false), consumed: 1 };
}

export function cliHits(tokens: readonly string[]): CliHit[] {
  const out: CliHit[] = [];
  let spec: CommandSpec | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const cmd = commandSpec(tokens[i] ?? '');
    if (cmd !== undefined) {
      spec = cmd;
      continue;
    }
    const found = (spec && specHit(spec, tokens, i)) ?? genericHit(tokens, i);
    if (found === undefined) continue;
    if (found.hit !== undefined) out.push(found.hit);
    i += found.consumed;
  }
  return out;
}

interface Token {
  readonly raw: string;
  readonly start: number;
}

const SEGMENT_STOP = '\n\r;|&()';

function skipGaps(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t') i++;
    else if (c === '\\' && text[i + 1] === '\n') i += 2;
    else break;
  }
  return i;
}

function shellTokens(text: string, from: number): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  let i = skipGaps(text, from);
  while (i < text.length && !SEGMENT_STOP.includes(text[i] ?? '\n')) {
    const c = text[i] ?? '';
    const end = c === '<' || c === '>' ? i + 1 : scanShellWord(text, i);
    tokens.push({ raw: text.slice(i, end), start: i });
    i = skipGaps(text, Math.max(end, i + 1));
  }
  return { tokens, end: Math.max(i, from + 1) };
}

const CMD_NAMES = 'mysql[a-z-]{0,12}|mariadb[a-z-]{0,12}|sshpass|redis-cli|curl';
/** A command word, optionally wrapped in its own quotes (`"curl" -u ...`). */
export const CMD_RE = new RegExp(
  `(?<![\\w.-])(?:(["'])(?:${CMD_NAMES})\\1|(?:${CMD_NAMES}))(?![\\w.-])`,
  'g',
);

/** Step for a command match: the whole command segment is consumed. */
export function makeCommandStep(text: string): (m: RegExpExecArray) => Step {
  return (m) => {
    const seg = shellTokens(text, m.index);
    const spans: Span[] = [];
    for (const h of cliHits(seg.tokens.map((t) => t.raw))) {
      const base = seg.tokens[h.index]?.start ?? 0;
      spans.push({ start: base + h.start, end: base + h.end, kind: h.kind });
    }
    return { end: seg.end, spans };
  };
}
