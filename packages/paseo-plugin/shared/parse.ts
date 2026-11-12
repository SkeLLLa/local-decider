/** Small readers shared by the lenient parsers of gateway bodies. Nothing here throws. */

export type Fields = Record<string, unknown>;

/** The longest text kept from a gateway body. */
export const MAX_TEXT = 500;

export function fields(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : null;
}

/** A non-empty string, truncated; null otherwise. */
export function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, MAX_TEXT) : null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** The value when it is one of `allowed`, else null (an unknown code). */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** The parsed entries of an array, at most `max`, skipping the ones that do not parse. */
export function items<T>(value: unknown, max: number, parse: (entry: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const entry of Array.isArray(value) ? (value as unknown[]).slice(0, max) : []) {
    const parsed = parse(entry);
    if (parsed !== null) {
      out.push(parsed);
    }
  }
  return out;
}

/** The `engine`, `model` and `device` every runtime-describing entry carries; null without the first two. */
export function runtimeOf(
  value: unknown,
): { v: Fields; engine: string; model: string; device: string | null } | null {
  const v = fields(value);
  const engine = str(v?.['engine']);
  const model = str(v?.['model']);
  return v === null || engine === null || model === null
    ? null
    : { v, engine, model, device: str(v['device']) };
}
