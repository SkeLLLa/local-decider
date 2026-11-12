import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

interface VerifiedRecord {
  readonly sha256: string;
  readonly files: Readonly<Record<string, FileStamp>>;
}

const COMPONENT = /^[A-Za-z0-9._+-]+$/;

export const recordPath = (target: string): string => `${target}.verified.json`;

function stamp(path: string): FileStamp | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return undefined;
    return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
  } catch {
    return undefined;
  }
}

function validRel(rel: string): boolean {
  return rel === '' || (COMPONENT.test(rel) && rel !== '.' && rel !== '..');
}

function validStamp(value: unknown): value is FileStamp {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ['size', 'mtimeMs', 'ino'].every(
    (key) => typeof item[key] === 'number' && Number.isFinite(item[key]),
  );
}

function validRecord(value: unknown, sha256: string): value is VerifiedRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const files = record['files'];
  if (
    record['sha256'] !== sha256 ||
    typeof files !== 'object' ||
    files === null ||
    Array.isArray(files)
  )
    return false;
  const entries = Object.entries(files as Record<string, unknown>);
  return entries.length > 0 && entries.every(([rel, entry]) => validRel(rel) && validStamp(entry));
}

function sameStamp(left: FileStamp | undefined, right: FileStamp): boolean {
  return (
    left !== undefined &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ino === right.ino
  );
}

export function recordMatches(target: string, sha256: string): boolean {
  try {
    const record: unknown = JSON.parse(readFileSync(recordPath(target), 'utf8'));
    if (!validRecord(record, sha256)) return false;
    return Object.entries(record.files).every(([rel, expected]) =>
      sameStamp(stamp(rel === '' ? target : join(target, rel)), expected),
    );
  } catch {
    return false;
  }
}

export function writeRecord(target: string, sha256: string, rels: readonly string[]): void {
  const files: Record<string, FileStamp> = {};
  for (const rel of rels) {
    if (!validRel(rel) || Object.hasOwn(files, rel))
      throw new Error(`invalid verified file: ${rel}`);
    const fileStamp = stamp(rel === '' ? target : join(target, rel));
    if (fileStamp === undefined) throw new Error(`cannot verify missing file: ${rel}`);
    files[rel] = fileStamp;
  }
  if (rels.length === 0) throw new Error('verified record must contain files');
  const record: VerifiedRecord = { sha256, files };
  writeFileSync(recordPath(target), `${JSON.stringify(record)}\n`, { flag: 'w', mode: 0o600 });
}
