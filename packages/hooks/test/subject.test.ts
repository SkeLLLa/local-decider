import { canonicalJson } from '@local-decider/core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { commandOf, isShellTool, permissionSubject, str, type HookInput } from '../src/subject.ts';

const collapse = (v: string): string => v.replace(/\s+/g, ' ').trim();

/** The pre-extraction implementation (mapping.ts, `node:path`), kept to prove parity. */
function legacySubject(hook: HookInput): string | undefined {
  const tool = str(hook['tool_name']);
  if (tool === undefined) {
    return undefined;
  }
  const input = hook['tool_input'];
  const fields =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const first = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const c = fields?.[key];
      if (typeof c === 'string' && c !== '') {
        return c;
      }
    }
    return undefined;
  };
  const command = isShellTool(hook) ? commandOf(hook) : undefined;
  const path = first(['file_path', 'filePath', 'path']);
  const url = first(['url']);
  const cwd = str(hook['cwd']) ?? '';
  let stable: string;
  if (fields === undefined) {
    stable = canonicalJson(input) ?? '';
  } else {
    const copy = { ...fields };
    delete copy['description'];
    stable = canonicalJson(copy);
  }
  const strip = (c: string): string => {
    const line = collapse(c);
    const prefix = `cd ${collapse(cwd)} && `;
    return line.startsWith(prefix) ? line.slice(prefix.length) : line;
  };
  const value =
    command !== undefined
      ? strip(command)
      : path !== undefined
        ? relative(cwd, resolve(cwd, path)).replaceAll('\\', '/')
        : (url ?? stable);
  return collapse(`${tool}: ${value}`);
}

const CWD = '/work/my-app';

const CASES: readonly HookInput[] = [
  { tool_name: 'Bash', cwd: CWD, tool_input: { command: 'cd /work/my-app && npm test' } },
  { tool_name: 'Bash', cwd: CWD, tool_input: { command: '  git   status\n --short ' } },
  { tool_name: 'Bash', cwd: CWD, tool_input: { command: ['bash', '-lc', 'rm -rf /tmp/x'] } },
  { tool_name: 'Bash', cwd: CWD, tool_input: { command: '' } },
  { tool_name: 'apply_patch', cwd: CWD, tool_input: { command: '*** Begin Patch\n+x' } },
  { tool_name: 'Read', cwd: CWD, tool_input: { file_path: '/work/my-app/src/a.ts' } },
  { tool_name: 'Read', cwd: CWD, tool_input: { file_path: 'src/./b/../a.ts' } },
  { tool_name: 'Edit', cwd: CWD, tool_input: { file_path: '/work/other/a.ts' } },
  { tool_name: 'Edit', cwd: CWD, tool_input: { file_path: '../x/y.ts' } },
  { tool_name: 'Edit', cwd: CWD, tool_input: { file_path: '/work/my-app' } },
  { tool_name: 'Edit', cwd: CWD, tool_input: { file_path: '//work//my-app///z.ts' } },
  { tool_name: 'Write', cwd: `${CWD}/`, tool_input: { filePath: '/work/my-app/n.ts' } },
  { tool_name: 'Glob', cwd: CWD, tool_input: { path: '/etc/../etc/hosts' } },
  { tool_name: 'Edit', cwd: '/', tool_input: { file_path: '/a/b' } },
  { tool_name: 'Edit', cwd: CWD, tool_input: { file_path: '/' } },
  { tool_name: 'Fetch', cwd: CWD, tool_input: { url: 'https://example.test/x' } },
  { tool_name: 'mcp__x__y', cwd: CWD, tool_input: { z: 1, description: 'ignored', a: { b: 2 } } },
  { tool_name: 'mcp__x__y', cwd: CWD, tool_input: 'plain' },
  { tool_name: 'mcp__x__y', cwd: CWD, tool_input: null },
  { tool_name: 'mcp__x__y', cwd: CWD, tool_input: [1, 2] },
  { cwd: CWD, tool_input: { command: 'ls' } },
];

describe('permissionSubject', () => {
  it('is identical to the node:path implementation it replaced', () => {
    for (const hook of CASES) {
      assert.equal(permissionSubject(hook), legacySubject(hook), JSON.stringify(hook));
    }
  });

  it('keeps the shapes the permission policy keys precedent on', () => {
    assert.equal(
      permissionSubject({
        tool_name: 'Bash',
        cwd: CWD,
        tool_input: { command: 'cd /work/my-app && npm test' },
      }),
      'Bash: npm test',
    );
    assert.equal(
      permissionSubject({
        tool_name: 'Read',
        cwd: CWD,
        tool_input: { file_path: '/work/my-app/src/a.ts' },
      }),
      'Read: src/a.ts',
    );
  });

  it('imports nothing from node:', () => {
    const source = readFileSync(new URL('../src/subject.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from 'node:|require\(|import\('node:/);
  });
});
