import { execFile } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { onPath } from '../toolchain.ts';

export type CapabilityStatus = 'available' | 'unavailable' | 'unknown';

export interface CapabilityResult {
  readonly status: CapabilityStatus;
  /** Short, parsed evidence; never raw tool output. */
  readonly evidence: string;
  /** Apple only: which stack was confirmed. */
  readonly variant?: 'mlx' | 'mps';
}

export interface HostCapabilities {
  readonly npu: CapabilityResult;
  readonly nvidia: CapabilityResult;
  readonly apple: CapabilityResult;
  readonly vulkan: CapabilityResult;
  readonly probedAt: number;
}

export interface CapabilityFs {
  /** Entry names of a directory; throws on failure. */
  readonly list: (path: string) => string[];
  readonly read: (path: string) => string;
  /** Throws unless the current user can read and write `path`. */
  readonly access: (path: string) => void;
}

export interface ProbeDeps {
  readonly platform: string;
  readonly arch: string;
  readonly fs: CapabilityFs;
  /** Resolves an executable on PATH. */
  readonly which: (name: string) => string | undefined;
  /** Runs literal argv without a shell; resolves stdout, rejects on failure or timeout. */
  readonly run: (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;
  readonly now: () => number;
}

export interface ProbeOptions {
  /** Resolved `strands-decider` executable; its sibling `python` is the environment probed. */
  readonly strandsDecider?: string | undefined;
  readonly deps?: Partial<ProbeDeps>;
  readonly perProbeMs?: number;
  readonly budgetMs?: number;
}

const MAX_OUTPUT_BYTES = 64 * 1024;
const PER_PROBE_MS = 2000;
const BUDGET_MS = 4000;
const SOFTWARE_VULKAN = /llvmpipe|lavapipe|swiftshader/i;
const AMD_NPU_DRIVER = 'amdxdna';

const APPLE_SCRIPT = [
  'import json',
  'r={"mlx":False,"metal":False,"mps":False}',
  'try:',
  ' import mlx.core as m',
  ' r["mlx"]=True',
  ' r["metal"]=bool(m.metal.is_available())',
  'except Exception: pass',
  'try:',
  ' import torch',
  ' r["mps"]=bool(torch.backends.mps.is_available())',
  'except Exception: pass',
  'print(json.dumps(r))',
].join('\n');

const unknown = (evidence: string): CapabilityResult => ({ status: 'unknown', evidence });
const unavailable = (evidence: string): CapabilityResult => ({ status: 'unavailable', evidence });
const available = (evidence: string): CapabilityResult => ({ status: 'available', evidence });

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function defaultRun(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, shell: false },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    );
  });
}

function defaultDeps(): ProbeDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    fs: {
      list: (path) => readdirSync(path),
      read: (path) => readFileSync(path, 'utf8'),
      access: (path) => accessSync(path, constants.R_OK | constants.W_OK),
    },
    which: (name) => onPath(name, process.env),
    run: defaultRun,
    now: () => Date.now(),
  };
}

/** Per-probe timeouts that also respect one shared deadline. */
function runner(deps: ProbeDeps, perProbeMs: number, deadline: number): Run {
  return (file, args) => {
    const left = Math.min(perProbeMs, deadline - deps.now());
    return left <= 0
      ? Promise.reject(new Error('probe budget exhausted'))
      : deps.run(file, args, left);
  };
}

type Run = (file: string, args: readonly string[]) => Promise<string>;

function probeNpu(deps: ProbeDeps): CapabilityResult {
  if (deps.platform !== 'linux') {
    return unavailable('not linux');
  }
  let names: string[];
  try {
    names = deps.fs.list('/dev/accel').filter((n) => /^accel\d+$/.test(n));
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? unavailable('no /dev/accel device')
      : unknown('/dev/accel unreadable');
  }
  if (names.length === 0) {
    return unavailable('no /dev/accel device');
  }
  return names.map((name) => npuDevice(deps, name)).reduce(bestOf);
}

const RANK: Record<CapabilityStatus, number> = { available: 2, unknown: 1, unavailable: 0 };
function bestOf(a: CapabilityResult, b: CapabilityResult): CapabilityResult {
  return RANK[b.status] > RANK[a.status] ? b : a;
}

function npuDevice(deps: ProbeDeps, name: string): CapabilityResult {
  let driver: string | undefined;
  try {
    const uevent = deps.fs.read(`/sys/class/accel/${name}/device/uevent`);
    driver = /^DRIVER=(.+)$/m.exec(uevent)?.[1]?.trim();
  } catch {
    return unknown(`${name}: sysfs driver unreadable`);
  }
  if (driver !== AMD_NPU_DRIVER) {
    return unavailable(`${name}: driver ${driver ?? 'none'}, not ${AMD_NPU_DRIVER}`);
  }
  try {
    deps.fs.access(`/dev/accel/${name}`);
  } catch {
    return unknown(`${name}: ${AMD_NPU_DRIVER} device not accessible`);
  }
  return available(`${name}: ${AMD_NPU_DRIVER}`);
}

