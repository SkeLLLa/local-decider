import type { DeciderSettings } from '../shared/settings.ts';

/** Saves a whole settings document against the revision on screen. */
export type Save = (next: DeciderSettings) => void;

export interface SectionProps {
  readonly values: DeciderSettings;
  readonly save: Save;
}

/** Select options from enum values, with friendly labels where given. */
export function choices<V extends string>(
  values: readonly V[],
  labels: Partial<Record<V, string>> = {},
): { label: string; value: V }[] {
  return values.map((value) => ({ label: labels[value] ?? value, value }));
}
