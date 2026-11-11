# Changelog

## [1.1.0](https://github.com/ziptie-soft/local-decider/compare/local-decider-v1.0.0...local-decider-v1.1.0) (2026-11-11)


### Features

* **cli:** configure OpenAI-compatible engine connections ([39be02a](https://github.com/ziptie-soft/local-decider/commit/39be02a60d1b906dc60e5777622555cc8ffc3087))
* **cli:** list and select gateway engines ([7e832b6](https://github.com/ziptie-soft/local-decider/commit/7e832b67be1804402362f5e6054c5f592a5e24ad))
* **cli:** plan engine installs from host acceleration ([805d416](https://github.com/ziptie-soft/local-decider/commit/805d416331d2cc343a601c064815e2befb60d1f6))
* **gateway:** add LM Studio engine ([9793063](https://github.com/ziptie-soft/local-decider/commit/9793063a2a443e6a372b66d7a6a6b73f003b7e7f))
* **gateway:** call and scope request fields with per-scope policy modes ([0257f6c](https://github.com/ziptie-soft/local-decider/commit/0257f6cdd00d1bf4a738d2a3c90203801d0a0f25))
* **gateway:** discover LM Studio native models ([2ef92ff](https://github.com/ziptie-soft/local-decider/commit/2ef92ff29619eb189f7313cd006f23881baa1fda))
* **gateway:** discover local OpenAI-compatible servers ([1421dcf](https://github.com/ziptie-soft/local-decider/commit/1421dcf23c521cb40f49006c3f8096da8e0eb44a))
* **gateway:** discover OpenAI-compatible models ([9c26f5f](https://github.com/ziptie-soft/local-decider/commit/9c26f5fce03d6eea99f5454e00e55aa9d0a9a6cb))
* **gateway:** engine switching uses per-engine options ([2ae9902](https://github.com/ziptie-soft/local-decider/commit/2ae99028f0a038197e4137e9a070fc804f3a99a8))
* **gateway:** engines view reports per-host support from descriptors ([daca097](https://github.com/ziptie-soft/local-decider/commit/daca0972d5a7e4d14359b77b89c83d06f371c0d4))
* **gateway:** expose engine metadata and tags ([ed7cdf5](https://github.com/ziptie-soft/local-decider/commit/ed7cdf5cb0d8f7c64b95a17f168c29a97508af1d))
* **gateway:** fall back to the next accelerated engine in auto mode ([c6dc18d](https://github.com/ziptie-soft/local-decider/commit/c6dc18d02bfa855e376c83997f9fcf3d5ae0ccbb))
* **gateway:** fastflowlm d3 engine, switchable engines, lazy lifecycle, model catalogue and downloads, tool paths, runtime policy modes, queue priorities ([91c59ce](https://github.com/ziptie-soft/local-decider/commit/91c59ce1bc04ba495f48c8aca1e54c539f2f83de))
* **gateway:** in-memory call store and GET /v1/calls/:id ([5cc6f42](https://github.com/ziptie-soft/local-decider/commit/5cc6f420976f16733768b3ad01d0b50004794c15))
* **gateway:** logprob scoring for openai-compatible engines ([9f58568](https://github.com/ziptie-soft/local-decider/commit/9f585686fb45960803c69623af52ca4616e65b5d))
* **gateway:** LogStore interface and opt-in SQLite log store with backup, export and import ([c110eb3](https://github.com/ziptie-soft/local-decider/commit/c110eb3cc74f611b6fbd6dec932db82f4b83a835))
* **gateway:** make OpenAI-compatible engine switchable ([ffc1975](https://github.com/ziptie-soft/local-decider/commit/ffc1975cbe1403fe76df6820153e38ec1c782c6d))
* **gateway:** openai-compatible logprob engine ([58fd24e](https://github.com/ziptie-soft/local-decider/commit/58fd24e6a1c07770c33e5fe39ad50086dad2652e))
* **gateway:** openai-compatible output budget, prompt suffix and think-token skipping ([2ea0301](https://github.com/ziptie-soft/local-decider/commit/2ea03012fc1562f843f435afbfdec4392f32fad3))
* **gateway:** per-engine options map in config ([c598945](https://github.com/ziptie-soft/local-decider/commit/c598945a72bd98a1d88c95e810529fbac0b4612f))
* **gateway:** policy thresholds config, engine control and decider updates ([e0a4a35](https://github.com/ziptie-soft/local-decider/commit/e0a4a35d71b6aac4c8c3fced52bf1dcf7662b745))
* **gateway:** recommend accelerated engines from host capability probes ([1ca4e79](https://github.com/ziptie-soft/local-decider/commit/1ca4e79859adf770c3898ab3c50e3aefe78ad09d))
* **gateway:** report resolved Strands device and backend ([2706771](https://github.com/ziptie-soft/local-decider/commit/2706771db214530a3a91a73aa66243b7e34535f5))
* **gateway:** runtime model switching with a memory budget; refuse cross-origin, rebinding and non-JSON requests ([b67a905](https://github.com/ziptie-soft/local-decider/commit/b67a9057382c9f9b94da5a43222d0ecb9da10a2d))
* **gateway:** save OpenAI-compatible engine connections ([f93a5e6](https://github.com/ziptie-soft/local-decider/commit/f93a5e635a4145bef696ff4fb7d7c0eab75849ff))
* **gateway:** stats --scope with classifier agreement section ([3ea9c15](https://github.com/ziptie-soft/local-decider/commit/3ea9c156be48473d2a7d7a7ee8dc7a945498bc6c))
* **gateway:** strands auto device prefers MLX on Apple Silicon ([bd385f8](https://github.com/ziptie-soft/local-decider/commit/bd385f80601fea653717b581303e114043746834))
* **gateway:** strands offers only host-compatible devices ([19e6554](https://github.com/ziptie-soft/local-decider/commit/19e6554c729a670d8261a2a1ba9c136802b34b53))
* **gateway:** switch engine selection mode and expose candidate codes ([d1f3486](https://github.com/ziptie-soft/local-decider/commit/d1f34868bcc384350b0615f8b807ba3dd051b3be))
* **gateway:** systemone gateway with policies, strands-decider engine, shadow log, stats, mcp and cli ([680b502](https://github.com/ziptie-soft/local-decider/commit/680b502eeaf29f08862ad1833b68c9e83127eb9d))
* **gateway:** tune LM Studio decisions for reasoning models ([e9412ac](https://github.com/ziptie-soft/local-decider/commit/e9412ac2b590a389dbe3afe7b71df7f09550d8a2))
* **gateway:** validate engine install plans ([b75ccac](https://github.com/ziptie-soft/local-decider/commit/b75ccac223dfdb010cf11f880bc2b4bf872a3ad0))
* **gateway:** verified outcome reports, engine log scrub, log retention and torn-line repair ([6e4699e](https://github.com/ziptie-soft/local-decider/commit/6e4699e4c1d9b1e2ec3489f05df189df497445b9))
* **hooks:** node-free subject module, call identity and silent command-risk ask in auto mode ([9b1a783](https://github.com/ziptie-soft/local-decider/commit/9b1a783ec7a1fd5c1644ee2a765bbb688cd763c7))
* outcome precedent, supervised outcomes, policy eval fixtures and calibration hints ([513dc5b](https://github.com/ziptie-soft/local-decider/commit/513dc5bab79c41d803487fbd3e2c6e34cb481da3))
* **paseo-plugin:** link missing tools to install docs ([0c128f8](https://github.com/ziptie-soft/local-decider/commit/0c128f8765e032bb232fd6b99a43209508ba9609))
* **paseo-plugin:** thin gateway client with turn-outcome, permission, routing hooks, status and settings ([9a04f19](https://github.com/ziptie-soft/local-decider/commit/9a04f19264f2b8f7c40bd874ff7f18a69424473a))
* routing policy variants, config.yaml settings with JSON schemas, per-harness presets, write-with-an-agent, usage and savings stats ([7c6e0f7](https://github.com/ziptie-soft/local-decider/commit/7c6e0f7d0e8e4759c9f37d48f0dcef7797d43935))
* routing preset thinking levels and paseo profiles, preset table, config.yaml edit and reload fixes ([43862c3](https://github.com/ziptie-soft/local-decider/commit/43862c3a0f681785cc8ba4f2964cfee910c5a137))


### Bug Fixes

* **core:** send bearer tokens only to real 127.x loopback hosts, also from the remote engine ([6e33f6e](https://github.com/ziptie-soft/local-decider/commit/6e33f6e13b8501b091a9f46fbacf5c9ffa8e4e16))
* **gateway:** answer 400 to unparsable request targets instead of crashing ([9c20740](https://github.com/ziptie-soft/local-decider/commit/9c20740abf69b5920ae8ba42aec6929703d3aee2))
* **gateway:** cap engine responses while streaming and reset restarts after a stable run ([d18bb67](https://github.com/ziptie-soft/local-decider/commit/d18bb67205832380b52473f58202835e460be934))
* **gateway:** choice labels N and Y match, and top logprobs default to 10 ([50b36d6](https://github.com/ziptie-soft/local-decider/commit/50b36d642493ed0cfc8e5d10a7e21482653e268e))
* **gateway:** harden openai-compatible prompts, redirects and error redaction ([533ca7c](https://github.com/ziptie-soft/local-decider/commit/533ca7c16361b1746d8016ddcbc742cffe17a60b))
* **gateway:** hide FastFlowLM paths on unsupported hosts ([8eed074](https://github.com/ziptie-soft/local-decider/commit/8eed0746d4dab0b80ebf451c425b2d1680df045b))
* **gateway:** idempotent gateway start, explicit restart, skip engine warmup on cpu ([8e29f50](https://github.com/ziptie-soft/local-decider/commit/8e29f507eb0630bceddb9cff3df8bb416110dc80))
* **gateway:** keep MPS availability alongside MLX and drop PyTorch engine label ([13cabf4](https://github.com/ziptie-soft/local-decider/commit/13cabf40c8c8d261b6cfed237060475007fdef0c))
* **gateway:** openai-compatible readiness relies on the logprob probe only ([a9499fa](https://github.com/ziptie-soft/local-decider/commit/a9499fad47f4bbf80a1b55836991049d750a8806))
* **gateway:** report starting while switching engines ([9bc24b0](https://github.com/ziptie-soft/local-decider/commit/9bc24b0332e8ff45a4000345ec8d6d9ff04065a5))
* **gateway:** stabilize launchd service startup ([1eab1c6](https://github.com/ziptie-soft/local-decider/commit/1eab1c68580ba3ae02c6aaace6eb25aad9ec5aec))
* resolve profile routing presets to models so savings stats count them ([6866060](https://github.com/ziptie-soft/local-decider/commit/686606038484e07fc0de89be3222ff427713e236))
* send the bearer token only over https or loopback; package readme, licence files, paseo version range ([1d443c3](https://github.com/ziptie-soft/local-decider/commit/1d443c3a989073fc4cba9c3f2a6bde519154c44b))


### Performance Improvements

* **gateway:** finish shadow decisions after callers give up, cap the queue, smaller state budgets ([b25e507](https://github.com/ziptie-soft/local-decider/commit/b25e507b55e799286b49ec5018f46f2be1d7fc5c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 1.1.0
