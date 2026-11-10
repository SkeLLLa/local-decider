/** Settings: where the status item sits in the sidebar and which decision rows reach the chat. */
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from '@getpaseo/plugin/client/ui';
import type { ReactNode } from 'react';

import {
  ROW_VISIBILITY,
  SIDEBAR_LABELS,
  SIDEBAR_POSITIONS,
  SIDEBAR_PRESS,
} from '../shared/constants.ts';
import type { DeciderSettings } from '../shared/settings.ts';
import { choices, type SectionProps } from './settings-common.ts';

export function SidebarSection({ values, save }: SectionProps): ReactNode {
  const sidebar = values.sidebar;
  const hidden = sidebar.position === 'hidden';
  const update = (next: Partial<DeciderSettings['sidebar']>): void =>
    save({ ...values, sidebar: { ...sidebar, ...next } });
  return (
    <SettingsSection
      title="Sidebar"
      info="A status row with a health dot: green when ready, amber while the model loads, red when the gateway is unreachable."
    >
      <SettingsCard>
        <SettingsSelect
          label="Position"
          value={sidebar.position}
          options={choices(SIDEBAR_POSITIONS, {
            footer: 'Bottom of the sidebar',
            header: 'Top of the sidebar',
            hidden: 'Hidden',
          })}
          onValueChange={(position) => update({ position })}
        />
        <SettingsSelect
          label="Label"
          value={sidebar.label}
          disabled={hidden}
          options={choices(SIDEBAR_LABELS, {
            full: 'Model and latency',
            model: 'Model',
            latency: 'Latency',
            minimal: 'Name only',
          })}
          onValueChange={(label) => update({ label })}
        />
        <SettingsSelect
          label="On press"
          value={sidebar.press}
          disabled={hidden}
          options={choices(SIDEBAR_PRESS, {
            popover: 'Show quick status',
            screen: 'Open the status screen',
          })}
          onValueChange={(press) => update({ press })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

export function RowsSection({ values, save }: SectionProps): ReactNode {
  const rows = values.rows;
  const off = rows.show === 'off';
  const update = (next: Partial<DeciderSettings['rows']>): void =>
    save({ ...values, rows: { ...rows, ...next } });
  return (
    <SettingsSection
      title="Decisions in chat"
      info="Each decision can appear as a compact row in the agent's chat. Hiding rows changes nothing else: decisions still run and are logged by the gateway."
    >
      <SettingsCard>
        <SettingsSelect
          label="Show"
          hint="Notable: changed something, needs attention, failed, or was below 70% confidence in shadow. /decide results always show."
          value={rows.show}
          options={choices(ROW_VISIBILITY, {
            all: 'Every decision',
            notable: 'Notable decisions only',
            off: 'None',
          })}
          onValueChange={(show) => update({ show })}
        />
        <SettingsSwitch
          label="Show details"
          hint="A second line with the model, latency and notes."
          value={rows.details}
          disabled={off}
          onValueChange={(details: boolean) => update({ details })}
        />
        <SettingsSwitch
          label="Ask for feedback"
          hint="Buttons to mark the right answer. It is sent to the gateway as ground truth for shadow stats and calibration."
          value={rows.feedback}
          disabled={off}
          onValueChange={(feedback: boolean) => update({ feedback })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
