# Changelog

All notable changes to this project are documented here.

## [2.0.0] - 2026-08-12

### Added

- Web-standard completion through `EventTarget`, `CustomEvent`, `onComplete()`, and the exported `VANILLA_TEST_COMPLETE_EVENT` name.
- Frozen report snapshots with `passed`, `failed`, `total`, `failureCount`, `ok`, and the rendered report.
- `vanilla-test coverage [all|node|chrome]` with configuration, Chrome-path, headed, and timeout options.
- Native V8 coverage for Node through c8 and for real Google Chrome through Playwright and Monocart.
- Independent per-file shared-core coverage thresholds and Node/Chrome HTML, LCOV, and JSON reports.
- Node 22.12 and Node 24 GitHub Actions coverage, package smoke testing, report artifacts, screenshots, and coverage badges.

### Changed

- Raised the minimum supported Node.js version to 22.12.
- Standardized Node imports on the `vanilla-test` package specifier and browser imports on native import maps.
- Made `report()` host-neutral and idempotent; process exit status is now handled only by the Node adapter.
- Replaced recursive copied-install emulation with direct ES-module execution and a built-in local server.
- Made the same untransformed test module the source of truth for Node and browser execution.

### Fixed

- `done()` now fails an active test that has no decision.
- Duplicate descriptions are detected from their original description strings.
- Active-test, repeated-decision, and post-report lifecycle errors are reported consistently.
- Runtime detection and coverage flushing no longer depend on an early `process.exit()` call.

### Removed

- Stale Travis CI and AppVeyor configuration and documentation.
- The `emulate` script, recursive dependency copies, and their supporting development dependencies.
- Host-specific `process` behavior from the shared test core.
- Source-instrumented Istanbul/nyc coverage assumptions.
