import { join } from 'node:path';

import type { Paths } from '../../paths.ts';
import type { ModelDescriptor } from '../descriptor.ts';

export interface PinnedFile {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly file: string;
}

const HF = 'https://huggingface.co/ggml-org';

const pin = (repo: string, rev: string, file: string, bytes: number, hex: string): PinnedFile => ({
  url: `${HF}/${repo}/resolve/${rev}/${file}`,
  sha256: `sha256:${hex}`,
  bytes,
  file,
});

export const GGUF: Readonly<Record<string, PinnedFile>> = {
  'd3-mini-q4_k_m': pin(
    'vllm-d3-mini-GGUF',
    '8b29fd3b87373ea85fa59cc2f26251c1591d771a',
    'vllm-d3-mini-Q4_K_M.gguf',
    3707523584,
    '1e5e5a87dd6903b6d8585331eee94a2f01d5069e369b143e1dceb9de51ba2902',
  ),
  'd3-mini-q8_0': pin(
    'vllm-d3-mini-GGUF',
    '8b29fd3b87373ea85fa59cc2f26251c1591d771a',
    'vllm-d3-mini-Q8_0.gguf',
    5157835264,
    'a4639297e407dd58d28dd2d23d112f853d0a78d13cbe86cdb644d23c8a84e62f',
  ),
  'd3-nano-q8_0': pin(
    'vllm-d3-nano-GGUF',
    'f2256dfaff5b8337e8bf67ca064aeef18ee14a79',
    'vllm-d3-nano-Q8_0.gguf',
    2552358496,
    'a4d7563d9622a4c34cc7276a3381c3e27a25bbf8d4c0f5ee2f1404fc89ce2ab9',
  ),
  'd3-lite-q8_0': pin(
    'vllm-d3-lite-GGUF',
    '0d544132bc35075d6346013f56454ea6dc19e640',
    'vllm-d3-lite-Q8_0.gguf',
    1082017408,
    '14e1d3ad398bdc245b5afe42e4e2a90e12b17fac699d3ab28c3b7632aaacc827',
  ),
  'd3-flash-q4_k_m': pin(
    'vllm-d3-flash-GGUF',
    '1307737011b75c2d1f389243484296d9d6c54a4f',
    'vllm-d3-flash-Q4_K_M.gguf',
    6603024896,
    'b8753da41b5170a884528940e4403d1a6bdef78de674f11b22358aeceea7750f',
  ),
};

export const LLAMA_MODELS: readonly ModelDescriptor<'llama-vulkan'>[] = [
  {
    id: 'd3-mini-q4_k_m',
    engine: 'llama-vulkan',
    label: 'D3 Mini Q4_K_M',
    downloadGb: 3.7,
    memoryGb: 5,
    latencyHint: null,
    recommended: true,
    quality: { decisionIndex: 50 },
    source: 'https://huggingface.co/ggml-org/vllm-d3-mini-GGUF',
  },
  {
    id: 'd3-nano-q8_0',
    engine: 'llama-vulkan',
    label: 'D3 Nano Q8_0',
    downloadGb: 2.6,
    memoryGb: 3.5,
    latencyHint: null,
    quality: { decisionIndex: 34.3 },
    source: 'https://huggingface.co/ggml-org/vllm-d3-nano-GGUF',
  },
  {
    id: 'd3-lite-q8_0',
    engine: 'llama-vulkan',
    label: 'D3 Lite Q8_0',
    downloadGb: 1.1,
    memoryGb: 2,
    latencyHint: '~0.15–0.6 s (Radeon 880M Vulkan, measured here)',
    source: 'https://huggingface.co/ggml-org/vllm-d3-lite-GGUF',
  },
  {
    id: 'd3-mini-q8_0',
    engine: 'llama-vulkan',
    label: 'D3 Mini Q8_0',
    downloadGb: 5.2,
    memoryGb: 6.5,
    latencyHint: null,
    source: 'https://huggingface.co/ggml-org/vllm-d3-mini-GGUF',
  },
  {
    id: 'd3-flash-q4_k_m',
    engine: 'llama-vulkan',
    label: 'D3 Flash Q4_K_M',
    downloadGb: 6.6,
    memoryGb: 8,
    latencyHint: null,
    source: 'https://huggingface.co/ggml-org/vllm-d3-flash-GGUF',
  },
];

export const LLAMA_MODEL_IDS = LLAMA_MODELS.map((model) => model.id) as [string, ...string[]];

export const ggufDir = (paths: Paths): string => join(paths.data, 'models', 'gguf');

export function ggufPath(paths: Paths, id: string): string | undefined {
  const pinned = GGUF[id];
  return pinned === undefined ? undefined : join(ggufDir(paths), pinned.file);
}
