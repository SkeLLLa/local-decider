import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Paths } from './paths.ts';
import { defaultPolicyDir, type LoadedPolicy } from './policies.ts';

/** `policies/authoring/<id>.md`: a prompt that has an AI assistant write a variant of `<id>`. */
function templateFile(id: string): string {
  return join(defaultPolicyDir(), 'authoring', `${id}.md`);
}

/**
 * The authoring prompt for policy `id`, filled with where user policies go, the input keys its
 * adapters send, and the YAML of the policy and its current variants as examples.
 */
export function authoringPrompt(
  id: string,
  policies: ReadonlyMap<string, LoadedPolicy>,
  paths: Paths,
): string {
  const base = policies.get(id);
  const file = templateFile(id);
  if (base === undefined || base.policy.variantOf !== undefined || !existsSync(file)) {
    throw new Error(`no authoring prompt for policy "${id}"`);
  }
  const variants = [...policies.values()].filter(({ policy }) => policy.variantOf === id);
  const examples = [base, ...variants]
    .map(({ source }) => `\`\`\`yaml\n${readFileSync(source, 'utf8').trim()}\n\`\`\``)
    .join('\n\n');
  const inputKeys = base.policy.state.sections.map((s) => `\`${s.from}\``).join(', ');
  const values: Readonly<Record<string, string>> = {
    slot: id,
    policyDir: join(paths.config, 'policies'),
    schemaFile: join(paths.config, 'schemas', 'policy.schema.json'),
    configFile: join(paths.config, 'config.yaml'),
    configSchemaFile: join(paths.config, 'schemas', 'config.schema.json'),
    inputKeys,
    examples,
  };
  return readFileSync(file, 'utf8').replaceAll(
    /\{\{(\w+)\}\}/g,
    (match, key: string) => values[key] ?? match,
  );
}
