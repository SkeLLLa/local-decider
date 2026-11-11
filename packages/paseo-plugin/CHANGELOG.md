# Changelog

## [1.1.0](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v1.0.0...paseo-plugin-v1.1.0) (2026-11-11)


### Features

* **gateway:** call and scope request fields with per-scope policy modes ([0257f6c](https://github.com/ziptie-soft/local-decider/commit/0257f6cdd00d1bf4a738d2a3c90203801d0a0f25))
* **gateway:** verified outcome reports, engine log scrub, log retention and torn-line repair ([6e4699e](https://github.com/ziptie-soft/local-decider/commit/6e4699e4c1d9b1e2ec3489f05df189df497445b9))
* outcome precedent, supervised outcomes, policy eval fixtures and calibration hints ([513dc5b](https://github.com/ziptie-soft/local-decider/commit/513dc5bab79c41d803487fbd3e2c6e34cb481da3))
* **paseo-plugin:** add task context to permission checks ([ea163ba](https://github.com/ziptie-soft/local-decider/commit/ea163ba32db2cc94631b553e828b4ba0713c41a0))
* **paseo-plugin:** choose automatic engine from the engine picker ([d34f455](https://github.com/ziptie-soft/local-decider/commit/d34f455ec2ac9f96d5170475f9ecc2768d8d9e8c))
* **paseo-plugin:** engine and model selectors with downloads, flm validation, tool paths, lazy lifecycle and service controls ([eb32711](https://github.com/ziptie-soft/local-decider/commit/eb32711cc6ec86d35509afd790b3f9f3bd2efe28))
* **paseo-plugin:** link missing tools to install docs ([0c128f8](https://github.com/ziptie-soft/local-decider/commit/0c128f8765e032bb232fd6b99a43209508ba9609))
* **paseo-plugin:** set up OpenAI-compatible engines in settings ([694234b](https://github.com/ziptie-soft/local-decider/commit/694234b507d27dc6e601fbe1b7b02304aad6ecb7))
* **paseo-plugin:** settings button and icons in the quick-status popover, inline settings on details, preload on start, gateway policy modes ([c90a4a9](https://github.com/ziptie-soft/local-decider/commit/c90a4a92ee0c39cd086dcf640059f97d1dc7e3f6))
* **paseo-plugin:** settings v2 with model switching, decision feedback, sidebar placement and quick status ([744848b](https://github.com/ziptie-soft/local-decider/commit/744848b9c4aeddc3173cf55c0788351562e0c055))
* **paseo-plugin:** show recommended engine and fallback state ([5d2df52](https://github.com/ziptie-soft/local-decider/commit/5d2df52380849dd6bff784da9aca53c4e3936053))
* **paseo-plugin:** summarize tools in history ([a60629d](https://github.com/ziptie-soft/local-decider/commit/a60629d7ff0215970c8c4a2a5bac009f6112c2f2))
* **paseo-plugin:** thin gateway client with turn-outcome, permission, routing hooks, status and settings ([9a04f19](https://github.com/ziptie-soft/local-decider/commit/9a04f19264f2b8f7c40bd874ff7f18a69424473a))
* **paseo-plugin:** threshold sliders, open helper, decision row and rpc updates ([d0b3623](https://github.com/ziptie-soft/local-decider/commit/d0b36237e2b32754c5535b4985a679235fc853f6))
* **paseo-plugin:** use gateway engine metadata ([dc8ca73](https://github.com/ziptie-soft/local-decider/commit/dc8ca73382443259bd37b6e4f57d259a6f38d4b5))
* routing policy variants, config.yaml settings with JSON schemas, per-harness presets, write-with-an-agent, usage and savings stats ([7c6e0f7](https://github.com/ziptie-soft/local-decider/commit/7c6e0f7d0e8e4759c9f37d48f0dcef7797d43935))
* routing preset thinking levels and paseo profiles, preset table, config.yaml edit and reload fixes ([43862c3](https://github.com/ziptie-soft/local-decider/commit/43862c3a0f681785cc8ba4f2964cfee910c5a137))


### Bug Fixes

* **paseo-plugin:** add launchd service fallbacks ([d9dc6c3](https://github.com/ziptie-soft/local-decider/commit/d9dc6c39a06c53bc076507d17fbe3c342133c6c6))
* **paseo-plugin:** lay out engine recommendation as a candidate list ([f8f21c4](https://github.com/ziptie-soft/local-decider/commit/f8f21c48ed0507835c6ef919494aeb24c7c00f82))
* **paseo-plugin:** never delay agent creation for a shadow routing decision ([a1a794c](https://github.com/ziptie-soft/local-decider/commit/a1a794c13794fc2ac92489d1d2c9a66d2ad7ce02))
* **paseo-plugin:** preserve caller mode during routing ([e9c48c1](https://github.com/ziptie-soft/local-decider/commit/e9c48c19bc7bc2730350177d51df48de697ef0e6))
* **paseo-plugin:** scope query cache by host ([a2ee0b1](https://github.com/ziptie-soft/local-decider/commit/a2ee0b19cabb829a6922b4e367b6de82426a3e79))
* **paseo-plugin:** threshold slider rounding, clamping and warning zones ([548ac2c](https://github.com/ziptie-soft/local-decider/commit/548ac2c233c918e436cadb2d4595eef5e46bf9ee))
* **paseo-plugin:** type connection form text callbacks ([4958fd5](https://github.com/ziptie-soft/local-decider/commit/4958fd580871ef4b5a91fcbce953bcc83ad0c4af))
* resolve profile routing presets to models so savings stats count them ([6866060](https://github.com/ziptie-soft/local-decider/commit/686606038484e07fc0de89be3222ff427713e236))
* send the bearer token only over https or loopback; package readme, licence files, paseo version range ([1d443c3](https://github.com/ziptie-soft/local-decider/commit/1d443c3a989073fc4cba9c3f2a6bde519154c44b))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @ziptie-soft/local-decider-core bumped to 1.1.0
