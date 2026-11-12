import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatOf,
  familyId,
  familyLabel,
  familyOf,
  isKnownFamily,
} from '../src/engines/families.ts';
import { ENGINES, allModels } from '../src/engines/registry.ts';

const VERIFIED = new Map<string, string>([
  ['fastflowlm|d3:lite', 'vllm-sr/d3-lite'],
  ['fastflowlm|d3:nano', 'vllm-sr/d3-nano'],
  ['fastflowlm|d3:mini', 'vllm-sr/d3-mini'],
  ['llama-vulkan|d3-lite-q8_0', 'vllm-sr/d3-lite'],
  ['llama-vulkan|d3-nano-q8_0', 'vllm-sr/d3-nano'],
  ['llama-vulkan|d3-mini-q4_k_m', 'vllm-sr/d3-mini'],
  ['llama-vulkan|d3-mini-q8_0', 'vllm-sr/d3-mini'],
  ['llama-vulkan|d3-flash-q4_k_m', 'vllm-sr/d3-flash'],
]);

describe('model families', () => {
  it('limits verified base models to the cited catalogue mapping', () => {
    const actual = allModels()
      .filter((model) => model.baseModel !== undefined)
      .map((model) => [`${model.engine}|${model.id}`, model.baseModel] as const);
    assert.deepEqual(new Map(actual), VERIFIED);
    for (const model of allModels()) {
      assert.equal(model.quant, model.engine === 'fastflowlm' ? 'FLM' : model.quant);
      if (model.baseModel !== undefined) assert.equal(familyId(model), model.baseModel);
    }
  });

  it('keeps every Strands model and the additional FLM d3 models singleton', () => {
    const strands = ENGINES.find((engine) => engine.id === 'strands-decider');
    assert.ok(strands);
    for (const model of strands.models) {
      assert.equal(familyId(model), `strands-decider:${model.id}`);
    }
    for (const id of ['d3:edge', 'd3:flash', 'd3:turbo', 'd3:ultra']) {
      assert.equal(familyOf(id, 'fastflowlm'), `fastflowlm:${id}`);
    }
  });

  it('resolves family labels and catalogue-only membership', () => {
    assert.equal(familyLabel('vllm-sr/d3-lite'), 'd3 lite');
    assert.equal(familyLabel('strands-decider:missing'), 'strands-decider:missing');
    assert.equal(familyOf('unknown', 'fastflowlm'), null);
    assert.equal(isKnownFamily('vllm-sr/d3-mini'), true);
    assert.equal(isKnownFamily('fastflowlm:d3:edge'), true);
    assert.equal(isKnownFamily('fastflowlm:missing'), false);
  });

  it('formats supported and unknown quant codes', () => {
    assert.deepEqual(formatOf(undefined), null);
    assert.deepEqual(formatOf('Q4_K_M'), { short: 'Q4_K_M', label: '4-bit (Q4_K_M)' });
    assert.deepEqual(formatOf('Q8_0'), { short: 'Q8_0', label: '8-bit (Q8_0)' });
    assert.deepEqual(formatOf('FLM'), { short: 'FLM', label: 'NPU format (FLM)' });
    assert.deepEqual(formatOf('other'), { short: 'other', label: 'other' });
  });
});
