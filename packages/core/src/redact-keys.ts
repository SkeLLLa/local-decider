/**
 * Key-name classification for redaction. A name is split into lower-case words; two tiers decide
 * whether the value under it is secret. Strong names win over count words; they are excluded only
 * by a trailing metadata word. Weak names (`*token`, `auth`, `sig`, ...) also yield to counters
 * and timestamps. Everything here is linear in the (bounded) key length.
 */
const MAX_KEY = 128;

const STRONG: readonly string[] = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'credential',
  'authorization',
  'cookie',
  'apikey',
  'accesskey',
  'privatekey',
  'secretkey',
  'accountkey',
  'masterkey',
  'signingkey',
  'encryptionkey',
  'sessionkey',
  'clientsecret',
];
const WEAK_WORDS: ReadonlySet<string> = new Set(['auth', 'auths', 'sig', 'signature', 'pat']);
const WEAK_LAST: ReadonlySet<string> = new Set(['pass', 'pwd']);
const META_LAST: ReadonlySet<string> = new Set([
  'type',
  'kind',
  'url',
  'uri',
  'endpoint',
  'file',
  'path',
  'dir',
  'env',
  'name',
  'names',
  'stdin',
  'arn',
]);
const TIME_LAST: ReadonlySet<string> = new Set([
  'expires',
  'expiry',
  'expiration',
  'at',
  'ttl',
  'lifetime',
]);
const COUNT: ReadonlySet<string> = new Set([
  'max',
  'min',
  'num',
  'count',
  'total',
  'used',
  'remaining',
  'limit',
  'budget',
  'estimated',
  'length',
  'size',
]);
const TOKEN_EXEMPT_FIRST: ReadonlySet<string> = new Set(['page', 'next', 'continuation']);

function keyWords(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w !== '');
}

/** Words plus adjacent-pair concatenations: [x, api, key] -> x, api, key, xapi, apikey. */
function candidates(words: readonly string[]): string[] {
  const out = [...words];
  for (let i = 0; i + 1 < words.length; i++) {
    out.push(`${words[i] ?? ''}${words[i + 1] ?? ''}`);
  }
  return out;
}

function hits(c: string, t: string): boolean {
  return c === t || c === `${t}s` || c.endsWith(t) || c.endsWith(`${t}s`);
}

function isStrong(words: readonly string[]): boolean {
  return candidates(words).some((c) => STRONG.some((t) => hits(c, t)));
}

function hasMetaLast(words: readonly string[], set: ReadonlySet<string>): boolean {
  const last = words.at(-1);
  return words.length > 1 && last !== undefined && set.has(last);
}

function isTokenWord(words: readonly string[]): boolean {
  const first = words[0] ?? '';
  return !TOKEN_EXEMPT_FIRST.has(first) && words.some((w) => w.endsWith('token'));
}

function isWeak(key: string, words: readonly string[]): boolean {
  if (isTokenWord(words)) return true;
  if (words.some((w) => WEAK_WORDS.has(w))) return true;
  if (key.toLowerCase() === 'pass') return true;
  const last = words.at(-1) ?? '';
  return words.length > 1 && WEAK_LAST.has(last);
}

/**
 * Key classification is pure and runs once per `key: value` match; adversarial or repetitive
 * input repeats the same keys, so memoise per key. Cleared when full to stay bounded.
 */
const CACHE_LIMIT = 1024;

function memo(fn: (key: string) => boolean): (key: string) => boolean {
  const cache = new Map<string, boolean>();
  return (key) => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (cache.size >= CACHE_LIMIT) cache.clear();
    const value = fn(key);
    cache.set(key, value);
    return value;
  };
}

export const isSecretKey = memo(classifySecretKey);
export const isLineKey = memo(classifyLineKey);

function classifySecretKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY) return false;
  const words = keyWords(key);
  if (words.length === 0) return false;
  if (isStrong(words)) return !hasMetaLast(words, META_LAST);
  return (
    isWeak(key, words) &&
    !words.some((w) => COUNT.has(w)) &&
    !hasMetaLast(words, META_LAST) &&
    !hasMetaLast(words, TIME_LAST)
  );
}

function classifyLineKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY) return false;
  return candidates(keyWords(key)).some((c) => hits(c, 'cookie') || hits(c, 'authorization'));
}
