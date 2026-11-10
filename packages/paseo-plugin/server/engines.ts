import {
  parseDownload,
  parseEngineCatalog,
  parseValidation,
  type Download,
  type EngineCatalog,
  type Validation,
} from '../shared/engines.ts';
/** Daemon-side RPC handlers for engines, models, downloads, validation, tool paths, policies. */
import type { PostResult } from '../shared/gateway.ts';
import { parsePaths, type PathEntry } from '../shared/paths.ts';
import {
  parsePolicyPrompt,
  parsePolicyVariants,
  parseRoutingSettings,
  type PolicyPrompt,
  type PolicyVariants,
  type RoutingSettings,
} from '../shared/policies.ts';
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

/** Policy `id` and the variants that can answer for it. */
export async function listPolicyVariants(
  deps: Pick<HookDeps, 'gateway'>,
  id: string,
): Promise<PolicyVariants> {
  const gateway = await deps.gateway();
  if (gateway === null) {
    return { ok: false, error: BAD_URL, active: null, variants: [] };
  }
  return parsePolicyVariants(await gateway.policies({ timeoutMs: 3000 }), id);
}

/** Answer policy `policy` with `variant` (the policy itself = the default). */
export async function setPolicyVariant(
  deps: Deps,
  input: { policy: string; variant: string },
): Promise<{ ok: boolean; error: string | null }> {
  const { ok, error } = await call(
    deps,
    `policy ${input.policy} variant ${input.variant}`,
    async (gw) => gw.setPolicyVariant(input.policy, input.variant, { timeoutMs: 10_000 }),
    () => null,
  );
  return { ok, error };
}

/** Re-read the gateway's policy files; reports the number of policies loaded. */
export async function reloadPolicies(
  deps: Deps,
): Promise<{ ok: boolean; error: string | null; count: number }> {
  const { ok, error, value } = await call(
    deps,
    'reload policies',
    async (gw) => gw.reloadPolicies({ timeoutMs: 10_000 }),
    (body) => {
      const list = field(body, 'policies');
      return Array.isArray(list) ? list.length : 0;
    },
  );
  return { ok, error, count: value ?? 0 };
}

/** Paseo's presets from config.yaml (`routing.presets.paseo`). */
export async function routingSettings(deps: Pick<HookDeps, 'gateway'>): Promise<RoutingSettings> {
  const gateway = await deps.gateway();
  if (gateway === null) {
    return { ok: false, error: BAD_URL, file: null, presets: {} };
  }
  return parseRoutingSettings(await gateway.config({ timeoutMs: 3000 }));
}

/** Map one Paseo preset in config.yaml, or remove it with a null model. */
/** Map one Paseo preset in config.yaml to a model or a profile; with neither, remove it. */
export async function setRoutingPreset(
  deps: Deps,
  input: {
    preset: string;
    model?: string | undefined;
    profile?: string | undefined;
    mode?: string | undefined;
    thinking?: string | undefined;
  },
): Promise<{ ok: boolean; error: string | null }> {
  const fields = Object.fromEntries(
    (['model', 'profile', 'mode', 'thinking'] as const)
      .map((key) => [key, input[key]?.trim() ?? ''] as const)
      .filter(([, value]) => value !== ''),
  );
  const update = { harness: 'paseo' as const, preset: input.preset, ...fields };
  const label = fields['profile'] ?? fields['model'] ?? 'unmapped';
  const { ok, error } = await call(
    deps,
    `route:${input.preset} → ${label}`,
    async (gw) => gw.setRoutingPreset(update, { timeoutMs: 10_000 }),
    () => null,
  );
  return { ok, error };
}

export async function policyPrompt(
  deps: Pick<HookDeps, 'gateway'>,
  policy: string,
): Promise<PolicyPrompt> {
  const gateway = await deps.gateway();
  if (gateway === null) {
    return { ok: false, error: BAD_URL, prompt: '', cwd: '' };
  }
  return parsePolicyPrompt(await gateway.policyPrompt(policy, { timeoutMs: 5000 }));
}
