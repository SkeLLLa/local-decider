import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  exitCodeFor,
  formatFinal,
  formatTarget,
  parseBenchArgs,
  parseBenchTargets,
  type BenchArgs,
  type BenchView,
} from '../src/cli-bench.ts';

function args(argv: string[]): BenchArgs {
  const parsed = parseBenchArgs(argv);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  return parsed.value;
}

function usageError(argv: string[]): string {
  const parsed = parseBenchArgs(argv);
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok);
  assert.equal(parsed.exitCode, 2);
  return parsed.error;
}

describe('bench arguments', () => {
  it('defaults to the active scope with the standard sizes and runs', () => {
    assert.deepEqual(args([]), {
      scope: 'active',
      sizes: [256, 1024, 3800],
      runs: 5,
      json: false,
    });
  });

  it('reads each scope flag, --missing, --sizes, --runs and --json', () => {
    assert.equal(args(['--installed']).scope, 'installed');
    assert.deepEqual(args(['--family', 'vllm-sr/d3-lite']), {
      scope: 'family',
      family: 'vllm-sr/d3-lite',
      sizes: [256, 1024, 3800],
      runs: 5,
      json: false,
    });
    const full = args(['--installed', '--missing', '--sizes', '256,2048', '--runs', '3', '--json']);
    assert.equal(full.only, 'missing');
    assert.deepEqual(full.sizes, [256, 2048]);
    assert.equal(full.runs, 3);
    assert.equal(full.json, true);
    assert.deepEqual(args(['--engines', 'fastflowlm:d3:mini']).targets, [
      { engine: 'fastflowlm', model: 'd3:mini' },
    ]);
  });

  it('rejects more than one scope flag', () => {
    assert.match(usageError(['--installed', '--family', 'x']), /only one of/);
    assert.match(usageError(['--engines', 'fastflowlm:d3:mini', '--installed']), /only one of/);
  });

  it('rejects non-integer sizes and runs, and unknown flags or positionals', () => {
    assert.match(usageError(['--sizes', '256,x']), /--sizes needs whole numbers/);
    assert.match(usageError(['--sizes', '1.5']), /--sizes/);
    assert.match(usageError(['--runs', 'five']), /--runs needs whole numbers/);
    assert.match(usageError(['--runs', '3,4']), /--runs takes one/);
    assert.ok(usageError(['--nope']).length > 0);
    assert.ok(usageError(['extra']).length > 0);
    assert.match(usageError(['--family', ' ']), /--family needs/);
  });

  it('rejects an unknown engine and an empty engine or model in --engines', () => {
    assert.match(usageError(['--engines', 'nope:m']), /unknown engine "nope"/);
    assert.match(usageError(['--engines', ':m']), /empty engine/);
    assert.match(usageError(['--engines', 'fastflowlm:']), /empty model/);
    assert.match(usageError(['--engines', 'fastflowlm']), /empty model/);
    assert.match(usageError(['--engines', 'fastflowlm:d3:mini,']), /empty engine/);
  });
});

const ok = (list: string): readonly unknown[] => {
  const parsed = parseBenchTargets(list);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  return parsed.value;
};

describe('bench targets', () => {
  it('splits on commas, then on the first colon', () => {
    assert.deepEqual(ok('fastflowlm:d3:mini,llama-vulkan:d3-lite-q8_0'), [
      { engine: 'fastflowlm', model: 'd3:mini' },
      { engine: 'llama-vulkan', model: 'd3-lite-q8_0' },
    ]);
  });

  it('reads a trailing @device only for a real, non-auto device', () => {
    const model = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';
    assert.deepEqual(ok(`strands-decider:${model}@cuda`), [
      { engine: 'strands-decider', model, device: 'cuda' },
    ]);
    assert.deepEqual(ok(`strands-decider:${model}@auto`), [
      { engine: 'strands-decider', model: `${model}@auto` },
    ]);
    assert.deepEqual(ok('fastflowlm:d3:mini@npu'), [
      { engine: 'fastflowlm', model: 'd3:mini@npu' },
    ]);
  });
});

