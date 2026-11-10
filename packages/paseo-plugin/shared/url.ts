import { DEFAULT_GATEWAY_URL } from './constants.ts';

// No `URL` here: React Native's URL implements almost none of its getters.
const BASE_URL = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?(\/[^\s?#@]*)?$/i;

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
  return `${scheme.toLowerCase()}://${host.toLowerCase()}${port}${path}`.replace(/\/+$/, '');
}
