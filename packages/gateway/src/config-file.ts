/**
 * `config.yaml` as the one place settings live. The settings pages, the CLI and agents all edit
 * it; edits keep comments and key order, are validated before anything is written, and the file
 * is replaced atomically. The gateway watches it (and `policies/`) and applies changes live.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { join } from 'node:path';
import { isMap, parseDocument, type Document } from 'yaml';

import { configFile, parseConfig, type GatewayConfig } from './config.ts';
import type { Paths } from './paths.ts';
import { stateEdits } from './state.ts';

/** A key path into the config (`['policies', 'routing', 'mode']`); `undefined` value = remove. */
export interface ConfigEdit {
  readonly path: readonly string[];
  readonly value: unknown;
}

export interface ConfigStore {
  readonly current: GatewayConfig;
  /** The file behind the settings; absent when they only live in memory. */
  readonly file?: string;
  /** Re-read the file; true when it changed. Throws on invalid content. */
  reload?(): boolean;
  /** Apply edits, validate, persist; throws (and changes nothing) when the result is invalid. */
  update(edits: readonly ConfigEdit[]): GatewayConfig;
}

/** Relative to the config dir, so the same header works wherever that dir is. */
const CONFIG_SCHEMA_HEADER = ' yaml-language-server: $schema=schemas/config.schema.json';

/** Remove maps an edit left empty, so removing the last key of a section drops the section. */
function prune(doc: Document, path: readonly string[]): void {
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    const parent = path.slice(0, depth);
    const node = doc.getIn(parent, true);
    if (!isMap(node) || node.items.length > 0) {
      return;
    }
    doc.deleteIn(parent);
  }
}

function applyEdits(doc: Document, edits: readonly ConfigEdit[]): void {
  if (!isMap(doc.contents)) {
    doc.contents = doc.createNode({});
  }
  for (const { path, value } of edits) {
    if (value === undefined) {
      doc.deleteIn(path);
      prune(doc, path);
    } else {
      doc.setIn(path, value);
    }
  }
}

/** Parse and validate config text; `{}` for an empty file. */
function parseText(text: string, origin: string): { doc: Document; config: GatewayConfig } {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new Error(`${origin}: invalid YAML: ${doc.errors[0]?.message ?? ''}`);
  }
  try {
    return { doc, config: parseConfig(doc.toJS() ?? {}) };
  } catch (error) {
    throw new Error(`${origin}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

/** In-memory settings (tests, injected configs): edits are validated but never written. */
export class MemoryConfigStore implements ConfigStore {
  #doc: Document;
  #current: GatewayConfig;

  constructor(config: GatewayConfig) {
    this.#doc = parseDocument('{}');
    this.#doc.contents = this.#doc.createNode(config);
    this.#current = config;
  }

  get current(): GatewayConfig {
    return this.#current;
  }

  update(edits: readonly ConfigEdit[]): GatewayConfig {
    const next = this.#doc.clone();
    applyEdits(next, edits);
    this.#current = parseConfig(next.toJS());
    this.#doc = next;
    return this.#current;
  }
}

export class ConfigFile implements ConfigStore {
  readonly file: string;
  readonly #dir: string;
  #text: string;
  #current: GatewayConfig;

  private constructor(dir: string, file: string, text: string, config: GatewayConfig) {
    this.#dir = dir;
    this.file = file;
    this.#text = text;
    this.#current = config;
  }

  /** Read `config.yaml` (missing = defaults) and fold a pre-YAML `state.json` into it once. */
  static open(paths: Paths, file: string = configFile(paths)): ConfigFile {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const store = new ConfigFile(paths.config, file, text, parseText(text, file).config);
    const legacy = join(paths.data, 'state.json');
    if (existsSync(legacy)) {
      const edits = stateEdits(legacy);
      if (edits.length > 0) {
        store.update(edits);
      }
      renameSync(legacy, `${legacy}.migrated`);
    }
    return store;
  }

  get current(): GatewayConfig {
    return this.#current;
  }

  update(edits: readonly ConfigEdit[]): GatewayConfig {
    const { doc } = parseText(this.#text, this.file);
    applyEdits(doc, edits);
    if (!(doc.commentBefore ?? '').includes('yaml-language-server')) {
      doc.commentBefore = [CONFIG_SCHEMA_HEADER, doc.commentBefore].filter(Boolean).join('\n');
    }
    const text = doc.toString();
    const config = parseText(text, this.file).config;
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, this.file);
    this.#text = text;
    this.#current = config;
    return config;
  }

  /**
   * Re-read the file. False when it did not change (e.g. our own write); throws when the new
   * content is invalid, keeping the previous settings.
   */
  reload(): boolean {
    const text = existsSync(this.file) ? readFileSync(this.file, 'utf8') : '';
    if (text === this.#text) {
      return false;
    }
    this.#current = parseText(text, this.file).config;
    this.#text = text;
    return true;
  }

  /**
   * Call `onConfig` after `config.yaml` changes and `onPolicies` after a file in `policies/`
   * does, each debounced. Returns a function that stops watching.
   */
  watch(handlers: { onConfig: () => void; onPolicies: () => void }, delayMs = 250): () => void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const timers = new Map<string, NodeJS.Timeout>();
    const later = (key: string, run: () => void): void => {
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(run, delayMs));
    };
    let watcher: FSWatcher;
    try {
      watcher = watch(this.#dir, { recursive: true, persistent: false }, (_event, name) => {
        const path = name ?? '';
        if (path === 'config.yaml') {
          later('config', handlers.onConfig);
        } else if (/^policies[/\\][^/\\]+\.ya?ml$/.test(path)) {
          later('policies', handlers.onPolicies);
        }
      });
    } catch {
      return () => {};
    }
    return () => {
      watcher.close();
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    };
  }
}
