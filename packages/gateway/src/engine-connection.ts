import { trimTrailingSlashes } from '@ziptie-soft/local-decider-core';
/**
 * `POST /v1/config/engine`: the connection settings (URL, model, token variable name) of an
 * OpenAI-like engine. Validation reuses the engine's own schema fields; messages name fields,
 * never the values sent.
 */
import { z } from 'zod';

import { OPENAI_LIKE_ENGINES, type OpenAILikeEngine } from './engine-discovery.ts';
import { sharedShape } from './engines/openai/index.ts';

const MAX_URL_CHARS = 2048;
const MAX_FIELD_NAME_CHARS = 40;

export interface EngineConnection {
  readonly engine: OpenAILikeEngine;
  readonly url: string;
  readonly model: string;
  /** The environment variable's name, never its value; undefined removes the setting. */
  readonly tokenEnv: string | undefined;
}

/** Config path shared by gateway and CLI connection saves. */
export function engineConnectionConfigPath(
  engine: OpenAILikeEngine,
  primaryEngine: string,
): readonly string[] {
  return primaryEngine === engine ? ['engine'] : ['engines', engine];
}

const urlField = sharedShape.url.unwrap();
const tokenEnvField = sharedShape.tokenEnv.unwrap();

const bodySchema = z.strictObject({
  engine: z.enum(OPENAI_LIKE_ENGINES),
  url: z.string(),
  model: sharedShape.model,
  tokenEnv: z.union([z.null(), z.literal(''), tokenEnvField.max(128)]).optional(),
});

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** HTTP(S) base URL without credentials, query or fragment; trailing slashes dropped. */
export function normalizeUrl(raw: string): string | undefined {
  if (raw.length > MAX_URL_CHARS || /[\s?#]/u.test(raw) || hasControlChar(raw)) {
    return undefined;
  }
  if (!urlField.safeParse(raw).success) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  const plain =
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.username === '' &&
    parsed.password === '';
  return plain ? trimTrailingSlashes(raw) : undefined;
}

function fieldName(name: string): string {
  return name.length > MAX_FIELD_NAME_CHARS ? `${name.slice(0, MAX_FIELD_NAME_CHARS)}…` : name;
}

/** Field names only: a rejected payload may hold a secret in any value. */
function describeFailure(error: z.ZodError): string {
  const unknown = error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? issue.keys.map(fieldName) : [],
  );
  if (unknown.length > 0) {
    return `unknown field(s): ${unknown.join(', ')}; expected {engine, url, model, tokenEnv}`;
  }
  const fields = new Set(error.issues.map((issue) => String(issue.path[0] ?? 'body')));
  return `invalid ${[...fields].join(', ')}; expected {engine, url, model, tokenEnv}`;
}

/** Throws `Error` with a value-free message when the body is not a valid connection. */
export function parseEngineConnection(body: unknown): EngineConnection {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(describeFailure(parsed.error));
  }
  const url = normalizeUrl(parsed.data.url);
  if (url === undefined) {
    throw new Error(
      `invalid url; expected an http(s) base URL of at most ${String(MAX_URL_CHARS)} characters without credentials, query or fragment`,
    );
  }
  const { engine, model, tokenEnv } = parsed.data;
  return {
    engine,
    url,
    model,
    tokenEnv: tokenEnv === null || tokenEnv === '' ? undefined : tokenEnv,
  };
}
