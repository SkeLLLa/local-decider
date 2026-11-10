import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { jsonSchemas, schemaText } from '../src/schemas.ts';

const REPO_SCHEMAS = join(import.meta.dirname, '..', '..', '..', 'schemas');

describe('JSON Schemas', () => {
  it('match the committed copies (run `pnpm --filter @local-decider/gateway schemas`)', () => {
    for (const [name, schema] of Object.entries(jsonSchemas())) {
      // Compared as data: a formatter may reflow the committed file.
      const committed: unknown = JSON.parse(readFileSync(join(REPO_SCHEMAS, name), 'utf8'));
      assert.deepEqual(committed, JSON.parse(schemaText(schema)), name);
    }
  });

  it('describe the settings agents edit', () => {
    const config = jsonSchemas()['config.schema.json'] as {
      properties: Record<string, { description?: string }>;
    };
    for (const key of ['policies', 'routing', 'selection', 'lifecycle', 'pricing']) {
      assert.ok(config.properties[key]?.description, `${key} has a description`);
    }
  });
});
