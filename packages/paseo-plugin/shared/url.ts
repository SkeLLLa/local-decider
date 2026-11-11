import { DEFAULT_GATEWAY_URL } from './constants.ts';

// No `URL` here: React Native's URL implements almost none of its getters.
const BASE_URL = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?(\/[^\s?#@]*)?$/i;

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
  const match = BASE_URL.exec(value);
  if (match === null) {
    return null;
  }
  const [, scheme = '', host = '', port = '', path = ''] = match;
  if (port !== '' && Number(port.slice(1)) > 65_535) {
    return null;
  }
  return trimTrailingSlashes(`${scheme.toLowerCase()}://${host.toLowerCase()}${port}${path}`);
}

const LOOPBACK_HOST = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])$/;

/**
 * The bearer token may only travel over https or to this machine: a plain-http remote URL
 * would expose it to anyone on the network path.
 */
export function tokenAllowed(baseUrl: string): boolean {
  const match = BASE_URL.exec(baseUrl);
  if (match === null) {
    return false;
  }
  const [, scheme = '', host = ''] = match;
  return scheme.toLowerCase() === 'https' || LOOPBACK_HOST.test(host.toLowerCase());
}
