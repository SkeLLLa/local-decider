/** Short forms of decision model ids for rows, labels and the sidebar. */

/** `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610` → `2B-qwen3.5-v1-2610`. */
export function shortModel(model: string): string {
  return model.replace(/^StrandsAgents\//, '').replace(/^strands-decider-/, '');
}

/**
 * Family and size, for tight spaces: `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610` →
 * `qwen3.5 2B`. Ids that do not look like `<size>-<family>-…` fall back to `shortModel`.
 */
export function compactModel(model: string): string {
  const short = shortModel(model);
  const [size, family] = short.split('-');
  return size !== undefined && family !== undefined && /^E?\d+B$/.test(size)
    ? `${family} ${size}`
    : short;
}
