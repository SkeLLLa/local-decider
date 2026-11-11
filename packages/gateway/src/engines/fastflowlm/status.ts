import { probe } from '../../toolchain.ts';
import type { EngineContext, Validation } from '../descriptor.ts';

/** Tags `flm list` marks downloaded (`  - d3:nano ✅`). */
export function parseFlmList(output: string): Set<string> {
  const out = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /^\s*-\s+(\S+)\s+✅/.exec(line);
    if (match?.[1] !== undefined) {
      out.add(match[1]);
    }
  }
  return out;
}

/** Summary from `flm validate` output: the NPU and firmware lines. */
export function summariseValidate(lines: readonly string[]): string {
  const pick = (re: RegExp): string | undefined =>
    lines
      .find((line) => re.test(line))
      ?.replace(/^\[\w+\]\s*/, '')
      .trim();
  return [pick(/NPU platform/), pick(/NPU:/), pick(/FW Version/)]
    .filter((line): line is string => line !== undefined)
    .join(' · ');
}

function cleanLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.includes('no version information available'));
}

interface VersionEntry {
  readonly value: string | undefined;
}

const versions = new Map<string, VersionEntry>();
const versionLoads = new Map<string, Promise<string | undefined>>();

/** Cached version for the FLM binary that most recently supplied catalogue status. */
export function cachedFlmVersion(binary: string | undefined): string | undefined {
  return binary === undefined ? undefined : versions.get(binary)?.value;
}

async function flmVersion(ctx: EngineContext, binary: string): Promise<string | undefined> {
  const cached = versions.get(binary);
  if (cached !== undefined) {
    return cached.value;
  }
  const pending = versionLoads.get(binary);
  if (pending !== undefined) {
    return pending;
  }
  const load = probe(binary, ['version'], ctx.tools?.env)
    .then((output) => /FLM v[\d.]+/.exec(output)?.[0])
    .catch(() => undefined)
    .then((value) => {
      versions.set(binary, { value });
      return value;
    })
    .finally(() => versionLoads.delete(binary));
  versionLoads.set(binary, load);
  return load;
}

/** FLM catalogue presence; the generic CatalogStatus owns the per-engine TTL. */
export async function flmModelsPresent(
  models: readonly { readonly id: string }[],
  ctx: EngineContext,
): Promise<ReadonlyMap<string, boolean>> {
  const binary = ctx.tools?.flm;
  if (binary === undefined) {
    return new Map(models.map((model) => [model.id, false]));
  }
  try {
    const output = await probe(binary, ['list'], ctx.tools?.env);
    await flmVersion(ctx, binary);
    const tags = parseFlmList(output);
    return new Map(models.map((model) => [model.id, tags.has(model.id)]));
  } catch {
    return new Map(models.map((model) => [model.id, false]));
  }
}

function validationResult(ok: boolean, lines: string[]): Validation {
  return {
    ok,
    checkedAt: new Date().toISOString(),
    summary: ok ? summariseValidate(lines) : (lines.at(-1) ?? 'validation failed'),
    lines,
  };
}

/** Run `flm validate` with its fixed argv and report the NPU/firmware summary. */
export async function validateFlm(ctx: EngineContext): Promise<Validation> {
  const binary = ctx.tools?.flm;
  if (binary === undefined) {
    return validationResult(false, ['FastFlowLM is not installed']);
  }
  try {
    return validationResult(
      true,
      cleanLines(await probe(binary, ['validate'], ctx.tools?.env, 60_000)),
    );
  } catch (error) {
    return validationResult(false, cleanLines((error as Error).message));
  }
}