const NOW_DONE: BenchView = {
  state: 'done',
  runs: 5,
  targets: [
    {
      engine: 'fastflowlm',
      model: 'd3:mini',
      device: null,
      state: 'done',
      loadMs: 4210,
      sizes: [
        { targetTokens: 256, inputTokens: 301, p50Ms: 721.4, p95Ms: 790, answer: 'done' },
        { targetTokens: 3800, inputTokens: 3700, p50Ms: 5300, p95Ms: 5600, answer: 'done' },
      ],
    },
  ],
  restoredOk: true,
  restore: { engine: 'fastflowlm', model: 'd3:lite' },
};

describe('bench output', () => {
  it('formats a target with its backend word', () => {
    assert.equal(
      formatTarget({ engine: 'fastflowlm', model: 'd3:mini' }, 'NPU'),
      'fastflowlm d3:mini (NPU)',
    );
    assert.equal(formatTarget({ engine: 'a', model: 'b' }, null), 'a b');
  });

  it('prints load, per-size lines and the restore result', () => {
    assert.deepEqual(formatFinal(NOW_DONE), [
      'fastflowlm d3:mini',
      '  load 4.2 s',
      '  256 tok (engine 301): p50 721 ms, p95 790 ms, answer=done',
      ' 3800 tok (engine 3700): p50 5300 ms, p95 5600 ms, answer=done',
      'restored fastflowlm d3:lite',
    ]);
  });

  it('marks fewer than three runs as provisional', () => {
    const lines = formatFinal({ ...NOW_DONE, runs: 2 });
    assert.ok(lines[2]?.endsWith(' provisional'));
    assert.ok(!formatFinal({ ...NOW_DONE, runs: 3 })[2]?.endsWith('provisional'));
  });

  it('prints a failed target, a failed restore, and a cancellation', () => {
    const lines = formatFinal({
      state: 'cancelled',
      cancelReason: 'user',
      restoredOk: false,
      restoreError: 'engine would not start',
      targets: [
        { engine: 'llama-vulkan', model: 'm', state: 'failed', error: 'out of memory', sizes: [] },
        { engine: 'strands-decider', model: 's', device: 'cuda', state: 'discarded' },
        { engine: 'fastflowlm', model: 'd3:nano', state: 'not-run' },
      ],
    });
    assert.deepEqual(lines, [
      'llama-vulkan m',
      '  failed: out of memory',
      'strands-decider s (cuda)',
      '  not measured (cancelled)',
      'fastflowlm d3:nano',
      '  not run',
      'restore failed: engine would not start',
      'cancelled (user)',
    ]);
  });

  it('prints a size that failed and a job that failed', () => {
    const lines = formatFinal({
      state: 'failed',
      error: 'gateway restarted',
      targets: [
        {
          engine: 'a',
          model: 'b',
          state: 'done',
          sizes: [{ targetTokens: 256, error: 'timeout' }],
        },
      ],
    });
    assert.deepEqual(lines, [
      'a b',
      '  256 tok: failed: timeout',
      'benchmark failed: gateway restarted',
    ]);
  });
});

describe('bench exit codes', () => {
  it('is 0 only for a done job with a finished target', () => {
    assert.equal(exitCodeFor(NOW_DONE, { interrupted: false }), 0);
    assert.equal(
      exitCodeFor(
        { state: 'done', targets: [{ engine: 'a', model: 'b', state: 'failed' }] },
        { interrupted: false },
      ),
      1,
    );
  });

  it('is 1 for a failed, cancelled or missing job', () => {
    assert.equal(exitCodeFor({ ...NOW_DONE, state: 'failed' }, { interrupted: false }), 1);
    assert.equal(exitCodeFor({ ...NOW_DONE, state: 'cancelled' }, { interrupted: false }), 1);
    assert.equal(exitCodeFor(null, { interrupted: false }), 1);
  });

  it('is 130 after Ctrl-C, whatever the job did', () => {
    assert.equal(exitCodeFor(NOW_DONE, { interrupted: true }), 130);
    assert.equal(exitCodeFor(null, { interrupted: true }), 130);
  });
});
