/** The engine's load lifecycle: plain-language state notes and the idle-minutes input. */
import { shortModel } from './models.ts';

export const IDLE_MINUTES = { min: 1, max: 1440, fallback: 15 } as const;

export interface EngineStateLike {
  readonly state: string | null;
  readonly detail: string | null;
  readonly model: string | null;
  /** Short engine tag, e.g. `NPU`. */
  readonly engineTag: string | null;
  readonly lifecycle?: 'lazy' | 'eager' | null;
  /** Progress of a running benchmark job. */
  readonly benchmark?: { readonly completed: number; readonly total: number } | null;
}

function loadedNote(s: EngineStateLike): string {
  const parts = ['Loaded'];
  if (s.model !== null && s.model !== '') {
    parts.push(shortModel(s.model));
  }
  if (s.engineTag !== null) {
    parts.push(s.engineTag);
  }
  return parts.join(' · ');
}

/**
 * `Loaded · d3:nano · NPU`, `Unloaded · loads automatically on the next decision`, `Loading…`,
 * `Failed: <detail>`, and `Benchmarking (3 of 6)` while a benchmark runs.
 */
function stateNote(s: EngineStateLike | undefined): string {
  switch (s?.state ?? null) {
    case 'ready':
      return loadedNote(s as EngineStateLike);
    case 'starting':
      return 'Loading…';
    case 'failed':
      return `Failed: ${s?.detail ?? 'no detail from the gateway'}`;
    case 'stopped':
      return s?.lifecycle === 'eager'
        ? 'Unloaded · press Load now to load it'
        : 'Unloaded · loads automatically on the next decision';
    case null:
      return 'Engine state unknown';
    default:
      return s?.state ?? 'Engine state unknown';
  }
}

export function engineStateNote(s: EngineStateLike | undefined): string {
  const b = s?.benchmark;
  return b == null ? stateNote(s) : `Benchmarking (${String(b.completed)} of ${String(b.total)})`;
}

/** Why the idle-minutes draft is unusable, or null. */
export function idleMinutesError(draft: string): string | null {
  const text = draft.trim();
  if (!/^\d+$/.test(text)) {
    return 'Enter whole minutes.';
  }
  const minutes = Number(text);
  return minutes >= IDLE_MINUTES.min && minutes <= IDLE_MINUTES.max
    ? null
    : `Between ${String(IDLE_MINUTES.min)} and ${String(IDLE_MINUTES.max)} minutes.`;
}

export type LifecycleChoice = 'lazy' | 'eager';

export function lifecycleLabel(choice: LifecycleChoice, minutes: number | null): string {
  return choice === 'eager'
    ? 'Always loaded'
    : `Automatic: load on demand, unload after ${String(minutes ?? IDLE_MINUTES.fallback)} min idle`;
}
