import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { setPath } from '../server/engines.ts';
import { parseEngineCatalog } from '../shared/engines.ts';
import {
  canSavePath,
  middleEllipsis,
  parsePaths,
  pathDraftError,
  pathStatus,
  sourceBadge,
} from '../shared/paths.ts';
import { deps, fakeGateway, settings } from './fakes.ts';

const FLM = {
  key: 'tools.flm',
  label: 'FastFlowLM launcher (flm)',
  kind: 'executable',
  value: null,
  effective: '/home/u/.local/share/local-decider/engines/fastflowlm/1.0.12/dist/flm',
  source: 'managed',
  ok: true,
  detail: 'FLM v1.0.12',
};

describe('paths parsing', () => {
  it('reads the contract entries and pathsEditable', () => {
    const catalog = parseEngineCatalog({
      paths: [
        FLM,
        {
          key: 'dirs.hfCache',
          label: 'Hugging Face cache',
          kind: 'directory',
          source: 'default',
          ok: true,
        },
      ],
      pathsEditable: true,
    });
    assert.equal(catalog.pathsEditable, true);
    assert.deepEqual(catalog.paths[0], FLM);
    assert.deepEqual(catalog.paths[1], {
      key: 'dirs.hfCache',
      label: 'Hugging Face cache',
      kind: 'directory',
      value: null,
      effective: null,
      source: 'default',
      ok: true,
      detail: null,
    });
  });

  it('drops bad keys and duplicates, and defaults odd fields', () => {
    const paths = parsePaths([
      FLM,
      { ...FLM, label: 'again' },
      { key: '../etc' },
      { key: 'tools.x', kind: 'socket', source: 'weird', ok: 'yes' },
      null,
    ]);
    assert.deepEqual(
      paths.map((p) => [p.key, p.kind, p.source, p.ok]),
      [
        ['tools.flm', 'executable', 'managed', true],
        ['tools.x', 'executable', 'default', false],
      ],
    );
    assert.deepEqual(parsePaths('nope'), []);
  });
});

describe('path rows', () => {
  it('badges the source', () => {
    assert.equal(sourceBadge({ source: 'managed', value: null }), 'auto: managed');
    assert.equal(sourceBadge({ source: 'path', value: null }), 'auto: PATH');
    assert.equal(sourceBadge({ source: 'settings', value: '/x/flm' }), 'custom');
    assert.equal(sourceBadge({ source: 'missing', value: null }), 'missing');
    assert.equal(sourceBadge({ source: 'missing', value: '/gone/flm' }), 'missing');
  });

  it('shortens long paths in the middle', () => {
    assert.equal(middleEllipsis('/usr/bin/uv'), '/usr/bin/uv');
    const short = middleEllipsis(FLM.effective, 24);
    assert.equal(short.length, 24);
    assert.ok(short.startsWith('/home/u/.lo'));
    assert.ok(short.endsWith('/dist/flm'));
  });

  it('validates a typed path before sending it', () => {
    assert.equal(pathDraftError('/opt/flm/bin/flm'), null);
    assert.equal(pathDraftError('  /opt/flm  '), null);
    assert.equal(pathDraftError('C:\\\\tools\\\\flm.exe'), null);
    assert.match(pathDraftError('') ?? '', /Enter a path/);
    assert.match(pathDraftError('bin/flm') ?? '', /absolute path/);
    assert.match(pathDraftError('~/bin/flm') ?? '', /absolute path/);
    assert.match(pathDraftError('/a\n/b') ?? '', /line breaks/);
    assert.match(pathDraftError(`/${'a'.repeat(1001)}`) ?? '', /too long/);
  });

  it('offers Save only for a valid, changed path', () => {
    assert.equal(canSavePath('/opt/flm', null), true);
    assert.equal(canSavePath(' /opt/flm ', '/opt/flm'), false);
    assert.equal(canSavePath('/opt/other', '/opt/flm'), true);
    assert.equal(canSavePath('relative/flm', null), false);
    assert.equal(canSavePath('', null), false);
  });

  it('says whether the path works', () => {
    assert.equal(
      pathStatus({ ok: true, detail: 'FLM v1.0.12', kind: 'executable' }),
      'FLM v1.0.12',
    );
    assert.equal(pathStatus({ ok: true, detail: null, kind: 'directory' }), 'Found');
    assert.equal(
      pathStatus({ ok: false, detail: null, kind: 'executable' }),
      'Not found or does not run',
    );
  });
});

describe('set-path RPC', () => {
  it('returns the updated entry, bare or wrapped', async () => {
    for (const body of [FLM, { entry: FLM }]) {
      const gw = { ...fakeGateway(() => null), setPath: async () => ({ ok: true as const, body }) };
      const res = await setPath(deps(settings(), gw), { key: 'tools.flm', value: null });
      assert.equal(res.entry?.key, 'tools.flm');
    }
  });

  it("shows the gateway's refusal", async () => {
    const gw = {
      ...fakeGateway(() => null),
      setPath: async () => ({ ok: false as const, error: 'not executable: /tmp/flm' }),
    };
    assert.deepEqual(await setPath(deps(settings(), gw), { key: 'tools.flm', value: '/tmp/flm' }), {
      ok: false,
      error: 'not executable: /tmp/flm',
      entry: null,
    });
  });
});
