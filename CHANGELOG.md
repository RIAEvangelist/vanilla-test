# Changelog

All notable changes to this project are documented here.

## [2.1.0] - 2026-08-14

### Added

- Normalized, ANSI-free `test-results.json` artifacts for Node and Chrome coverage runs.
- Generated quality status data and Shields endpoints sourced from the tested runtime artifacts.
- Engineer-focused Overview, Guide, API, Testing, Coverage, and CLI documentation pages.
- Target-specific configuration so Node-only projects may omit `chrome` and Chrome-only projects may omit `node`.
- Project-owned native V8 range analysis and standalone HTML, LCOV, and JSON coverage reports.
- Direct Chrome DevTools Protocol launching, collection, console forwarding, and screenshots.
- Complete README references for the public API, CLI, npm scripts, configuration, and Chrome executable selection.

### Changed

- Coverage reports are built in a staging directory and published only after a valid run completes.
- Existing reports require a vanilla-test ownership marker before replacement; failed runs preserve the previous known-good report.
- GitHub Pages now deploys a curated documentation artifact rather than archiving the repository workspace.
- The npm package uses an explicit runtime/documentation allowlist and excludes site, test, and report assets.
- GitHub Actions dependencies are pinned to immutable release commits.
- Chrome verification screenshots now include a visible console panel.
- Package author is now `Roshi _ _`.

### Security

- The loopback coverage and workspace servers require the exact bound `Host`, preventing DNS-rebinding reads of project files.
- Both local servers deny dotfiles, common credential files, and private-key formats, and enforce real-path containment across links.
- Local responses now include CSP, CORP, no-referrer, no-sniff, frame-denial, and no-store headers.
- Chrome coverage blocks browser requests outside the bound coverage origin.

### Removed

- The `c8`, `playwright-core`, and `monocart-coverage-reports` dependencies, including the former Istanbul-branded report output.

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
