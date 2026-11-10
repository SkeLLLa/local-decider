import type { Action, PermissionMode } from '@local-decider/core';

export const CALL_STORE_MAX = 2000;
export const CALL_STORE_TTL_MS = 10 * 60 * 1000;

/** What one policy decided for a harness tool call. */
export interface CallDecision {
  readonly decisionId: string;
  readonly action: Action;
  readonly enforced: boolean;
  /** False when the decision is the policy default because no engine answered. */
  readonly answered: boolean;
}

export interface CallRecord {
  readonly permissionMode?: PermissionMode;
  /** Policy id → its decision for this call. */
  readonly decisions: Readonly<Record<string, CallDecision>>;
}

interface Entry {
  permissionMode?: PermissionMode;
  decisions: Record<string, CallDecision>;
  expires: number;
}

/**
 * In-memory index of recent harness tool calls (LRU, 2000 entries, 10 minutes), so another
 * caller can ask what the decider said about a call and in which permission mode it ran.
 * Never persisted: the shadow log is the durable record.
 */
export class CallStore {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #max: number;
  readonly #ttlMs: number;

  constructor(options: { now?: () => number; max?: number; ttlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#max = options.max ?? CALL_STORE_MAX;
    this.#ttlMs = options.ttlMs ?? CALL_STORE_TTL_MS;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Record `policyId`'s decision for call `id`; the newest write refreshes the entry's TTL. */
  note(
    id: string,
    policyId: string,
    decision: CallDecision,
    permissionMode?: PermissionMode,
  ): void {
    const previous = this.#live(id);
    const mode = permissionMode ?? previous?.permissionMode;
    this.#entries.delete(id);
    this.#entries.set(id, {
      decisions: { ...previous?.decisions, [policyId]: decision },
      expires: this.#now() + this.#ttlMs,
      ...(mode === undefined ? {} : { permissionMode: mode }),
    });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#entries.delete(oldest);
    }
  }

  get(id: string): CallRecord | undefined {
    const entry = this.#live(id);
    if (entry === undefined) {
      return undefined;
    }
    return {
      ...(entry.permissionMode === undefined ? {} : { permissionMode: entry.permissionMode }),
      decisions: entry.decisions,
    };
  }

  #live(id: string): Entry | undefined {
    const entry = this.#entries.get(id);
    if (entry !== undefined && entry.expires <= this.#now()) {
      this.#entries.delete(id);
      return undefined;
    }
    return entry;
  }
}
