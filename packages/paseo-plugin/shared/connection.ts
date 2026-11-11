/**
 * Connection settings of the OpenAI-like engines (`openai-compatible`, `lmstudio`): payload
 * building for `POST /v1/config/engine`, a lenient reader of `POST /v1/engines/discover`, and the
 * wording the settings screen shows. Older gateways have none of this; every reader tolerates it.
 */
import { z } from 'zod';

export const CONNECTABLE_ENGINES = ['openai-compatible', 'lmstudio'] as const;
export type ConnectableEngine = (typeof CONNECTABLE_ENGINES)[number];

export function isConnectable(id: string): id is ConnectableEngine {
  return (CONNECTABLE_ENGINES as readonly string[]).includes(id);
}

export const connectionSchema = z.object({
  url: z.string(),
  model: z.string(),
  /** The name of an environment variable, never its value. */
  tokenEnv: z.string().nullable(),
});
export type Connection = z.output<typeof connectionSchema>;

const discoveredServerSchema = z.object({
  url: z.string(),
  kind: z.enum(['lmstudio', 'openai-compatible']),
  state: z.enum(['reachable', 'error']),
  models: z.array(z.string()),
  /** Why a probe failed; fixed wording from the gateway. */
  reason: z.string().nullable(),
});
export type DiscoveredServer = z.output<typeof discoveredServerSchema>;

export const discoverySchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  suggestions: z.array(discoveredServerSchema),
  server: discoveredServerSchema.nullable(),
});
export type Discovery = z.output<typeof discoverySchema>;

const MAX_TEXT = 500;
const MAX_MODELS = 200;

function fields(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, MAX_TEXT) : null;
}

/** A saved connection from `connection` of an engine or `connections.<id>` of the config. */
export function parseConnection(value: unknown): Connection | null {
  const v = fields(value);
  const url = text(v?.['url']);
  const model = text(v?.['model']);
  if (v === null || url === null || model === null) {
    return null;
  }
  return { url, model, tokenEnv: text(v['tokenEnv']) };
}

function parseServer(value: unknown): DiscoveredServer | null {
  const v = fields(value);
  const url = text(v?.['url']);
  if (v === null || url === null) {
    return null;
  }
  const models = Array.isArray(v['models']) ? v['models'] : [];
  return {
    url,
    kind: v['kind'] === 'lmstudio' ? 'lmstudio' : 'openai-compatible',
    // Anything but an explicit `reachable` is not evidence of a server.
    state: v['state'] === 'reachable' ? 'reachable' : 'error',
    models: models
      .slice(0, MAX_MODELS)
      .filter((m): m is string => typeof m === 'string' && m !== '')
      .map((m) => m.slice(0, MAX_TEXT)),
    reason: text(v['reason']),
  };
}

/** Lenient read of a discover response: either `{suggestions}` or `{server}`; old shapes give none. */
export function parseDiscovery(body: unknown): Omit<Discovery, 'ok' | 'error'> {
  const v = fields(body);
  const list = Array.isArray(v?.['suggestions']) ? (v['suggestions'] as unknown[]) : [];
  return {
    suggestions: list.map(parseServer).filter((s): s is DiscoveredServer => s !== null),
    server: parseServer(v?.['server']),
  };
}

export interface ConnectionForm {
  readonly engine: ConnectableEngine;
  readonly url: string;
  readonly model: string;
  readonly tokenEnv: string;
}

export interface ConnectionPayload {
  readonly engine: ConnectableEngine;
  readonly url: string;
  readonly model: string;
  /** Null clears the saved variable name. */
  readonly tokenEnv: string | null;
}

/** The `POST /v1/config/engine` body from the form: trimmed, an empty token variable is null. */
export function buildConnectionPayload(
  form: ConnectionForm,
): { ok: true; payload: ConnectionPayload } | { ok: false; error: string } {
  const url = form.url.trim();
  const model = form.model.trim();
  const tokenEnv = form.tokenEnv.trim();
  if (url === '') {
    return { ok: false, error: 'Enter the API base URL, e.g. http://127.0.0.1:1234/v1.' };
  }
  if (model === '') {
    return { ok: false, error: 'Choose or type a model.' };
  }
  return {
    ok: true,
    payload: { engine: form.engine, url, model, tokenEnv: tokenEnv === '' ? null : tokenEnv },
  };
}

/** The `POST /v1/engines/discover` body: `{}` for suggestions, else the entered URL. */
export function buildDiscoverBody(
  engine: ConnectableEngine,
  url: string | null,
): { engine?: ConnectableEngine; url?: string } {
  const trimmed = url?.trim() ?? '';
  return trimmed === '' ? {} : { engine, url: trimmed };
}

/** The first reachable LM Studio among the suggestions, if any. Discovery never selects it. */
export function lmStudioSuggestion(
  suggestions: readonly DiscoveredServer[],
): DiscoveredServer | null {
  return suggestions.find((s) => s.kind === 'lmstudio' && s.state === 'reachable') ?? null;
}

export function lmStudioNote(server: DiscoveredServer): string {
  return `LM Studio found at ${server.url}. Choose LM Studio for its chat and logprob defaults. OpenAI-compatible remains available for custom settings.`;
}

export const NOT_CONFIGURED_HINT =
  "Not configured. Enter your server's API base URL and choose or type a model below. Nothing to install.";

/** What a server probe says; only a reachable result may claim a server answered. */
export function serverSummary(server: DiscoveredServer): string {
  if (server.state !== 'reachable') {
    return `No server answered at ${server.url}${server.reason === null ? '' : `: ${server.reason}`}.`;
  }
  const count = server.models.length;
  return count === 0
    ? `Reachable at ${server.url}, but it lists no models. Type a model id.`
    : `Reachable at ${server.url}; ${String(count)} model${count === 1 ? '' : 's'} found.`;
}

/** Reachable suggestions as short rows; unreachable defaults are not worth listing. */
export function reachableSuggestions(suggestions: readonly DiscoveredServer[]): DiscoveredServer[] {
  return suggestions.filter((s) => s.state === 'reachable');
}

/** A server whose URL and models seed the form, e.g. a found LM Studio. */
export interface Seed {
  readonly url: string;
  readonly models: readonly string[];
}

export interface FormValues {
  readonly url: string;
  readonly model: string;
  readonly tokenEnv: string;
  readonly models: readonly string[];
}

/**
 * Form values: the saved connection, with a seed's URL and models on top. A saved model is kept
 * when the seed lists it, else the seed's first model; with no seed, the saved values as they are.
 */
export function initialForm(connection: Connection | null, seed: Seed | null = null): FormValues {
  const saved = connection?.model ?? '';
  const models = seed?.models ?? [];
  const model = seed === null || models.includes(saved) ? saved : (models[0] ?? saved);
  return {
    url: seed?.url ?? connection?.url ?? '',
    model,
    tokenEnv: connection?.tokenEnv ?? '',
    models,
  };
}
