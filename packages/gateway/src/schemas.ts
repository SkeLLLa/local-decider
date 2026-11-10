/**
 * JSON Schemas for config.yaml and policy files, generated from the zod schemas so they never
 * drift. Editors (yaml-language-server) and agents use them; the repo keeps a copy in `schemas/`
 * that a test compares with this output.
 */
import { policySchema } from '@local-decider/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { configSchema } from './config.ts';

/** `$id`s point at the repository copy, so a schema can be fetched as well as written locally. */
const BASE = 'https://raw.githubusercontent.com/SkeLLLa/local-decider/main/schemas';

function schemaOf(schema: z.ZodType, name: string, title: string): Record<string, unknown> {
  return {
    $id: `${BASE}/${name}`,
    title,
    ...z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
  };
}

export function jsonSchemas(): Readonly<Record<string, Record<string, unknown>>> {
  return {
    'config.schema.json': schemaOf(configSchema, 'config.schema.json', 'local-decider config.yaml'),
    'policy.schema.json': schemaOf(policySchema, 'policy.schema.json', 'local-decider policy'),
  };
}

export function schemaText(schema: Record<string, unknown>): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

/** Write both schemas into `dir` (`<config dir>/schemas`); returns their paths by file name. */
export function writeSchemas(dir: string): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  return Object.fromEntries(
    Object.entries(jsonSchemas()).map(([name, schema]) => {
      const file = join(dir, name);
      writeFileSync(file, schemaText(schema));
      return [name, file];
    }),
  );
}
