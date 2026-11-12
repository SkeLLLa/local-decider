/**
 * Best-effort secret redaction for state sent to an engine or written to the shadow log. Patterns
 * are conservative: a false positive costs a little context, a false negative leaks a secret.
 *
 * ReDoS: bounded quantifiers wherever classes overlap; values, URLs and command lines are
 * scanned (`redact-scan.ts`, `redact-cli.ts`), each character O(1) times per rule.
 */
import { CMD_RE, cliHits, makeCommandStep, type CliHit } from './redact-cli.ts';
import { isLineKey, isSecretKey } from './redact-keys.ts';
import {
  isBasicCredential,
  isLabel,
  isPlaceholder,
  isTokenish,
  label,
  makeUrlStep,
  redactMatches,
  scanValue,
  type Mode,
  type Step,
} from './redact-scan.ts';

interface Rule {
  apply(text: string, counts: Record<string, number>): string;
}

function bump(counts: Record<string, number>, kind: string): void {
  counts[kind] = (counts[kind] ?? 0) + 1;
}

function shape(kind: string, re: RegExp): Rule {
  return {
    apply: (text, counts) =>
      text.replace(re, (match) => {
        if (isLabel(match)) return match;
        bump(counts, kind);
        return label(kind);
      }),
  };
}

function fnRule(
  re: RegExp,
  makeStep: (text: string) => (m: RegExpExecArray) => Step | undefined,
): Rule {
  return { apply: (text, counts) => redactMatches(text, re, counts, makeStep(text)) };
}

