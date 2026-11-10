import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { CatalogEngine, KnownModel } from './models.ts';
import { probe, type Toolchain } from './toolchain.ts';

export interface Validation {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly summary: string;
  readonly lines: readonly string[];
}

const LIST_TTL_MS = 15_000;

/** `models--Org--Name/snapshots/<rev>` holds at least one file. */
export function hfCached(hfCache: string, repo: string): boolean {
  const snapshots = join(hfCache, `models--${repo.replace('/', '--')}`, 'snapshots');
  if (!existsSync(snapshots)) {
    return false;
  }
  return readdirSync(snapshots).some((rev) => readdirSync(join(snapshots, rev)).length > 0);
}

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
      .find((l) => re.test(l))
      ?.replace(/^\[\w+\]\s*/, '')
      .trim();
  return [pick(/NPU platform/), pick(/NPU:/), pick(/FW Version/)]
    .filter((s): s is string => s !== undefined)
    .join(' · ');
}

function cleanLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.includes('no version information available'));
}

/** Installed models, the FLM version and validation, cached so GET /v1/engines stays cheap. */
export class CatalogStatus {
  #tools: Toolchain;
  #hfCache: string;
  #flmList: { at: number; tags: Set<string> } | undefined;
  #flmVersion: string | undefined;
  #validation: Validation | undefined;
  #validating: Promise<Validation> | undefined;

  constructor(tools: Toolchain, hfCache: string) {
    this.#tools = tools;
    this.#hfCache = hfCache;
  }

  /** New tool paths or directories: forget everything derived from the old ones. */
  reset(tools: Toolchain, hfCache: string): void {
    this.#tools = tools;
    this.#hfCache = hfCache;
    this.#flmList = undefined;
    this.#flmVersion = undefined;
    this.#validation = undefined;
  }

  invalidate(): void {
    this.#flmList = undefined;
  }

  get validation(): Validation | undefined {
    return this.#validation;
  }

  get flmVersion(): string | undefined {
    return this.#flmVersion;
  }

  async installed(models: readonly KnownModel[]): Promise<Map<string, boolean>> {
    const flm = models.some((m) => m.engine === 'fastflowlm')
      ? await this.#flmTags()
      : new Set<string>();
    return new Map(
      models.map((m) => [
        m.id,
        m.engine === 'fastflowlm'
          ? flm.has(m.id)
          : (m.hf ?? []).every((repo) => hfCached(this.#hfCache, repo)),
      ]),
    );
  }

  async #flmTags(): Promise<Set<string>> {
    if (this.#flmList !== undefined && Date.now() - this.#flmList.at < LIST_TTL_MS) {
      return this.#flmList.tags;
    }
    const flm = this.#tools.flm;
    if (flm === undefined) {
      return new Set();
    }
    try {
      const out = await probe(flm, ['list'], this.#tools.env);
      this.#flmList = { at: Date.now(), tags: parseFlmList(out) };
      this.#flmVersion ??= await this.#version(flm);
      return this.#flmList.tags;
    } catch {
      return new Set();
    }
  }

  async #version(flm: string): Promise<string | undefined> {
    try {
      return /FLM v[\d.]+/.exec(await probe(flm, ['version'], this.#tools.env))?.[0];
    } catch {
      return undefined;
    }
  }

  /** Run `flm validate` (one at a time); the result is cached for GET /v1/engines. */
  validate(engine: CatalogEngine): Promise<Validation> {
    const flm = this.#tools.flm;
    if (engine !== 'fastflowlm' || flm === undefined) {
      return Promise.resolve(this.#store(false, ['FastFlowLM is not installed']));
    }
    this.#validating ??= probe(flm, ['validate'], this.#tools.env, 60_000)
      .then((out) => this.#store(true, cleanLines(out)))
      .catch((error: unknown) => this.#store(false, cleanLines((error as Error).message)))
      .finally(() => {
        this.#validating = undefined;
      });
    return this.#validating;
  }

  #store(ok: boolean, lines: string[]): Validation {
    this.#validation = {
      ok,
      checkedAt: new Date().toISOString(),
      summary: ok ? summariseValidate(lines) : (lines.at(-1) ?? 'validation failed'),
      lines,
    };
    return this.#validation;
  }
}
