/**
 * "Write with an agent": start a Paseo agent in the gateway's config directory, already given
 * the authoring prompt, and open it. The agent interviews the user, writes a routing variant
 * and maps its presets in config.yaml.
 */
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { usePaseo, useRpc } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsSelect } from '@getpaseo/plugin/client/ui';
import { useState, type ReactNode } from 'react';

import { policyPromptRpc } from '../shared/rpc.ts';
import { useAction } from './hooks.ts';
import { InlineMessage, type Theme } from './ui.tsx';

const ROUTING_POLICY = 'routing';
const AGENT_TITLE = 'Write a routing policy';

export function WritePolicyRows({
  theme,
  navigation,
  modelOptions,
}: {
  theme: Theme;
  navigation: PluginSurfaceProps['navigation'];
  modelOptions: readonly { label: string; value: string }[];
}): ReactNode {
  const paseo = usePaseo();
  const getPrompt = useRpc(policyPromptRpc);
  const action = useAction();
  const choices = modelOptions.filter((o) => o.value !== '');
  const [model, setModel] = useState('');
  const chosen =
    model !== '' && choices.some((o) => o.value === model) ? model : (choices[0]?.value ?? '');
  const start = (): void => {
    void action.run('agent', async () => {
      const prompt = await getPrompt({ policy: ROUTING_POLICY });
      if (!prompt.ok) {
        return { tone: 'error', text: prompt.error ?? 'No prompt from the gateway.' };
      }
      const agent = await paseo.agents.create({
        config: { provider: chosen },
        cwd: prompt.cwd,
        title: AGENT_TITLE,
        prompt: prompt.prompt,
      });
      navigation?.openAgent({ agentId: agent.id });
      return { tone: 'success', text: `Started "${AGENT_TITLE}" in ${prompt.cwd}.` };
    });
  };
  return (
    <>
      <SettingsSelect
        label="Agent for writing a policy"
        hint="Runs in the gateway's config directory with a prompt that asks about your models and tasks, writes a routing policy, and maps its presets in config.yaml."
        value={chosen}
        options={choices.length === 0 ? [{ label: 'No provider models', value: '' }] : choices}
        onValueChange={setModel}
      />
      <SettingsAction
        label="Write your own routing policy"
        actionLabel={action.busy === 'agent' ? 'Starting…' : 'Write with an agent'}
        disabled={chosen === '' || action.busy !== null}
        onPress={start}
      />
      {action.outcome === null ? null : (
        <InlineMessage theme={theme} tone={action.outcome.tone} text={action.outcome.text} />
      )}
    </>
  );
}
