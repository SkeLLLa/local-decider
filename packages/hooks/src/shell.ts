/**
 * A small, quote-aware shell splitter for the deterministic guard. It is not a shell parser: it
 * only needs to find command words and their arguments reliably enough to match a short list of
 * clearly destructive patterns without tripping on quoted text.
 */

export interface Segment {
  readonly words: readonly string[];
  /** True when this segment reads the previous one's stdout (`a | b`). */
  readonly piped: boolean;
}

const SEPARATORS = new Set([';', '&', '|', '\n', '(', ')', '`']);

interface SplitState {
  readonly segments: Segment[];
  words: string[];
  word: string;
  inWord: boolean;
  quote: '' | "'" | '"';
  piped: boolean;
}

function endWord(s: SplitState): void {
  if (s.inWord) {
    s.words.push(s.word);
  }
  s.word = '';
  s.inWord = false;
}

function endSegment(s: SplitState, next: string, prev: string): void {
  endWord(s);
  if (s.words.length > 0) {
    s.segments.push({ words: s.words, piped: s.piped });
  }
  s.words = [];
  // `a | b` pipes; `a || b` does not.
  s.piped = next === '|' && prev !== '|';
}

function quoted(s: SplitState, ch: string): void {
  if (ch === s.quote) {
    s.quote = '';
  } else {
    s.word += ch;
  }
}

function unquoted(s: SplitState, ch: string, text: string, i: number): number {
  if (ch === "'" || ch === '"') {
    s.quote = ch;
    s.inWord = true;
  } else if (ch === '\\' && i + 1 < text.length) {
    s.word += text[i + 1] ?? '';
    s.inWord = true;
    return i + 1;
  } else if (SEPARATORS.has(ch)) {
    endSegment(s, text[i + 1] === '|' ? '' : ch, text[i - 1] ?? '');
  } else if (ch === ' ' || ch === '\t' || ch === '\r') {
    endWord(s);
  } else {
    s.word += ch;
    s.inWord = true;
  }
  return i;
}

/** Split a command line into segments of words, honouring quotes and backslash escapes. */
export function splitShell(text: string): Segment[] {
  const s: SplitState = {
    segments: [],
    words: [],
    word: '',
    inWord: false,
    quote: '',
    piped: false,
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (s.quote === '') {
      i = unquoted(s, ch, text, i);
    } else {
      quoted(s, ch);
    }
  }
  endSegment(s, '', '');
  return s.segments;
}

const PREFIXES = new Set(['sudo', 'doas', 'env', 'command', 'nohup', 'time', 'exec', 'nice']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Prefix flags whose value is the next word: `sudo -u root rm …`, `nice -n 10 rm …`. */
const VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C']),
  nice: new Set(['-n']),
};

/** Words a prefix's flag at `i` spans (1, or 2 when its value is the next word); 0 if none. */
function prefixFlagSpan(prefix: string, words: readonly string[], i: number): number {
  const w = words[i] ?? '';
  if (prefix === '' || !w.startsWith('-')) {
    return 0;
  }
  return VALUE_FLAGS[prefix]?.has(w) === true && i + 1 < words.length ? 2 : 1;
}

/** Drop `sudo`, `env`, `VAR=value` and similar prefixes so `words[0]` is the real command. */
export function commandWords(words: readonly string[]): readonly string[] {
  let i = 0;
  let prefix = '';
  while (i < words.length) {
    const w = words[i] ?? '';
    const span = prefixFlagSpan(prefix, words, i);
    if (span > 0) {
      i += span;
    } else if (PREFIXES.has(w) || ASSIGNMENT.test(w)) {
      prefix = PREFIXES.has(w) ? w : prefix;
      i++;
    } else {
      break;
    }
  }
  return words.slice(i);
}

/** The basename of a command word: `/usr/bin/rm` → `rm`. */
export function baseName(word: string): string {
  const slash = word.lastIndexOf('/');
  return slash === -1 ? word : word.slice(slash + 1);
}
