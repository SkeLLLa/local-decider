import { defineSettings } from '@getpaseo/plugin';

import { migrateStored, SETTINGS_VERSION, settingsSchema } from './settings-schema.ts';

export type { DeciderSettings } from './settings-schema.ts';

/**
 * Host settings. Plain JSON that every authorized client can read: never put a token here. A
 * remote gateway token comes only from `LOCAL_DECIDER_TOKEN` in the daemon's environment.
 */
export const deciderSettings = defineSettings({
  id: 'local-decider',
  scope: 'host',
  version: SETTINGS_VERSION,
  schema: settingsSchema,
  migrate: migrateStored,
});
