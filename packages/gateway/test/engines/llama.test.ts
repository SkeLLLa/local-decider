import type { SystemOneRequest } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  futimesSync,
  mkdirSync,
  openSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { EngineContext, HostInfo } from '../../src/engines/descriptor.ts';
import {
  llamaVulkanSchema,
  llamaVulkanEngine,
  forwardedConditions,
} from '../../src/engines/llama/index.ts';
import { GGUF, LLAMA_MODELS } from '../../src/engines/llama/models.ts';
import {
  effectiveLlamaBinary,
  llamaServerArgs,
  llamaSpec,
  LlamaVulkanEngine,
} from '../../src/engines/llama/server.ts';
import { hasVulkanDevice, llamaModelsPresent } from '../../src/engines/llama/status.ts';
import { recordMatches, recordPath, writeRecord } from '../../src/engines/llama/verified.ts';
import { tempPaths } from '../helpers.ts';

describe('llama Vulkan descriptor', () => {
  it('applies schema defaults and rejects invalid model, device and context', () => {
    const config = llamaVulkanSchema.parse({ type: 'llama-vulkan' });
    assert.deepEqual(
      [config.model, config.ctxSize, config.gpuLayers, config.startTimeoutSeconds],
      ['d3-mini-q4_k_m', 4096, 'all', 300],
    );
    assert.throws(() => llamaVulkanSchema.parse({ type: 'llama-vulkan', model: 'nope' }));
    assert.throws(() =>
      llamaVulkanSchema.parse({ type: 'llama-vulkan', vulkanDevice: 'Vulkan0;rm' }),
    );
    assert.throws(() => llamaVulkanSchema.parse({ type: 'llama-vulkan', ctxSize: 100_000 }));
  });

  it('has pinned model metadata and the fixed loopback argv', () => {
    const config = llamaVulkanSchema.parse({ type: 'llama-vulkan', model: 'd3-lite-q8_0' });
    assert.equal(LLAMA_MODELS.filter((model) => model.recommended).length, 1);
    assert.ok(LLAMA_MODELS.every((model) => !model.latencyHint?.includes('TODO')));
    assert.match(
      LLAMA_MODELS.find((model) => model.id === 'd3-lite-q8_0')?.latencyHint ?? '',
      /0\.15–0\.6 s/,
    );
    for (const model of LLAMA_MODELS) {
      const pin = GGUF[model.id];
      assert.ok(pin);
      assert.match(pin.url, /\/resolve\/[a-f0-9]{40}\//);
      assert.match(pin.sha256, /^sha256:[a-f0-9]{64}$/);
    }
    const args = llamaServerArgs(config, '/models/model.gguf', 8123);
    assert.ok(args.includes('--host') && args.includes('127.0.0.1'));
    assert.ok(args.includes('-a') && args.includes('d3-lite-q8_0'));
    assert.equal(args[args.indexOf('-ub') + 1], args[args.indexOf('-c') + 1]);
    assert.ok(args.includes('--offline') && args.includes('--no-webui'));
    assert.ok(!args.includes('-hf') && !args.includes('--api-key'));
    assert.ok(!args.includes('-dev'));
    const deviceArgs = llamaServerArgs(
      { ...config, vulkanDevice: 'Vulkan1' },
      '/models/model.gguf',
      8123,
    );
    assert.deepEqual(deviceArgs.slice(-2), ['-dev', 'Vulkan1']);
  });

  it('supports only Linux x64 and emits a fixed gateway install command', () => {
    assert.equal(
      llamaVulkanEngine.supports({ platform: 'linux', arch: 'x64', totalMemoryBytes: 8e9 }).ok,
      true,
    );
    assert.equal(
      llamaVulkanEngine.supports({ platform: 'darwin', arch: 'arm64', totalMemoryBytes: 8e9 }).ok,
      false,
    );
    const model = LLAMA_MODELS[0]!;
    const paths = tempPaths();
    const ctx: EngineContext = {
      paths,
      host: { platform: 'linux', arch: 'x64', totalMemoryBytes: 8e9 } satisfies HostInfo,
      env: {},
    };
    const steps = llamaVulkanEngine.downloadSteps?.(model, ctx);
    assert.ok(steps);
    assert.equal(steps[0]?.command, process.execPath);
    assert.deepEqual(steps[0]?.args.slice(-6), [
      'engine',
      'install',
      '--engine',
      'llama-vulkan',
      '--model',
      model.id,
    ]);
    assert.throws(() =>
      llamaVulkanEngine.downloadSteps?.(model, {
        ...ctx,
        host: { ...ctx.host, platform: 'darwin' },
      }),
    );
  });

  it('normalizes only safe Node conditions', () => {
    assert.deepEqual(forwardedConditions(['--conditions=source']), ['--conditions=source']);
    assert.deepEqual(forwardedConditions(['--conditions', 'source']), ['--conditions=source']);
    assert.deepEqual(forwardedConditions(['-C', 'source', '--no-warnings']), [
      '--conditions=source',
    ]);
    assert.deepEqual(forwardedConditions(['--conditions']), []);
    assert.deepEqual(forwardedConditions(['--conditions', 'a;b']), []);
    assert.deepEqual(forwardedConditions(['--inspect', '--conditions=a', '-C', 'b']), [
      '--conditions=a',
      '--conditions=b',
    ]);
  });

  it('treats only pinned GGUF records as installed, including same-size files', async () => {
    const paths = tempPaths();
    const pin = GGUF['d3-lite-q8_0']!;
    const path = join(paths.data, 'models', 'gguf', pin.file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '');
    truncateSync(path, pin.bytes);
    assert.equal(recordMatches(path, pin.sha256), false);
    const selectedModel = LLAMA_MODELS.filter((model) => model.id === 'd3-lite-q8_0');
    const ctx: EngineContext = {
      paths,
      host: { platform: 'linux', arch: 'x64', totalMemoryBytes: 8e9 },
      env: {},
    };
    assert.equal((await llamaModelsPresent(selectedModel, ctx)).get('d3-lite-q8_0'), false);
    writeRecord(path, pin.sha256, ['']);
    assert.equal(recordMatches(path, pin.sha256), true);
    assert.equal((await llamaModelsPresent(selectedModel, ctx)).get('d3-lite-q8_0'), true);
    // One descriptor for read-modify-write, so the stat and the rewrite see the same file.
    const fd = openSync(path, 'r+');
    try {
      const oldTime = fstatSync(fd).mtimeMs;
      writeSync(fd, 'x', 0);
      ftruncateSync(fd, pin.bytes);
      futimesSync(fd, new Date(), new Date(oldTime - 10_000));
    } finally {
      closeSync(fd);
    }
    assert.equal(recordMatches(path, pin.sha256), false);
    assert.equal(statSync(path).size, pin.bytes);
    assert.ok(recordPath(path).endsWith('.verified.json'));
    writeFileSync(
      recordPath(path),
      JSON.stringify({
        sha256: pin.sha256,
        files: { '../outside': { size: 1, mtimeMs: 1, ino: 1 } },
      }),
    );
    assert.equal(recordMatches(path, pin.sha256), false);
    const symlink = join(paths.data, 'linked-model.gguf');
    symlinkSync(path, symlink);
    assert.throws(() => writeRecord(symlink, pin.sha256, ['']), /cannot verify missing file/);
  });

  it('uses a valid config binary before tools and requires a verified model for the spec', () => {
    const paths = tempPaths();
    const binary = join(paths.data, 'custom', 'my-llama');
    mkdirSync(join(binary, '..'), { recursive: true });
    writeFileSync(binary, '');
    chmodSync(binary, 0o755);
    const toolBinary = join(paths.data, 'bin', 'llama-server');
    mkdirSync(join(toolBinary, '..'), { recursive: true });
    writeFileSync(toolBinary, '');
    chmodSync(toolBinary, 0o755);
    const config = llamaVulkanSchema.parse({ type: 'llama-vulkan', model: 'd3-lite-q8_0', binary });
    const tools = {
      flm: undefined,
      strandsDecider: undefined,
      uv: undefined,
      llamaServer: toolBinary,
      env: {},
    };
    assert.equal(effectiveLlamaBinary(config, tools), binary);
    assert.equal(effectiveLlamaBinary({ binary: 'relative' }, tools), undefined);
    assert.equal(effectiveLlamaBinary({}, tools), tools.llamaServer);
    const spec = llamaSpec(config, paths, tools);
    assert.match(spec.binary().missing ?? '', /not downloaded or not verified/);
    const path = join(paths.data, 'models', 'gguf', GGUF[config.model]!.file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'model');
    writeRecord(path, GGUF[config.model]!.sha256, ['']);
    assert.deepEqual(spec.binary(), { path: binary, missing: `${binary} not found` });
  });

  it('detects a Vulkan device in llama-server output', () => {
    assert.equal(hasVulkanDevice('Available devices:\n  Vulkan0: AMD Radeon 880M Graphics'), true);
    assert.equal(hasVulkanDevice('Available devices:\n'), false);
  });

  it('reports an old server clearly when /v1/systemone is missing', async () => {
    let responseBody = 'Not Found';
    const server = createServer((request, response) => {
      if (request.url === '/health') {
        response.end('{"status":"ok"}');
      } else {
        response.statusCode = 404;
        response.end(responseBody);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const config = llamaVulkanSchema.parse({
      type: 'llama-vulkan',
      url: `http://127.0.0.1:${String(address.port)}`,
    });
    const engine = new LlamaVulkanEngine(config, tempPaths());
    try {
      await engine.start();
      const request = { state: 'test', questions: {} } as SystemOneRequest;
      await assert.rejects(
        engine.decide(request, AbortSignal.timeout(2000)),
        /llama-server too old: needs \/v1\/systemone and d3 support \(llama\.cpp ≥ b11572\)/,
      );
      responseBody = '{"error":"model alias not found"}';
      await assert.rejects(
        engine.decide(request, AbortSignal.timeout(2000)),
        (error: unknown) =>
          error instanceof Error &&
          error.message === 'engine HTTP 404: {"error":"model alias not found"}',
      );
    } finally {
      await engine.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});
