import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DownloadError, downloadSteps, lastPercent } from '../src/downloads.ts';
import type { EngineContext, ModelDescriptor } from '../src/engines/descriptor.ts';
import { tempPaths } from './helpers.ts';

function context(): EngineContext {
  const paths = tempPaths();
  return {
    paths,
    tools: { flm: undefined, strandsDecider: undefined, uv: undefined, env: {} },
    host: { platform: 'linux', arch: 'x64', totalMemoryBytes: 64e9 },
    env: {},
  };
}

describe('engine descriptor downloads', () => {
  it('returns a 400 DownloadError for an attach-only openai-style descriptor', () => {
    const model: ModelDescriptor<'openai-compatible'> = {
      id: 'server-model',
      engine: 'openai-compatible',
      label: 'Server model',
      downloadGb: null,
      memoryGb: null,
      latencyHint: null,
    };
    assert.throws(
      () => downloadSteps(model, context(), { id: 'openai-compatible' }),
      (error: unknown) => error instanceof DownloadError && error.status === 400,
    );
  });

  it('reads the last percentage of tool output', () => {
    assert.equal(lastPercent('Downloading 12% ... 47.5%'), 0.475);
    assert.equal(lastPercent('no progress here'), null);
    assert.equal(lastPercent('999%'), null);
  });
});
