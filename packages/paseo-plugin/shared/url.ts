// fallow-ignore-file code-duplication
// `trimTrailingSlashes` mirrors `@ziptie-soft/local-decider-core` (client.ts) on purpose: this file
// is also bundled into the app, which may not import the workspace package (see decision.ts).
import { DEFAULT_GATEWAY_URL } from './constants.ts';

// No `URL` here: React Native's URL implements almost none of its getters.
const BASE_URL = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?(\/[^\s?#@]*)?$/i;

interface UrlParts {
  readonly scheme: string;
  readonly host: string;
  readonly port: string;
  readonly path: string;
}

function originFrom(parts: UrlParts): string {
  return `${parts.scheme.toLowerCase()}://${parts.host.toLowerCase()}${parts.port}`;
}

function baseParts(value: string): UrlParts | null {
  const match = BASE_URL.exec(value);
  if (match === null) return null;
  const [, scheme = '', host = '', port = '', path = ''] = match;
  if (port !== '' && Number(port.slice(1)) > 65_535) return null;
  return { scheme, host, port, path };
}

/** `value` without trailing `/`. A loop, not `/\/+$/`, which backtracks quadratically on long runs. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return value.slice(0, end);
}

/** `http(s)://host[:port][/path]` without a trailing slash, or null when unusable. */
export function normaliseBaseUrl(raw: string | undefined): string | null {
  const value = (raw ?? '').trim() || DEFAULT_GATEWAY_URL;
  const parts = baseParts(value);
  return parts === null ? null : trimTrailingSlashes(`${originFrom(parts)}${parts.path}`);
}

const LOOPBACK_HOST = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])$/;

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Lowercased `scheme://host[:port]`, or null for empty, unmatched or out-of-range input. */
export function originOf(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (hasControlCharacters(raw)) return null;
  const parts = baseParts(raw);
  return parts === null ? null : originFrom(parts);
}

export function loopbackUrl(baseUrl: string): boolean {
  const parts = baseParts(baseUrl);
  return parts !== null && LOOPBACK_HOST.test(parts.host.toLowerCase());
}

/** The bearer goes to loopback, or over https to exactly the pinned origin (S5). */
export function bearerAllowed(baseUrl: string, pinnedOrigin: string | undefined): boolean {
  if (loopbackUrl(baseUrl)) return true;
  const origin = originOf(baseUrl);
  const pinned = originOf(pinnedOrigin);
  return origin !== null && pinned !== null && origin.startsWith('https://') && origin === pinned;
}
