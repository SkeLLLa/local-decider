# ADR-0011: llama.cpp Vulkan engine for Linux

- **Status:** accepted
- **Date:** 2026-11-12

## Context

Linux GPUs other than NVIDIA had no calibrated local decision engine. The d3 decision models
already used by FastFlowLM are available as pinned GGUF files, and current llama.cpp builds expose
their native `/v1/systemone` endpoint.

## Decision

- Add `llama-vulkan`, a supervised Linux x86_64 engine using a user-installed Vulkan-enabled
  `llama-server` and the native `/v1/systemone` wire format.
- Pin each d3 GGUF to a Hugging Face revision and SHA-256. Store model files under the local
  data directory and write a `.verified.json` record after checking the digest.
- Resolve the server from `engines.llama-vulkan.binary`, `tools.llamaServer`, then `PATH`. The
  gateway does not download llama.cpp or another tool.
- Rank the Vulkan backend after NVIDIA CUDA and before Apple-specific backends and CPU.
- Confirm hardware Vulkan through `vulkaninfo --summary`, excluding software renderers such as
  llvmpipe, lavapipe and SwiftShader.
- Use `/v1/systemone` directly; no OpenAI logprob adapter is needed for d3 decision models.

## Consequences

- Users install a Vulkan-enabled llama.cpp build themselves. Fedora 44's packaged `llama-server`
  is HIP/ROCm build `b6153`, not Vulkan, and predates d3 support. Upstream added d3 support in
  `b11572` ([PR #30383](https://github.com/ggml-org/llama.cpp/pull/30383)).
- A change to an upstream GGUF requires updating the pinned revision and digest and rerunning the
  model installer tests.
- On unified-memory systems, the model's estimated memory requirement is checked against system
  RAM. Quant quality and non-lite model latency remain to be measured.
