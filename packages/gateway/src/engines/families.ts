import { catalogModel } from '../models.ts';
import type { ModelDescriptor } from './descriptor.ts';
import type { EngineId } from './registry.ts';

/** Labels for verified base checkpoints; upstream sources are cited in the catalogues. */
const FAMILY_LABELS: Readonly<Record<string, string>> = {
  'vllm-sr/d3-lite': 'd3 lite',
  'vllm-sr/d3-nano': 'd3 nano',
  'vllm-sr/d3-mini': 'd3 mini',
  'vllm-sr/d3-flash': 'd3 flash',
};

/** Family id: verified base checkpoint, else the catalogue model's singleton id. */
export function familyId(model: Pick<ModelDescriptor, 'engine' | 'id' | 'baseModel'>): string {
  return model.baseModel ?? `${model.engine}:${model.id}`;
}

/** Human readable name for a family known to the local catalogue. */
export function familyLabel(id: string): string {
  const label = FAMILY_LABELS[id];
  if (label !== undefined) return label;
  const separator = id.indexOf(':');
  if (separator < 1) return id;
  const model = catalogModel(id.slice(separator + 1), id.slice(0, separator) as EngineId);
  return model?.label ?? id;
}

/** Returns null for models that are not in a static engine catalogue. */
export function familyOf(model: string, engine: string): string | null {
  const descriptor = catalogModel(model, engine as EngineId);
  return descriptor === undefined ? null : familyId(descriptor);
}

export function isKnownFamily(id: string): boolean {
  if (Object.hasOwn(FAMILY_LABELS, id)) return true;
  const separator = id.indexOf(':');
  return separator > 0 && familyOf(id.slice(separator + 1), id.slice(0, separator)) === id;
}

export function formatOf(quant: string | undefined): { short: string; label: string } | null {
  if (quant === undefined) return null;
  if (quant === 'Q4_K_M') return { short: quant, label: '4-bit (Q4_K_M)' };
  if (quant === 'Q8_0') return { short: quant, label: '8-bit (Q8_0)' };
  if (quant === 'FLM') return { short: quant, label: 'NPU format (FLM)' };
  return { short: quant, label: quant };
}