const BEARER_RE = /\b(Bearer|Basic)([ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi;

const bearerRule: Rule = {
  apply: (text, counts) =>
    text.replace(BEARER_RE, (match, scheme: string, gap: string, cred: string) => {
      const basic = scheme.toLowerCase() === 'basic';
      const ok = basic ? isBasicCredential(cred) : isTokenish(cred);
      if (!ok || isLabel(cred)) return match;
      bump(counts, 'bearer');
      return `${scheme}${gap}${label('bearer')}`;
    }),
};

// g1 dashes, g2 key, g3 closing quote, g4 spaces before, g5 separator, g6 spaces after
const KEY_ASSIGN_RE =
  /(?<![A-Za-z0-9_.-])(-{1,2})?([A-Za-z_][A-Za-z0-9_.-]{0,127})(\\?["'])?([ \t]{0,8})(:=|[:=](?![=>]))([ \t]{0,8})/g;
const FLAG_SPACE_RE = /(?<![A-Za-z0-9_.-])--([A-Za-z][A-Za-z0-9-]{0,63})[ \t]+(?=\S)/g;
const FISH_SET_RE =
  /\bset(?:[ \t]+-[A-Za-z]{1,8}){0,4}[ \t]+([A-Za-z_][A-Za-z0-9_]{0,127})[ \t]+(?=\S)/g;

interface KeyInfo {
  readonly key: string;
  readonly mode: Mode;
  readonly kind: string;
  /** Offset of the key inside the match. */
  readonly keyOffset: number;
  /** The key is itself quoted (`"key":`), so the quote before it is not a surrounding context. */
  readonly closed: boolean;
}

function assignInfo(m: RegExpExecArray): KeyInfo {
  const bare = m[3] === undefined && m[4] === '' && m[6] === '' && m[5] === '=';
  return {
    key: m[2] ?? '',
    mode: bare ? 'shell' : 'field',
    kind: m[1] === undefined ? 'assignment' : 'cli-flag',
    keyOffset: m[1]?.length ?? 0,
    closed: m[3] !== undefined,
  };
}

const flagInfo = (m: RegExpExecArray): KeyInfo => ({
  key: m[1] ?? '',
  mode: 'shell',
  kind: 'cli-flag',
  keyOffset: 0,
  closed: false,
});

const fishInfo = (m: RegExpExecArray): KeyInfo => ({
  key: m[1] ?? '',
  mode: 'words',
  kind: 'assignment',
  keyOffset: 0,
  closed: true,
});

/** The quote the key is embedded in (`"`, `'`, `\"`, `\'`), or `''`. */
function quoteBefore(text: string, keyStart: number): string {
  const c = text[keyStart - 1];
  if (c !== '"' && c !== "'") return '';
  return text[keyStart - 2] === '\\' ? `\\${c}` : c;
}

function keyedStep(
  text: string,
  info: (m: RegExpExecArray) => KeyInfo,
): (m: RegExpExecArray) => Step | undefined {
  return (m) => {
    const { key, mode, kind, keyOffset, closed } = info(m);
    if (!isSecretKey(key)) return undefined;
    const keyStart = m.index + keyOffset;
    return scanValue(text, m.index + m[0].length, {
      mode: isLineKey(key) && mode !== 'words' ? 'line' : mode,
      kind,
      ctx: closed ? '' : quoteBefore(text, keyStart),
      keyStart,
    });
  };
}

const SHAPES: readonly (readonly [string, RegExp])[] = [
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ['stripe-key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['stripe-webhook-secret', /\bwhsec_[A-Za-z0-9+/=]{24,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['slack-token', /\bxox[abposre]-[A-Za-z0-9-]{10,}|\bxapp-\d-[A-Za-z0-9-]{10,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ['google-oauth-token', /\bya29\.[A-Za-z0-9_-]{20,}/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['huggingface-token', /\bhf_[A-Za-z0-9]{30,}/g],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}/g],
  ['pypi-token', /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{30,}/g],
  ['docker-token', /\bdckr_pat_[A-Za-z0-9_-]{20,}/g],
  ['digitalocean-token', /\bdo[opr]_v1_[a-f0-9]{64}\b/g],
  ['shopify-token', /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];

const RULES: readonly Rule[] = [
  shape(
    'private-key',
    /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  ),
  ...SHAPES.map(([kind, re]) => shape(kind, re)),
  bearerRule,
  fnRule(/\b[a-z][a-z0-9+.-]{1,31}:\/\/([^\s:/@"'<>]{0,256}):/gi, makeUrlStep),
  fnRule(CMD_RE, makeCommandStep),
  fnRule(KEY_ASSIGN_RE, (t) => keyedStep(t, assignInfo)),
  fnRule(FLAG_SPACE_RE, (t) => keyedStep(t, flagInfo)),
  fnRule(FISH_SET_RE, (t) => keyedStep(t, fishInfo)),
];

export interface RedactionResult {
  readonly text: string;
  /**
   * Replacement operations per kind, safe to log. One secret can count under two kinds when
   * rules nest.
   */
  readonly counts: Readonly<Record<string, number>>;
}

export function redactSecrets(text: string): RedactionResult {
  const counts: Record<string, number> = {};
  let out = text;
  for (const rule of RULES) {
    out = rule.apply(out, counts);
  }
  return { text: out, counts };
}

const MAX_DEPTH = 64;

type Path = Set<object>;

function redactString(s: string, secret: boolean): string {
  if (!secret) return redactSecrets(s).text;
  return s === '' || isLabel(s) || isPlaceholder(s) ? s : label('secret-field');
}

function nextFree(base: string, used: ReadonlySet<string>, next: Map<string, number>): string {
  if (!used.has(base)) return base;
  let n = next.get(base) ?? 2;
  while (used.has(`${base}#${n}`)) n++;
  next.set(base, n + 1);
  return `${base}#${n}`;
}

/** Redacts each key; collisions get `#2`, `#3`, ... in sorted original-key order. */
function allocateKeys(keys: readonly string[]): string[] {
  const red = keys.map((k) => redactSecrets(k).text);
  const used = new Set(keys.filter((k, i) => red[i] === k));
  const order = keys.flatMap((k, i) => (red[i] === k ? [] : [i]));
  order.sort((a, b) => {
    const ka = keys[a] ?? '';
    const kb = keys[b] ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const next = new Map<string, number>();
  const out = [...keys];
  for (const i of order) {
    const name = nextFree(red[i] ?? '', used, next);
    used.add(name);
    out[i] = name;
  }
  return out;
}

function applyArgv(src: readonly unknown[], items: unknown[]): unknown[] {
  if (!src.every((x): x is string => typeof x === 'string')) return items;
  const hits: CliHit[] = cliHits(src);
  for (const h of hits) {
    const orig = src[h.index] as string;
    items[h.index] = redactSecrets(orig.slice(0, h.start) + label(h.kind) + orig.slice(h.end)).text;
  }
  return items;
}

function walkArray(a: readonly unknown[], secret: boolean, depth: number, path: Path): unknown[] {
  const items = a.map((x) => walk(x, secret, depth + 1, path));
  return secret ? items : applyArgv(a, items);
}

/** Labels such as `[REDACTED:github-token]` are not secret names themselves. */
const stripLabels = (k: string): string => k.replace(/\[REDACTED:[a-z0-9-]{1,40}\]/g, '');

function walkObject(
  o: Record<string, unknown>,
  secret: boolean,
  depth: number,
  path: Path,
): object {
  const entries = Object.entries(o);
  const names = allocateKeys(entries.map(([k]) => k));
  return Object.fromEntries(
    entries.map(([k, v], i) => [
      names[i],
      walk(v, secret || isSecretKey(stripLabels(k)), depth + 1, path),
    ]),
  );
}

function walkContainer(o: object, secret: boolean, depth: number, path: Path): unknown {
  if (path.has(o)) return label('cycle');
  if (depth >= MAX_DEPTH) return label('max-depth');
  path.add(o);
  try {
    return Array.isArray(o)
      ? walkArray(o as unknown[], secret, depth, path)
      : walkObject(o as Record<string, unknown>, secret, depth, path);
  } finally {
    path.delete(o);
  }
}

function walk(v: unknown, secret: boolean, depth: number, path: Path): unknown {
  if (typeof v === 'string') return redactString(v, secret);
  if (typeof v === 'number' || typeof v === 'bigint') return secret ? label('secret-field') : v;
  if (v === null || typeof v !== 'object') return v;
  return walkContainer(v, secret, depth, path);
}

/**
 * Redact every string inside a JSON-like value. Strings under a secret-named key (and everything
 * beneath it) become `[REDACTED:secret-field]`; keys are redacted too; argv arrays are checked
 * for password flags; cycles and very deep values become markers instead of throwing.
 *
 * Known accepted limitations:
 * - A `SystemOneRequest.questions` id that is a secret name (`token`) gets its subtree redacted;
 *   the follow-up is for the gateway to redact only `state` in `systemOne`.
 * - Subjects that differ only by a secret share precedent tallies. This is intended.
 * - `.netrc` (`password p`), shapeless secrets and field-mode values containing `,`
 *   (`password: a,b` leaks `b`) are not covered.
 * - Env names that only start with a secret word (`SECRETVALUE`) are missed.
 * - `mysql -p hunter2` (spaced `-p` prompts) and split flag quotes (`curl "-"u x:y`) are missed.
 * - Redaction may over-redact the rest of a line or string when the surrounding quote is not
 *   adjacent to the key, in serialized-JSON tails and around backticks. That is the safe direction.
 */
export function redactDeep<T>(value: T): T {
  return walk(value, false, 0, new Set()) as T;
}
