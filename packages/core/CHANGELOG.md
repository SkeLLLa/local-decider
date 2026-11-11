# Changelog

## [1.1.0](https://github.com/ziptie-soft/local-decider/compare/core-v1.0.0...core-v1.1.0) (2026-11-11)


### Features

* **cli:** list and select gateway engines ([7e832b6](https://github.com/ziptie-soft/local-decider/commit/7e832b67be1804402362f5e6054c5f592a5e24ad))
* **core:** redaction, deterministic truncation and input hashing ([d1942c8](https://github.com/ziptie-soft/local-decider/commit/d1942c816a51fa6fa2b2a85ca53ba1afd80d00b2))
* **core:** systemone types, policy schema, rule evaluation, gateway client and default policies ([2593f31](https://github.com/ziptie-soft/local-decider/commit/2593f3165471e917bc5a4da6af78774a118e5c1c))
* **gateway:** call and scope request fields with per-scope policy modes ([0257f6c](https://github.com/ziptie-soft/local-decider/commit/0257f6cdd00d1bf4a738d2a3c90203801d0a0f25))
* **gateway:** fastflowlm d3 engine, switchable engines, lazy lifecycle, model catalogue and downloads, tool paths, runtime policy modes, queue priorities ([91c59ce](https://github.com/ziptie-soft/local-decider/commit/91c59ce1bc04ba495f48c8aca1e54c539f2f83de))
* **gateway:** policy thresholds config, engine control and decider updates ([e0a4a35](https://github.com/ziptie-soft/local-decider/commit/e0a4a35d71b6aac4c8c3fced52bf1dcf7662b745))
* **gateway:** runtime model switching with a memory budget; refuse cross-origin, rebinding and non-JSON requests ([b67a905](https://github.com/ziptie-soft/local-decider/commit/b67a9057382c9f9b94da5a43222d0ecb9da10a2d))
* **gateway:** verified outcome reports, engine log scrub, log retention and torn-line repair ([6e4699e](https://github.com/ziptie-soft/local-decider/commit/6e4699e4c1d9b1e2ec3489f05df189df497445b9))
* **hooks:** claude code and codex plugin with deterministic guard and fail-open hook runner ([d1e9d2e](https://github.com/ziptie-soft/local-decider/commit/d1e9d2ec493589164fe0c5eddbba9ea86a3f5398))
* outcome precedent, supervised outcomes, policy eval fixtures and calibration hints ([513dc5b](https://github.com/ziptie-soft/local-decider/commit/513dc5bab79c41d803487fbd3e2c6e34cb481da3))
* **policies:** refine permission and outcome guidance ([6a86342](https://github.com/ziptie-soft/local-decider/commit/6a863422e3b88fe46b672c74d1a374194d210438))
* routing policy variants, config.yaml settings with JSON schemas, per-harness presets, write-with-an-agent, usage and savings stats ([7c6e0f7](https://github.com/ziptie-soft/local-decider/commit/7c6e0f7d0e8e4759c9f37d48f0dcef7797d43935))
* routing preset thinking levels and paseo profiles, preset table, config.yaml edit and reload fixes ([43862c3](https://github.com/ziptie-soft/local-decider/commit/43862c3a0f681785cc8ba4f2964cfee910c5a137))


### Bug Fixes

* **core:** send bearer tokens only to real 127.x loopback hosts, also from the remote engine ([6e33f6e](https://github.com/ziptie-soft/local-decider/commit/6e33f6e13b8501b091a9f46fbacf5c9ffa8e4e16))
* resolve profile routing presets to models so savings stats count them ([6866060](https://github.com/ziptie-soft/local-decider/commit/686606038484e07fc0de89be3222ff427713e236))
* send the bearer token only over https or loopback; package readme, licence files, paseo version range ([1d443c3](https://github.com/ziptie-soft/local-decider/commit/1d443c3a989073fc4cba9c3f2a6bde519154c44b))
