# Changelog

## [2.1.0](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v2.0.0...paseo-plugin-v2.1.0) (2026-11-14)


### Features

* **paseo-plugin:** add benchmark gateway calls and RPCs ([a92027d](https://github.com/ziptie-soft/local-decider/commit/a92027dacdf495317b8205020fb3cdc9743d1d5d))
* **paseo-plugin:** add the benchmark card to the engine section ([6d0200b](https://github.com/ziptie-soft/local-decider/commit/6d0200bc5465459cb2f84415cb5ed805f4167dc5))
* **paseo-plugin:** add the benchmark card view model ([caf8506](https://github.com/ziptie-soft/local-decider/commit/caf8506faea0aef1ccbf57931f0dfa049e12bbae))
* **paseo-plugin:** add the recommended card view model ([95d871f](https://github.com/ziptie-soft/local-decider/commit/95d871f2c7e43d3627e2409a87e6ad29892acb06))
* **paseo-plugin:** fold the engine controls into an Advanced disclosure ([9f4f95b](https://github.com/ziptie-soft/local-decider/commit/9f4f95bec53a41b59cee66759cde3a5c25467004))
* **paseo-plugin:** parse engine family, measurements and machine recommendation ([80af9d3](https://github.com/ziptie-soft/local-decider/commit/80af9d3dc6e1e45763dc1c8c557dae802297c688))
* **paseo-plugin:** parse the benchmark job view ([2b24089](https://github.com/ziptie-soft/local-decider/commit/2b2408910b4f6a1d2fdc805193525c716d3bc46c))
* **paseo-plugin:** show benchmark progress in the status views and drop the cross-family suggestion ([3243146](https://github.com/ziptie-soft/local-decider/commit/32431465c4e6c3046f1cb638f35f621d272f15f9))
* **paseo-plugin:** show the recommended card at the top of the engine section ([2153a4c](https://github.com/ziptie-soft/local-decider/commit/2153a4c7e2bc30f58661e542b41a4e1370df91f2))
* **paseo-plugin:** show what is running and download progress on the recommended card ([abf8ffc](https://github.com/ziptie-soft/local-decider/commit/abf8ffc9bf6e51909a5a41f78b463fb20efa148f))
* **precedent:** add cross-harness v2 keys ([95f8a1b](https://github.com/ziptie-soft/local-decider/commit/95f8a1b89e83622cf2b2396fc0eb517ea69aaf8b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 2.1.0

## [2.0.0](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v1.1.0...paseo-plugin-v2.0.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* **core:** require allow-rule thresholds at or above a 0.8 floor
* **gateway:** require a control token on control routes
* **paseo-plugin:** scope gateway tokens to loopback and the pinned origin

### Features

* **paseo-plugin:** recommend llama.cpp Vulkan GPU engine ([717e0da](https://github.com/ziptie-soft/local-decider/commit/717e0dae2029a9cc40e2e1ef69db380639eceabb))
* typed outcome labels and permission-row feedback ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))


### Bug Fixes

* **core:** key-aware deep redaction and rule hardening ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **core:** reject unusable engine answers ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **core:** require allow-rule thresholds at or above a 0.8 floor ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **core:** send the control token only to loopback and refuse redirects ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **gateway:** drop dead queue waiters, reserve high-priority slots and release slots past the deadline ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **gateway:** require a control token on control routes ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **paseo-plugin:** say 'this computer' instead of 'this Mac' in engine settings ([#16](https://github.com/ziptie-soft/local-decider/issues/16)) ([6cc712c](https://github.com/ziptie-soft/local-decider/commit/6cc712c0b7dced66c745a18b388dfc72c428636a))
* **paseo-plugin:** scope gateway tokens to loopback and the pinned origin ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))


### Performance Improvements

* **core:** memoise secret-key classification during redaction ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 2.0.0

## [1.1.0](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v1.0.3...paseo-plugin-v1.1.0) (2026-11-12)


### Features

* prioritize system installed engines ([#13](https://github.com/ziptie-soft/local-decider/issues/13)) ([2e707a6](https://github.com/ziptie-soft/local-decider/commit/2e707a6906c9f3d29054a80a65f1ff73ecb4074a))
* sqlite store ([#15](https://github.com/ziptie-soft/local-decider/issues/15)) ([fd1499e](https://github.com/ziptie-soft/local-decider/commit/fd1499e700e6f0bc807a3838c9fd2d599f349e5c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 1.1.0

## [1.0.3](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v1.0.2...paseo-plugin-v1.0.3) (2026-11-11)


### Bug Fixes

* **paseo-plugin:** declare core and zod as runtime dependencies ([#9](https://github.com/ziptie-soft/local-decider/issues/9)) ([1b060b7](https://github.com/ziptie-soft/local-decider/commit/1b060b745095a40aebcbbdf72bc7edf30b9fb5ae))

## [1.0.2](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v1.0.1...paseo-plugin-v1.0.2) (2026-11-11)


### Bug Fixes

* **gateway:** pin the FastFlowLM archive checksum ([#6](https://github.com/ziptie-soft/local-decider/issues/6)) ([7327a8c](https://github.com/ziptie-soft/local-decider/commit/7327a8c4038903f4bafebaeffa82f7cc6b84ef9d))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @ziptie-soft/local-decider-core bumped to 1.0.2

## [1.0.1](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v1.0.0...paseo-plugin-v1.0.1) (2026-11-11)


### Bug Fixes

* security ([7184c24](https://github.com/ziptie-soft/local-decider/commit/7184c2446874efba7b567573c0bb5368acb54a72))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @ziptie-soft/local-decider-core bumped to 1.0.1
