# Changelog

## [2.1.0](https://github.com/ziptie-soft/local-decider/compare/local-decider-v2.0.0...local-decider-v2.1.0) (2026-11-14)


### Features

* **cli:** add report-only calibration command ([f13ed87](https://github.com/ziptie-soft/local-decider/commit/f13ed8754d31307f20b9eaa9443ffd2adb4aff7e))
* **gateway:** add bench CLI argument and output helpers ([c8d9e20](https://github.com/ziptie-soft/local-decider/commit/c8d9e20b79cf457fba5e8ab71f060dc9ee7f362f))
* **gateway:** add benchmark lease basics ([80fce43](https://github.com/ziptie-soft/local-decider/commit/80fce4315066ed5ae09898af8e3d9c5f8fad679f))
* **gateway:** add reusable benchmark calls ([7ff798e](https://github.com/ziptie-soft/local-decider/commit/7ff798e1df1612bf98d21d644e1683c4482e2f90))
* **gateway:** add verified model families ([7bb2e3d](https://github.com/ziptie-soft/local-decider/commit/7bb2e3dd9903db75163f0c9abddb0b7b010aadc5))
* **gateway:** expose benchmark status ([199b341](https://github.com/ziptie-soft/local-decider/commit/199b341370c4cc7813c73d16b81a012a1e6ce192))
* **gateway:** expose the benchmark host from engine control ([4945af9](https://github.com/ziptie-soft/local-decider/commit/4945af9bf9e6863adfa1c03d57caf3314ae08886))
* **gateway:** fingerprint benchmark runtimes ([53acdbd](https://github.com/ziptie-soft/local-decider/commit/53acdbd0ef4a2623de1c088eabaabfc44f71ebb3))
* **gateway:** hold decisions during benchmarks ([9fa81ff](https://github.com/ziptie-soft/local-decider/commit/9fa81ff8deb50b6d3bb523a2d2023004e6b67a82))
* **gateway:** keep benchmark engines out of fallback accounting ([6058601](https://github.com/ziptie-soft/local-decider/commit/605860139aabf92c18e56e1a891ccbd05632f08c))
* **gateway:** let a user selection preempt a benchmark ([224ccc7](https://github.com/ziptie-soft/local-decider/commit/224ccc77b54759aec89a21d6cba1bdfd6950652b))
* **gateway:** parse benchmark requests and resolve targets ([bb50a14](https://github.com/ziptie-soft/local-decider/commit/bb50a1478bc82d7f62b34075b928d8116e52ae29))
* **gateway:** persist benchmark records ([b1d16c1](https://github.com/ziptie-soft/local-decider/commit/b1d16c1095fb347663b4f41d25283d4747e6d60b))
* **gateway:** persist preferred family in auto mode ([6953bed](https://github.com/ziptie-soft/local-decider/commit/6953bed9b0704a58837dd8dd19bc399000557790))
* **gateway:** persist preferred model family ([0a329bb](https://github.com/ziptie-soft/local-decider/commit/0a329bbf4167f317a26298622b9823082505510e))
* **gateway:** rank measured model runtimes ([86a11dd](https://github.com/ziptie-soft/local-decider/commit/86a11ddcb7256c9f59ef9a5ad6e5a3951c4727b5))
* **gateway:** refuse engine changes during a benchmark ([38f4a6b](https://github.com/ziptie-soft/local-decider/commit/38f4a6b2a8bf403273d86a27b1c77df0d7ad5d85))
* **gateway:** run benchmark jobs ([fffc650](https://github.com/ziptie-soft/local-decider/commit/fffc65077444a0af891bac713020ddfed1251350))
* **gateway:** run benchmark jobs from engine control ([35c806d](https://github.com/ziptie-soft/local-decider/commit/35c806dfb76b153009d04d8fa1b8f5366a0b49e8))
* **gateway:** run benchmarks from the bench command ([d223712](https://github.com/ziptie-soft/local-decider/commit/d22371241d5d96b8d3b7a7ad48e1fc5a921be183))
* **gateway:** select runtimes within model families ([cae8e7e](https://github.com/ziptie-soft/local-decider/commit/cae8e7eca29ffb0f55d1aa0861ff3d10503a760f))
* **gateway:** serve benchmark routes ([c4766c0](https://github.com/ziptie-soft/local-decider/commit/c4766c0a40b8576e1891104b44475ad435215475))
* **precedent:** add cross-harness v2 keys ([95f8a1b](https://github.com/ziptie-soft/local-decider/commit/95f8a1b89e83622cf2b2396fc0eb517ea69aaf8b))
* **precedent:** add veto-only unverified outcomes ([a45585c](https://github.com/ziptie-soft/local-decider/commit/a45585c38d37786bc8d59171409d4d85ac4f808d))


### Bug Fixes

* **gateway:** cap the benchmark store read on one descriptor ([f59a2fb](https://github.com/ziptie-soft/local-decider/commit/f59a2fb7354a1b53d025a21720148114402684aa))
* **gateway:** persist, restore and store benchmark results reliably ([f51cb67](https://github.com/ziptie-soft/local-decider/commit/f51cb67609b5375f222276f0a95aa66ba3f0d140))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 2.1.0

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
