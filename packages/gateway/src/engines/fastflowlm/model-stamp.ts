import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { EngineContext, ModelDescriptor } from '../descriptor.ts';

function modelRoot(ctx: EngineContext): string {
  return (
    ctx.tools?.env['FLM_MODEL_PATH'] ??
    ctx.env['FLM_MODEL_PATH'] ??
    join(homedir(), '.config', 'flm', 'models')
  );
}

function modelDirectory(root: string, id: string): string | undefined {
  const tag = id.split(':')[1];
  if (tag === undefined) return undefined;
  try {
    const prefix = `d3-${tag}-`.toLowerCase();
    const directories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix))
      .map((entry) => entry.name)
      .toSorted();
    return directories[0] === undefined ? undefined : join(root, directories[0]);
  } catch {
    return undefined;
  }
}

function stampFiles(directory: string): string | null {
  try {
    const files = readdirSync(directory)
      .filter((name) => name.endsWith('.q4nx') || name.endsWith('.safetensors'))
      .toSorted();
    const stamps = files.map((name) => {
      const stat = statSync(join(directory, name));
      return `${String(stat.size)}:${String(stat.mtimeMs)}`;
    });
    return stamps.length === 0 ? null : stamps.join(',');
  } catch {
    return null;
  }
}

export function flmModelStamp(model: ModelDescriptor, ctx: EngineContext): string | null {
  const directory = modelDirectory(modelRoot(ctx), model.id);
  return directory === undefined ? null : stampFiles(directory);
}
