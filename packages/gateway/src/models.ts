/**
 * Decision models the managed engines can serve. Every id here is a fixed string: requests may
 * only name a catalogue entry (or the configured model), so nothing arbitrary reaches an engine's
 * command line or a download.
 */
export type CatalogEngine = 'strands-decider' | 'fastflowlm';

export interface KnownModel {
  readonly id: string;
  readonly engine: CatalogEngine;
  readonly label: string;
  /** Total download, adapter plus base where they are separate. */
  readonly downloadGb: number;
  /** Approximate memory while serving (fp32 on CPU for strands-decider; host memory for FLM). */
  readonly memoryGb: number;
  readonly latencyHint: string;
  readonly recommended?: boolean;
  /** Published quality: JevBench correct of 231, Brier (lower is better), Decision Index. */
  readonly quality?: {
    readonly jevBench?: number;
    readonly brier?: number;
    readonly decisionIndex?: number;
  };
  /** bf16 weights on a GPU / Apple silicon (the strands-decider README); CPU runs fp32. */
  readonly gpuMemoryGb?: number;
  readonly source?: string;
  /** strands-decider: the Hugging Face repos to download (adapter first, then base). */
  readonly hf?: readonly string[];
}

const STRANDS: readonly KnownModel[] = [
  {
    id: 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
    quality: { jevBench: 180, brier: 0.28 },
    gpuMemoryGb: 5,
    source: 'https://huggingface.co/StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
    engine: 'strands-decider',
    label: 'Strands 2B · Qwen3.5 (reference)',
    downloadGb: 4.8,
    memoryGb: 8,
    latencyHint: '~2.4 s on CPU, ~0.1 s on MLX',
    recommended: true,
    hf: ['StrandsAgents/strands-decider-2B-qwen3.5-v1-2610', 'Qwen/Qwen3.5-2B-Base'],
  },
  {
    id: 'StrandsAgents/strands-decider-2B-hobson-v21',
    quality: { jevBench: 176, brier: 0.323 },
    gpuMemoryGb: 5,
    source: 'https://huggingface.co/StrandsAgents/strands-decider-2B-hobson-v21',
    engine: 'strands-decider',
    label: 'Strands 2B · hobson v21',
    downloadGb: 4.6,
    memoryGb: 8,
    latencyHint: '~2.4 s on CPU',
    hf: ['StrandsAgents/strands-decider-2B-hobson-v21', 'Qwen/Qwen3.5-2B-Base'],
  },
  {
    id: 'StrandsAgents/strands-decider-2B-hobson-v19',
    quality: { jevBench: 167, brier: 0.342 },
    gpuMemoryGb: 5,
    source: 'https://huggingface.co/StrandsAgents/strands-decider-2B-hobson-v19',
    engine: 'strands-decider',
    label: 'Strands 2B · hobson v19 (window 3072)',
    downloadGb: 4.6,
    memoryGb: 8,
    latencyHint: '~2.4 s on CPU, 0.15 s on M3 Pro',
    hf: ['StrandsAgents/strands-decider-2B-hobson-v19', 'Qwen/Qwen3.5-2B-Base'],
  },
  {
    id: 'StrandsAgents/strands-decider-E2B-gemma4-v1-2610',
    quality: { jevBench: 180, brier: 0.313, decisionIndex: 29.78 },
    gpuMemoryGb: 9,
    source: 'https://huggingface.co/StrandsAgents/strands-decider-E2B-gemma4-v1-2610',
    engine: 'strands-decider',
    label: 'Strands E2B · Gemma 4',
    downloadGb: 10.6,
    memoryGb: 19,
    latencyHint: '~5 s on CPU, 102 ms on an H100',
    hf: ['StrandsAgents/strands-decider-E2B-gemma4-v1-2610', 'google/gemma-4-E2B-it'],
  },
  {
    id: 'StrandsAgents/strands-decider-E4B-gemma4-v1-2610',
    quality: { jevBench: 187, brier: 0.243, decisionIndex: 39.42 },
    gpuMemoryGb: 15,
    source: 'https://huggingface.co/StrandsAgents/strands-decider-E4B-gemma4-v1-2610',
    engine: 'strands-decider',
    label: 'Strands E4B · Gemma 4',
    downloadGb: 16.5,
    memoryGb: 30,
    latencyHint: '~7 s on CPU, 139 ms on an H100',
    hf: ['StrandsAgents/strands-decider-E4B-gemma4-v1-2610', 'google/gemma-4-E4B-it'],
  },
  {
    id: 'StrandsAgents/strands-decider-12B-gemma4-v1-2610',
    quality: { jevBench: 200, brier: 0.173, decisionIndex: 47.14 },
    gpuMemoryGb: 23,
    source: 'https://huggingface.co/StrandsAgents/strands-decider-12B-gemma4-v1-2610',
    engine: 'strands-decider',
    label: 'Strands 12B · Gemma 4',
    downloadGb: 24.8,
    memoryGb: 46,
    latencyHint: '~14 s on CPU, 136 ms on an H100',
    hf: ['StrandsAgents/strands-decider-12B-gemma4-v1-2610', 'google/gemma-4-12B-it'],
  },
  {
    id: 'StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610',
    quality: { jevBench: 207, brier: 0.162, decisionIndex: 48.69 },
    gpuMemoryGb: 51,
    source: 'https://huggingface.co/StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610',
    engine: 'strands-decider',
    label: 'Strands 26B-A4B · Gemma 4',
    downloadGb: 51.9,
    memoryGb: 101,
    latencyHint: '~8 s on CPU, 245 ms on an H100',
    hf: ['StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610', 'google/gemma-4-26B-A4B-it'],
  },
];

