/** The one way the daemon draws or redraws a decision row on an agent's timeline. */
import { ROW_KIND, ROW_VERSION } from '../shared/constants.ts';
import type { DecisionRow } from '../shared/row.ts';
import type { AgentRefLike } from './deps.ts';

export async function appendRow(
  agent: Pick<AgentRefLike, 'timeline'>,
  row: DecisionRow,
): Promise<void> {
  await agent.timeline.append({
    type: 'plugin',
    id: row.rowId,
    kind: ROW_KIND,
    version: ROW_VERSION,
    data: { ...row },
  });
}
