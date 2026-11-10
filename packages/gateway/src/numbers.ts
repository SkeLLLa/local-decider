/** Upper bound of the Wilson 95% interval for `events` out of `n` (n > 0). */
export function wilsonUpper(events: number, n: number): number {
  const z = 1.96;
  const z2 = z * z;
  const rate = events / n;
  return (
    (rate + z2 / (2 * n) + z * Math.sqrt((rate * (1 - rate)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  );
}

/** Lower bound of the Wilson 95% interval for `successes` out of `n` (n > 0). */
export function wilsonLower(successes: number, n: number): number {
  return 1 - wilsonUpper(n - successes, n);
}

/** The `p`th percentile (nearest rank) of an ascending list; undefined when it is empty. */
export function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) {
    return undefined;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