/** FastFlowLM's d3 (Decision 3.0, vLLM Semantic Router) family; measured here on the XDNA2 NPU. */
const D3: readonly KnownModel[] = [
  {
    id: 'd3:edge',
    source: 'https://huggingface.co/vllm-sr',
    engine: 'fastflowlm',
    label: 'd3 edge · Qwen3.5-0.8B, 12 layers (fastest, least accurate)',
    downloadGb: 0.6,
    memoryGb: 2,
    latencyHint: '~0.06 s (NPU, FLM figure)',
  },
  {
    id: 'd3:lite',
    source: 'https://fastflowlm.com/docs/models/d3/',
    engine: 'fastflowlm',
    label: 'd3 lite · Qwen3.5-0.8B',
    downloadGb: 0.8,
    memoryGb: 3,
    latencyHint: '~0.23 s (NPU, measured here)',
  },
  {
    id: 'd3:nano',
    source: 'https://fastflowlm.com/docs/models/d3/',
    engine: 'fastflowlm',
    label: 'd3 nano · Qwen3.5-2B',
    quality: { decisionIndex: 34.3 },
    downloadGb: 2,
    memoryGb: 5,
    latencyHint: '~0.33 s (NPU, measured here)',
  },
  {
    id: 'd3:mini',
    source: 'https://fastflowlm.com/docs/models/d3/',
    engine: 'fastflowlm',
    label: 'd3 mini · Qwen3.5-4B (best calibrated small model)',
    quality: { decisionIndex: 50 },
    downloadGb: 3.4,
    memoryGb: 9,
    latencyHint: '~0.5 s at 330 tokens (NPU, FLM figure)',
    recommended: true,
  },
  {
    id: 'd3:flash',
    source: 'https://huggingface.co/vllm-sr',
    engine: 'fastflowlm',
    label: 'd3 flash · 9B',
    downloadGb: 6.1,
    memoryGb: 14,
    latencyHint: '~0.85 s (NPU, FLM figure)',
  },
  {
    id: 'd3:turbo',
    source: 'https://fastflowlm.com/docs/models/d3/',
    engine: 'fastflowlm',
    label: 'd3 turbo · Qwen3.5-27B',
    downloadGb: 16.6,
    memoryGb: 28,
    latencyHint: '~3 s (NPU, FLM figure)',
  },
  {
    id: 'd3:ultra',
    source: 'https://fastflowlm.com/docs/models/d3/',
    engine: 'fastflowlm',
    label: 'd3 ultra · Qwen3.5-27B (newer fine-tune)',
    downloadGb: 16.6,
    memoryGb: 28,
    latencyHint: '~3 s (NPU, FLM figure)',
  },
];

export const KNOWN_MODELS: readonly KnownModel[] = [...STRANDS, ...D3];

export function catalogModel(id: string): KnownModel | undefined {
  return KNOWN_MODELS.find((m) => m.id === id);
}

/** Share of physical memory a decision model may take; the rest stays for the user's work. */
export const MEMORY_BUDGET = 0.8;

/** Memory a model needs on `device`: bf16 on an accelerator, fp32 (`memoryGb`) otherwise. */
export function modelMemoryGb(model: KnownModel, device?: string | null): number {
  const accelerated = device === 'mlx' || device === 'mps' || device === 'cuda';
  return accelerated && model.gpuMemoryGb !== undefined ? model.gpuMemoryGb : model.memoryGb;
}

/** False when a known model's estimated memory exceeds the budget; unknown models pass. */
export function modelFits(id: string, totalBytes: number, device?: string | null): boolean {
  const known = catalogModel(id);
  return known === undefined || modelMemoryGb(known, device) * 1e9 <= totalBytes * MEMORY_BUDGET;
}
