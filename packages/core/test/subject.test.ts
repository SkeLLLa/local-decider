import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { canonicalSubject } from '../src/subject.ts';

const CWD = '/work/my-app';

describe('canonicalSubject', () => {
  it('normalizes tool names and path field aliases across harnesses', () => {
    const subjects = [
      canonicalSubject('Bash', { command: 'cd /work/my-app && npm test' }, CWD),
      canonicalSubject('shell', { command: 'npm   test' }, CWD),
      canonicalSubject('exec_command', { command: 'npm test' }, CWD),
    ];
    assert.deepEqual(subjects, ['shell: npm test', 'shell: npm test', 'shell: npm test']);
    assert.equal(canonicalSubject('Edit', { file_path: 'src/a.ts' }, CWD), 'edit: src/a.ts');
    assert.equal(canonicalSubject('Write', { filePath: 'src/a.ts' }, CWD), 'edit: src/a.ts');
    assert.equal(
      canonicalSubject('NotebookEdit', { notebook_path: 'n.ipynb' }, CWD),
      'notebook: n.ipynb',
    );
    assert.equal(canonicalSubject('Glob', { path: 'src/../src/a.ts' }, CWD), 'Glob: src/a.ts');
    assert.equal(canonicalSubject('mcp__server__tool', { q: 1 }, CWD), 'mcp:server:tool: {"q":1}');
    assert.equal(canonicalSubject('mcp__s__a__b', { q: 1 }, CWD), 'mcp:s:a__b: {"q":1}');
    assert.equal(canonicalSubject('mcp__x', { q: 1 }, CWD), 'mcp__x: {"q":1}');
    assert.equal(canonicalSubject('mcp____y', { q: 1 }, CWD), 'mcp____y: {"q":1}');
  });

  it('parses long MCP tool names in linear time', () => {
    const tool = `mcp__a__${'a__a'.repeat(50_000)}`;
    const started = performance.now();
    const subject = canonicalSubject(tool, { q: 1 }, CWD);
    assert.ok(performance.now() - started < 1_000);
    assert.equal(subject, `mcp:a:${'a__a'.repeat(50_000)}: {"q":1}`);
  });

  it('collapses whitespace only outside quotes', () => {
    assert.equal(
      canonicalSubject('Bash', { command: 'printf "a  b"   \'c  d\'' }, CWD),
      'shell: printf "a  b" \'c  d\'',
    );
  });

  it('omits missing and malformed tool metadata', () => {
    assert.equal(canonicalSubject('Bash', { command: '' }, CWD), undefined);
    assert.equal(canonicalSubject('Edit', { file_path: 4 }, CWD), undefined);
    assert.equal(canonicalSubject('Read', { path: '' }, CWD), undefined);
    assert.equal(canonicalSubject('Edit', {}, CWD), undefined);
    assert.equal(canonicalSubject('Read', 'not an object', CWD), undefined);
    assert.equal(canonicalSubject('Read', { filePath: 'a' }, undefined), undefined);
  });

  it('imports nothing from node:', () => {
    const source = readFileSync(new URL('../src/subject.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from 'node:|require\(|import\('node:/);
  });
});
