import { defineSettings } from '@getpaseo/plugin';

import { migrateStored, SETTINGS_VERSION, settingsSchema } from './settings-schema.ts';

export type { DeciderSettings } from './settings-schema.ts';

/**
 * Host settings. Plain JSON that every authorized client can read: tokens never live here. A
 * bearer goes only to loopback or to `LOCAL_DECIDER_TOKEN_ORIGIN` from the daemon environment.
 */
export const deciderSettings = defineSettings({
  id: 'local-decider',
  scope: 'host',
  version: SETTINGS_VERSION,
  schema: settingsSchema,
  migrate: migrateStored,
});