function parseNvidia(output: string): CapabilityResult {
  const [name, memory] = (output.split('\n')[0] ?? '').split(',').map((s) => s.trim());
  const mib = Number(memory);
  if (name === undefined || name === '' || !Number.isFinite(mib) || memory === '') {
    return unknown('nvidia-smi output not understood');
  }
  return available(`${name}, ${mib} MiB`);
}

async function probeNvidia(deps: ProbeDeps, run: Run): Promise<CapabilityResult> {
  if (deps.platform !== 'linux') {
    return unavailable('not linux');
  }
  let nodes: string[];
  try {
    nodes = deps.fs.list('/dev').filter((n) => /^nvidia(\d+|ctl)$/.test(n));
  } catch {
    return unknown('/dev unreadable');
  }
  if (nodes.length === 0) {
    return unavailable('no /dev/nvidia* device');
  }
  const smi = deps.which('nvidia-smi');
  if (smi === undefined) {
    return unknown('nvidia device present, nvidia-smi not found');
  }
  try {
    const out = await run(smi, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
    return parseNvidia(out);
  } catch {
    return unknown('nvidia-smi failed or timed out');
  }
}

function parseApple(output: string): CapabilityResult {
  let parsed: { mlx?: boolean; metal?: boolean; mps?: boolean };
  try {
    parsed = JSON.parse(output.trim().split('\n').pop() ?? '') as typeof parsed;
  } catch {
    return unknown('python probe output not understood');
  }
  if (parsed.mlx === true && parsed.metal === true) {
    return { ...available('MLX with Metal'), variant: 'mlx' };
  }
  return parsed.mps === true
    ? { ...available('PyTorch MPS'), variant: 'mps' }
    : unavailable('no MLX/Metal or MPS');
}

async function probeApple(deps: ProbeDeps, run: Run, strands?: string): Promise<CapabilityResult> {
  if (deps.platform !== 'darwin' || deps.arch !== 'arm64') {
    return unavailable('not darwin/arm64');
  }
  if (strands === undefined) {
    return unknown('no Strands environment resolved');
  }
  try {
    return parseApple(await run(join(dirname(strands), 'python'), ['-I', '-c', APPLE_SCRIPT]));
  } catch {
    return unknown('python probe failed or timed out');
  }
}

function parseVulkan(output: string): CapabilityResult {
  const names = [...output.matchAll(/^\s*deviceName\s*=\s*(.+)$/gm)].map((m) =>
    (m[1] ?? '').trim(),
  );
  if (names.length === 0) {
    return unknown('no Vulkan devices listed');
  }
  const hardware = names.filter((n) => !SOFTWARE_VULKAN.test(n));
  return hardware[0] === undefined
    ? unavailable('only software Vulkan devices')
    : available(hardware[0]);
}

async function probeVulkan(deps: ProbeDeps, run: Run): Promise<CapabilityResult> {
  const tool = deps.which('vulkaninfo');
  if (tool === undefined) {
    return unknown('vulkaninfo not found');
  }
  try {
    return parseVulkan(await run(tool, ['--summary']));
  } catch {
    return unknown('vulkaninfo failed or timed out');
  }
}

let cached: Promise<HostCapabilities> | undefined;

/** Forget cached results; call when tools or config change. */
export function invalidateHostCapabilities(): void {
  cached = undefined;
}

/**
 * Probes accelerators once and caches the result. Slow; never call from catalog requests or
 * decisions. Every failure yields `unknown` rather than throwing.
 */
export function probeHostCapabilities(options: ProbeOptions = {}): Promise<HostCapabilities> {
  cached ??= runProbes(options);
  return cached;
}

async function runProbes(options: ProbeOptions): Promise<HostCapabilities> {
  const deps: ProbeDeps = { ...defaultDeps(), ...options.deps };
  const run = runner(
    deps,
    options.perProbeMs ?? PER_PROBE_MS,
    deps.now() + (options.budgetMs ?? BUDGET_MS),
  );
  const [nvidia, apple, vulkan] = await Promise.all([
    probeNvidia(deps, run),
    probeApple(deps, run, options.strandsDecider),
    probeVulkan(deps, run),
  ]);
  return { npu: probeNpu(deps), nvidia, apple, vulkan, probedAt: deps.now() };
}
