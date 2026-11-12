import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { PinnedFile } from '../src/engines/llama/models.ts';
import { recordMatches, recordPath } from '../src/engines/llama/verified.ts';
import { fetchPinned, installPinnedModel } from '../src/llama-install.ts';
import { tempPaths } from './helpers.ts';

function pinFor(bytes: Buffer): PinnedFile {
  return {
    url: 'https://example.invalid/model.gguf',
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes: bytes.length,
    file: 'fixture.gguf',
  };
}

function partFiles(dest: string): string[] {
  return readdirSync(join(dest, '..')).filter((name) => name.endsWith('.part'));
}

async function waitForPartFiles(dest: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (partFiles(dest).length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(partFiles(dest).length, count);
}

describe('llama model installer', () => {
  it('streams a pinned response, records it, and removes the partial file', async () => {
    const paths = tempPaths();
    const bytes = Buffer.from('small fixture model');
    const pin = pinFor(bytes);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(bytes);
    try {
      const fractions: number[] = [];
      const dest = await installPinnedModel(paths, pin, (fraction) => fractions.push(fraction));
      assert.deepEqual(readFileSync(dest), bytes);
      assert.deepEqual(partFiles(dest), []);
      assert.equal(recordMatches(dest, pin.sha256), true);
      assert.equal(existsSync(recordPath(dest)), true);
      assert.ok(fractions.length > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses mismatched bytes and removes the partial download', async () => {
    const paths = tempPaths();
    const bytes = Buffer.from('wrong bytes');
    const expected = pinFor(Buffer.from('right bytes'));
    const dest = join(paths.data, 'models', 'gguf', expected.file);
    mkdirSync(join(dest, '..'), { recursive: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(bytes);
    try {
      await assert.rejects(fetchPinned(expected, dest), /checksum mismatch/);
      assert.deepEqual(partFiles(dest), []);
      assert.equal(existsSync(dest), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps concurrent downloads in separate partial files', async () => {
    const paths = tempPaths();
    const bytes = Buffer.from('concurrent fixture model');
    const pin = pinFor(bytes);
    const dest = join(paths.data, 'models', 'gguf', pin.file);
    mkdirSync(join(dest, '..'), { recursive: true });
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const middle = Math.floor(bytes.length / 2);
            controller.enqueue(bytes.subarray(0, middle));
            await gate;
            controller.enqueue(bytes.subarray(middle));
            controller.close();
          },
        }),
      );
    const downloads = [fetchPinned(pin, dest), fetchPinned(pin, dest)];
    try {
      await waitForPartFiles(dest, 2);
      release();
      await Promise.all(downloads);
      assert.deepEqual(readFileSync(dest), bytes);
      assert.deepEqual(partFiles(dest), []);
    } finally {
      release();
      await Promise.allSettled(downloads);
      globalThis.fetch = originalFetch;
    }
  });

  it('rehashes an unrecorded existing model and replaces wrong same-size content', async () => {
    const paths = tempPaths();
    const bytes = Buffer.from('pinned');
    const pin = pinFor(bytes);
    const dest = join(paths.data, 'models', 'gguf', pin.file);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, 'impost');
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(bytes);
    };
    try {
      await installPinnedModel(paths, pin);
      assert.equal(calls, 1);
      assert.deepEqual(readFileSync(dest), bytes);
      assert.equal(recordMatches(dest, pin.sha256), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('records matching existing bytes and avoids a second fetch', async () => {
    const paths = tempPaths();
    const bytes = Buffer.from('already pinned');
    const pin = pinFor(bytes);
    const dest = join(paths.data, 'models', 'gguf', pin.file);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, bytes);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('unexpected network request');
    };
    try {
      assert.equal(await installPinnedModel(paths, pin), dest);
      assert.equal(recordMatches(dest, pin.sha256), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
