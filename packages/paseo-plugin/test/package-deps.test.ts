import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// Paseo installs an npm plugin without its devDependencies and supplies only these host modules,
// so every other bare import must be a runtime dependency or the install fails to build.
const HOST_MODULES = [
  '@getpaseo/plugin',
  '@getpaseo/protocol',
  'react',
  'react-native',
  '@tanstack/react-query',
];

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  files: string[];
  dependencies?: Record<string, string>;
};

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return /\.tsx?$/.test(path) ? [path] : [];
  return readdirSync(path).flatMap((entry) => sourceFiles(join(path, entry)));
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function bareImports(): Set<string> {
  const names = new Set<string>();
  for (const entry of manifest.files) {
    const path = join(root, entry);
    let files: string[];
    try {
      files = sourceFiles(path);
    } catch {
      continue;
    }
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bfrom\s+'([^'.][^']*)'/g)) {
        const specifier = match[1] ?? '';
        if (!specifier.startsWith('node:')) names.add(packageName(specifier));
      }
    }
  }
  return names;
}

describe('published package', () => {
  it('declares every non-host import as a runtime dependency', () => {
    const runtime = new Set([...HOST_MODULES, ...Object.keys(manifest.dependencies ?? {})]);
    const missing = [...bareImports()].filter((name) => !runtime.has(name));
    assert.deepEqual(missing, []);
  });
});
