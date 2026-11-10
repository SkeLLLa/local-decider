/** Decision models the strands-decider engine can serve (Hugging Face, Apache-2.0, ungated). */
export interface KnownModel {
  readonly id: string;
  readonly base: string;
  readonly baseSizeGb: number;
  /** Approximate fp32 CPU / bf16 GPU memory. */
  readonly memoryGb: number;
  readonly jevBench: number;
}

export const KNOWN_MODELS: readonly KnownModel[] = [
  {
    id: 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
    base: 'Qwen/Qwen3.5-2B-Base',
    baseSizeGb: 4.55,
    memoryGb: 8,
    jevBench: 180,
  },
  {
    id: 'StrandsAgents/strands-decider-2B-hobson-v21',
    base: 'Qwen/Qwen3.5-2B-Base',
    baseSizeGb: 4.55,
    memoryGb: 8,
    jevBench: 176,
  },
  {
    id: 'StrandsAgents/strands-decider-E2B-gemma4-v1-2610',
    base: 'google/gemma-4-E2B-it',
    baseSizeGb: 10.25,
    memoryGb: 19,
    jevBench: 180,
  },
  {
    id: 'StrandsAgents/strands-decider-E4B-gemma4-v1-2610',
    base: 'google/gemma-4-E4B-it',
    baseSizeGb: 15.99,
    memoryGb: 30,
    jevBench: 187,
  },
  {
    id: 'StrandsAgents/strands-decider-12B-gemma4-v1-2610',
    base: 'google/gemma-4-12B-it',
    baseSizeGb: 23.92,
    memoryGb: 46,
    jevBench: 200,
  },
  {
    id: 'StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610',
    base: 'google/gemma-4-26B-A4B-it',
    baseSizeGb: 51.61,
    memoryGb: 101,
    jevBench: 207,
  },
];
