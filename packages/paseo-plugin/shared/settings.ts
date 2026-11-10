import { defineSettings } from '@getpaseo/plugin';

import { migrateV1, settingsSchema } from './settings-schema.ts';

export type { DeciderSettings } from './settings-schema.ts';

/**
 * Host settings. Plain JSON that every authorized client can read: never put a token here. A
 * remote gateway token comes only from `LOCAL_DECIDER_TOKEN` in the daemon's environment.
 */
export const deciderSettings = defineSettings({
  id: 'local-decider',
  scope: 'host',
  version: 2,
  schema: settingsSchema,
  migrate: (values, fromVersion) => (fromVersion < 2 ? migrateV1(values) : values),
});
