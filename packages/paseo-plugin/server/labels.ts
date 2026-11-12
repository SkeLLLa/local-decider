/**
 * Permission-row labels (ADR-0006 addendum). The daemon remembers each labelable row it drew,
 * so a label RPC only names a row; the decision, kind and answer time come from here.
 * In memory: after a daemon restart, older rows can no longer be labelled.
 */
import {
  choicesFor,
  labelExpired,
  labelOutcome,
  rowLabelKind,
  type DecisionRow,
  type LabelChoice,
  type LabelKind,
} from '../shared/row.ts';
import type { HookDeps, PaseoLike } from './deps.ts';
import { BoundedMap } from './limits.ts';
import { appendRow } from './timeline.ts';

/** Enough for a busy day of prompts across agents; an evicted row is no longer labelable. */
const LABEL_REGISTRY_MAX = 2000;

interface LabelEntry {
  readonly agentId: string;
  readonly decisionId: string;
  readonly kind: LabelKind;
  readonly answeredAt: number;
  /** The row as the daemon last drew it. */
  row: DecisionRow;
  labelled: boolean;
}

export interface LabelInput {
  readonly agentId: string;
  readonly rowId: string;
  readonly label: LabelChoice;
}

export class LabelRegistry {
  readonly #entries: BoundedMap<LabelEntry>;

  constructor(max: number = LABEL_REGISTRY_MAX) {
    this.#entries = new BoundedMap(max);
  }

  /** Remember a row the daemon just drew; ignores rows that offer no labels. Keeps `labelled` for the same decision. */
  note(agentId: string, row: DecisionRow): void {
    const kind = rowLabelKind(row);
    if (kind === null || row.answeredAt === null || row.rowId === '') {
      return;
    }
    const key = registryKey(agentId, row.rowId);
    const prev = this.#entries.get(key);
    const labelled = prev?.decisionId === row.decisionId && prev.labelled;
    this.#entries.set(key, {
      agentId,
      decisionId: row.decisionId,
      kind,
      answeredAt: row.answeredAt,
      row,
      labelled,
    });
  }

  get(agentId: string, rowId: string): LabelEntry | undefined {
    return this.#entries.get(registryKey(agentId, rowId));
  }
}

function registryKey(agentId: string, rowId: string): string {
  return `${agentId}\u0000${rowId}`;
}

const CLOSED = 'This permission row can no longer be labelled.';

/** The entry a tap may label now, or throws. The daemon's clock and state are authoritative. */
function openEntry(labels: LabelRegistry, input: LabelInput, now: number): LabelEntry {
  const entry = labels.get(input.agentId, input.rowId);
  if (
    entry === undefined ||
    entry.labelled ||
    now < entry.answeredAt ||
    labelExpired(entry.answeredAt, now) ||
    !choicesFor(entry.kind).includes(input.label)
  ) {
    throw new Error(CLOSED);
  }
  return entry;
}

/**
 * A label chip tap: `unsafe` reports a verified veto as a `user` outcome for the decision the
 * daemon drew; `safe` and `skip` only mark the row. Throws so the client can toast.
 */
export async function recordPermissionLabel(
  deps: Pick<HookDeps, 'gateway'>,
  paseo: PaseoLike,
  labels: LabelRegistry,
  input: LabelInput,
  now: number = Date.now(),
): Promise<DecisionRow> {
  const entry = openEntry(labels, input, now);
  entry.labelled = true; // Claimed before any await, so a double tap reports once.
  try {
    await reportLabel(deps, entry.decisionId, input.label);
  } catch (error) {
    entry.labelled = false;
    throw error;
  }
  const next: DecisionRow = { ...entry.row, label: input.label };
  entry.row = next;
  await appendRow(paseo.agents.ref(entry.agentId), next);
  return next;
}

async function reportLabel(
  deps: Pick<HookDeps, 'gateway'>,
  decisionId: string,
  label: LabelChoice,
): Promise<void> {
  const outcome = labelOutcome(label);
  if (outcome === null) {
    return;
  }
  const gateway = await deps.gateway();
  const reported = gateway !== null && (await gateway.reportOutcome(decisionId, outcome, 'user'));
  if (!reported) {
    throw new Error('local-decider: the gateway did not record the label (is it running?).');
  }
}
