import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { GGUF, ggufDir, type PinnedFile } from './engines/llama/models.ts';
import { recordMatches, writeRecord } from './engines/llama/verified.ts';
import type { Paths } from './paths.ts';

const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

function idleTimeout(controller: AbortController): { reset(): void; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    reset: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(new Error('download stalled with no data for 60 seconds')),
        DOWNLOAD_IDLE_TIMEOUT_MS,
      );
    },
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

async function streamHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(path),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  return `sha256:${hash.digest('hex')}`;
}

export async function fetchPinned(
  pin: PinnedFile,
  dest: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const part = `${dest}.${randomUUID()}.part`;
  const controller = new AbortController();
  const timeout = idleTimeout(controller);
  const hash = createHash('sha256');
  let bytes = 0;
  let lastPercent = -1;
  let ownsPart = false;
  try {
    timeout.reset();
    const response = await fetch(pin.url, { signal: controller.signal });
    if (!response.ok || response.body === null) {
      throw new Error(`download failed for ${pin.file}: HTTP ${response.status}`);
    }
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        timeout.reset();
        bytes += chunk.length;
        hash.update(chunk);
        const percent = Math.floor((bytes / pin.bytes) * 100);
        if (percent > lastPercent) {
          lastPercent = percent;
          onProgress?.(bytes / pin.bytes);
        }
        callback(null, chunk);
      },
    });
    const output = createWriteStream(part, { flags: 'wx', mode: 0o600 });
    output.once('open', () => {
      ownsPart = true;
    });
    await pipeline(Readable.fromWeb(response.body), meter, output);
    const actual = `sha256:${hash.digest('hex')}`;
    if (bytes !== pin.bytes || actual !== pin.sha256) {
      throw new Error(
        `checksum mismatch for ${pin.file}: expected ${pin.sha256} (${pin.bytes} bytes), got ${actual} (${bytes} bytes)`,
      );
    }
    renameSync(part, dest);
  } catch (error) {
    if (ownsPart) rmSync(part, { force: true });
    throw error;
  } finally {
    timeout.clear();
  }
}

export async function installPinnedModel(
  paths: Paths,
  pin: PinnedFile,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  if (basename(pin.file) !== pin.file) throw new Error(`invalid GGUF filename: ${pin.file}`);
  const directory = ggufDir(paths);
  mkdirSync(directory, { recursive: true });
  const dest = join(directory, pin.file);
  if (recordMatches(dest, pin.sha256)) return dest;
  if (existsSync(dest)) {
    if ((await streamHash(dest)) === pin.sha256) {
      writeRecord(dest, pin.sha256, ['']);
      return dest;
    }
    rmSync(dest);
  }
  await fetchPinned(pin, dest, onProgress);
  writeRecord(dest, pin.sha256, ['']);
  return dest;
}

export async function installLlamaModel(
  paths: Paths,
  id: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const pin = GGUF[id];
  if (pin === undefined) throw new Error(`unknown llama-vulkan model: ${id}`);
  return installPinnedModel(paths, pin, onProgress);
}
