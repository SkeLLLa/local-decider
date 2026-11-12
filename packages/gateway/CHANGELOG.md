# Changelog

## [2.0.0](https://github.com/ziptie-soft/local-decider/compare/local-decider-v1.1.0...local-decider-v2.0.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* **core:** require allow-rule thresholds at or above a 0.8 floor
* **gateway:** require a control token on control routes
* **paseo-plugin:** scope gateway tokens to loopback and the pinned origin

### Features

* **gateway:** add llama.cpp Vulkan engine ([5f8a07e](https://github.com/ziptie-soft/local-decider/commit/5f8a07e199baa0df33b1ea1f412f6b58deacbdbd))
* typed outcome labels and permission-row feedback ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))


### Bug Fixes

* **core:** key-aware deep redaction and rule hardening ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **core:** reject unusable engine answers ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **core:** require allow-rule thresholds at or above a 0.8 floor ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **core:** send the control token only to loopback and refuse redirects ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **gateway:** drop dead queue waiters, reserve high-priority slots and release slots past the deadline ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **gateway:** require a control token on control routes ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **paseo-plugin:** scope gateway tokens to loopback and the pinned origin ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))


### Performance Improvements

* **core:** memoise secret-key classification during redaction ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 2.0.0

## [1.1.0](https://github.com/ziptie-soft/local-decider/compare/local-decider-v1.0.2...local-decider-v1.1.0) (2026-11-12)


### Features

* prioritize system installed engines ([#13](https://github.com/ziptie-soft/local-decider/issues/13)) ([2e707a6](https://github.com/ziptie-soft/local-decider/commit/2e707a6906c9f3d29054a80a65f1ff73ecb4074a))
* sqlite store ([#15](https://github.com/ziptie-soft/local-decider/issues/15)) ([fd1499e](https://github.com/ziptie-soft/local-decider/commit/fd1499e700e6f0bc807a3838c9fd2d599f349e5c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 1.1.0

## [1.0.2](https://github.com/ziptie-soft/local-decider/compare/local-decider-v1.0.1...local-decider-v1.0.2) (2026-11-11)


### Bug Fixes

* **gateway:** pin the FastFlowLM archive checksum ([#6](https://github.com/ziptie-soft/local-decider/issues/6)) ([7327a8c](https://github.com/ziptie-soft/local-decider/commit/7327a8c4038903f4bafebaeffa82f7cc6b84ef9d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 1.0.2

## [1.0.1](https://github.com/ziptie-soft/local-decider/compare/local-decider-v1.0.0...local-decider-v1.0.1) (2026-11-11)


### Bug Fixes

* security ([7184c24](https://github.com/ziptie-soft/local-decider/commit/7184c2446874efba7b567573c0bb5368acb54a72))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 1.0.1
