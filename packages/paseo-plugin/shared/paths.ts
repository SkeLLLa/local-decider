/**
 * Tool paths and directories the gateway uses (`paths` in `GET /v1/engines`): a lenient parser,
 * the RPC schema, and what each row on the settings screen shows.
 */
import { z } from 'zod';

const PATH_SOURCES = ['settings', 'config', 'managed', 'path', 'default', 'missing'] as const;
type PathSource = (typeof PATH_SOURCES)[number];

export const pathEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['executable', 'directory']),
  /** The user's override; null means automatic discovery. */
  value: z.string().nullable(),
  effective: z.string().nullable(),
  source: z.enum(PATH_SOURCES),
  ok: z.boolean(),
  detail: z.string().nullable(),
  /** Where to install or read about it; https only, absent on older gateways. */
  installUrl: z.string().optional(),
});

export type PathEntry = z.output<typeof pathEntrySchema>;

/** Keys are dotted identifiers such as `tools.flm`; anything else is dropped. */
export const PATH_KEY = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const MAX_PATH = 1000;
const MAX_ENTRIES = 50;

function str(value: unknown, max = 500): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : null;
}

/** An https URL (at most 500 characters) or null; anything else is dropped. */
function httpsUrl(value: unknown): string | null {
  const text = str(value);
  return text !== null && /^https:\/\/[^\s/]+/i.test(text) ? text : null;
}

function source(value: unknown): PathSource {
  return PATH_SOURCES.find((s) => s === value) ?? 'default';
}

function parsePathEntry(value: unknown): PathEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const key = str(v['key'], 100);
  if (key === null || !PATH_KEY.test(key)) {
    return null;
  }
  const installUrl = httpsUrl(v['installUrl']);
  return {
    key,
    label: str(v['label']) ?? key,
    kind: v['kind'] === 'directory' ? 'directory' : 'executable',
    value: str(v['value'], MAX_PATH),
    effective: str(v['effective'], MAX_PATH),
    source: source(v['source']),
    ok: v['ok'] === true,
    detail: str(v['detail']),
    ...(installUrl === null ? {} : { installUrl }),
  };
}

/** `paths` of `GET /v1/engines`, deduplicated by key. */
export function parsePaths(value: unknown): PathEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: PathEntry[] = [];
  for (const entry of value.slice(0, MAX_ENTRIES)) {
    const parsed = parsePathEntry(entry);
    if (parsed !== null && !out.some((e) => e.key === parsed.key)) {
      out.push(parsed);
    }
  }
  return out;
}

const SOURCE_BADGES: Record<PathSource, string> = {
  settings: 'custom',
  config: 'config.yaml',
  managed: 'auto: managed',
  path: 'auto: PATH',
  default: 'auto: default',
  missing: 'missing',
};

/** `custom`, `auto: managed`, `auto: PATH`, `missing`… An override always reads `custom`. */
export function sourceBadge(entry: Pick<PathEntry, 'source' | 'value'>): string {
  return entry.value !== null && entry.source !== 'missing'
    ? 'custom'
    : SOURCE_BADGES[entry.source];
}

/** `/home/u/…/dist/flm`: keeps both ends of a long path. */
export function middleEllipsis(text: string, max = 48): string {
  if (text.length <= max) {
    return text;
  }
  const tail = Math.ceil((max - 1) / 2);
  const head = max - 1 - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/**
 * Why a typed custom path cannot be sent, or null when it can. The gateway does the real checks
 * (exists, executable, right tool) and its message is shown after Save.
 */
export function pathDraftError(draft: string): string | null {
  const path = draft.trim();
  if (path === '') {
    return 'Enter a path, or use automatic discovery.';
  }
  if (path.length > MAX_PATH) {
    return 'That path is too long.';
  }
  if (path.includes('\0') || /[\r\n]/.test(path)) {
    return 'Paths cannot contain line breaks.';
  }
  return isAbsolute(path) ? null : 'Enter an absolute path, for example /usr/local/bin/flm.';
}

/** One line under the path: whether it works, and the gateway's detail. */
export function pathStatus(entry: Pick<PathEntry, 'ok' | 'detail' | 'kind'>): string {
  if (entry.ok) {
    return entry.detail ?? (entry.kind === 'directory' ? 'Found' : 'Found and runs');
  }
  return entry.detail ?? (entry.kind === 'directory' ? 'Not found' : 'Not found or does not run');
}

/** Save is offered for a valid draft that differs from the current override. */
export function canSavePath(draft: string, current: string | null): boolean {
  const path = draft.trim();
  return pathDraftError(path) === null && path !== current;
}

/** The help button: shown for a missing or not-working entry that has an https link. */
export function installHelp(
  entry: Pick<PathEntry, 'ok' | 'source' | 'kind' | 'installUrl'>,
): { url: string; label: 'Install' | 'Docs' } | null {
  if ((entry.ok && entry.source !== 'missing') || entry.installUrl === undefined) {
    return null;
  }
  return httpsUrl(entry.installUrl) === null
    ? null
    : { url: entry.installUrl, label: entry.kind === 'directory' ? 'Docs' : 'Install' };
}
