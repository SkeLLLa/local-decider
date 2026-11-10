import {
  parseDownload,
  parseEngineCatalog,
  parseValidation,
  type Download,
  type EngineCatalog,
  type Validation,
} from '../shared/engines.ts';
/** Daemon-side RPC handlers for engines, models, downloads, validation and tool paths. */
import type { PostResult } from '../shared/gateway.ts';
import { parsePaths, type PathEntry } from '../shared/paths.ts';
import type { HookDeps } from './deps.ts';

type Deps = Pick<HookDeps, 'gateway' | 'log'>;

const BAD_URL = 'The gateway URL in settings is not a valid http(s) URL.';

export async function listEngines(deps: Pick<HookDeps, 'gateway'>): Promise<EngineCatalog> {
  const gateway = await deps.gateway();
  const body = gateway === null ? null : await gateway.engines({ timeoutMs: 3000 });
  return parseEngineCatalog(body);
}

function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : null;
}

async function call<T>(
  deps: Deps,
  label: string,
  run: (gateway: NonNullable<Awaited<ReturnType<HookDeps['gateway']>>>) => Promise<PostResult>,
  read: (body: unknown) => T,
): Promise<{ ok: boolean; error: string | null; value: T | null }> {
  const gateway = await deps.gateway();
  if (gateway === null) {
    return { ok: false, error: BAD_URL, value: null };
  }
  const res = await run(gateway);
  deps.log(`${label}: ${res.ok ? 'accepted' : res.error}`);
  return res.ok
    ? { ok: true, error: null, value: read(res.body) }
    : { ok: false, error: res.error, value: null };
}

export async function selectEngine(
  deps: Deps,
  selection: { engine: string; model: string; device: string },
): Promise<{ ok: boolean; error: string | null }> {
  const { ok, error } = await call(
    deps,
    `switch to ${selection.engine} ${selection.model}`,
    async (gw) => gw.selectEngine(selection, { timeoutMs: 15_000 }),
    () => null,
  );
  return { ok, error };
}

export async function downloadModel(
  deps: Deps,
  target: { engine: string; model: string },
): Promise<{ ok: boolean; error: string | null; download: Download | null }> {
  const res = await call(
    deps,
    `download ${target.engine} ${target.model}`,
    async (gw) => gw.downloadModel(target, { timeoutMs: 10_000 }),
    (body) => parseDownload(field(body, 'download')),
  );
  return { ok: res.ok, error: res.error, download: res.value };
}

export async function validateEngine(
  deps: Deps,
  engine: string,
): Promise<{ ok: boolean; error: string | null; validation: Validation | null }> {
  const res = await call(
    deps,
    `validate ${engine}`,
    // `flm validate` takes a few seconds; stay under the 30 s RPC limit.
    async (gw) => gw.validateEngine(engine, { timeoutMs: 25_000 }),
    (body) => parseValidation(field(body, 'validation')),
  );
  return { ok: res.ok, error: res.error, validation: res.value };
}

export async function setPath(
  deps: Deps,
  input: { key: string; value: string | null },
): Promise<{ ok: boolean; error: string | null; entry: PathEntry | null }> {
  const value = input.value === null ? null : input.value.trim();
  const res = await call(
    deps,
    `path ${input.key} ${value === null ? 'automatic' : 'custom'}`,
    async (gw) => gw.setPath(input.key, value, { timeoutMs: 10_000 }),
    // 200 returns the updated entry, bare or as `{entry}`.
    (body) => parsePaths([field(body, 'entry') ?? body])[0] ?? null,
  );
  return { ok: res.ok, error: res.error, entry: res.value };
}

export async function engineLoad(
  deps: Deps,
  action: 'load' | 'unload',
): Promise<{ ok: boolean; error: string | null }> {
  const { ok, error } = await call(
    deps,
    `engine ${action}`,
    async (gw) => gw.engineLoad(action, { timeoutMs: 15_000 }),
    () => null,
  );
  return { ok, error };
}

export async function setLifecycle(
  deps: Deps,
  input: { lifecycle: 'lazy' | 'eager'; idleUnloadMinutes?: number | undefined },
): Promise<{ ok: boolean; error: string | null }> {
  const body =
    input.idleUnloadMinutes === undefined
      ? { lifecycle: input.lifecycle }
      : { lifecycle: input.lifecycle, idleUnloadMinutes: input.idleUnloadMinutes };
  const { ok, error } = await call(
    deps,
    `lifecycle ${input.lifecycle}`,
    async (gw) => gw.setLifecycle(body, { timeoutMs: 10_000 }),
    () => null,
  );
  return { ok, error };
}

/** Set the gateway's run mode for a policy, so "Act" here really lets the gateway enforce. */
export async function setPolicyMode(
  deps: Deps,
  input: { policy: string; mode: 'off' | 'shadow' | 'act' },
): Promise<{ ok: boolean; error: string | null }> {
  const { ok, error } = await call(
    deps,
    `policy ${input.policy} ${input.mode}`,
    async (gw) => gw.setPolicyMode(input.policy, input.mode, { timeoutMs: 10_000 }),
    () => null,
  );
  return { ok, error };
}
