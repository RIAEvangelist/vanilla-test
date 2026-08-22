# vanilla-test benchmark

This private benchmark workspace measures both core lifecycle scaling and complete native testing pipelines without changing the published `vanilla-test` package or its production dependencies.

## Core suite-size scaling

`scale.js` compares the exact `2.1.1:index.js` reconstructed from Git with the current candidate. Both implementations resolve the same installed runtime dependencies. The sweep puts 250, 500, 1,000, 2,000, 4,000, 8,000, and 16,000 uniquely named synchronous passing cases in one runner.

Each implementation/size pair runs in a fresh Node process. Imports are excluded from the timer; runner construction and every `expects()` → `pass()` → `done()` lifecycle are included. `report()` runs after timing only to validate the exact total, pass count, failure count, and status. One randomized serial warmup is discarded, five randomized serial samples are retained, and every value plus its source hash and machine provenance is published.

This is an algorithm-focused scaling measurement, not an end-to-end pipeline or cross-framework ranking. It exists specifically to show how lifecycle cost changes as one runner retains more history.

## What is compared

- Node lane: vanilla-test, the exact runtime's built-in `node:test`, and pinned Mocha.
- Real-browser lane: vanilla-test and pinned Mocha in Google Chrome Stable.

`node:test` and Mocha are deliberately richer runners, not stripped-down loops. Node documents suites, hooks, mocks, snapshots, reporters, reruns, and coverage. Mocha documents Node and browser execution, suites, hooks, filtering, retries, and reporters. Node and Chrome results are never combined into one ranking.

The competitor dependency is exact-versioned in this nested package. Security overrides pin patched `diff` and `serialize-javascript` releases; `npm audit --prefix benchmark` must report zero known vulnerabilities. Nothing under `benchmark/` is part of the npm package's `files` list.

## Million-case protocol

The published workload is exactly 1,000,000 real, uniquely named, synchronous passing cases organized as 1,000 bounded suites of 1,000. It is not described as one monolithic suite. Every runner executes the same body and must independently report the exact suite, execution, pass, failure, and checksum values.

Each fresh sample includes:

1. Node worker and test-child startup, or Node worker plus isolated Chrome startup.
2. Framework import, test definition, execution, completion, and detailed report materialization.
3. Native V8 coverage collection for `benchmark/workload.js`.
4. Test JSON plus coverage JSON, LCOV, and standalone HTML writes.
5. Validation and process/browser teardown.

Coverage is intentionally enabled because this is an end-to-end pipeline benchmark, not a pure runner microbenchmark. The same project-owned native V8 collector and deterministic HTML/LCOV/JSON reporter wrap every entrant, holding those phases constant while the runner changes. The data retains both runner time and cold wall time so those boundaries remain visible.

One full rehearsal is discarded. Five measured samples follow in deterministic randomized runner order. Entrants never run in parallel, no measured sample is removed, and median, quartiles, median absolute deviation, range, and a deterministic bootstrap interval are published with the raw samples. A sample is invalid if any case is missing, duplicated, failed, or has the wrong checksum or report set.

Each fresh Node worker receives the same 16 GiB V8 heap ceiling. The cap is intentionally generous enough for richer runners that retain their full million-case event model; actual sampled memory remains visible in every result.

## Reproduce

```sh
npm ci
npm ci --prefix benchmark
npm run benchmark:scale
npm run benchmark
npm run benchmark:charts
```

Run one isolated lane or a small harness smoke:

```sh
node benchmark/run.js --runtime node
node benchmark/run.js --runtime browser
npm run benchmark:smoke
```

The scaling command writes `data/scaling.json` plus a timestamped immutable result. The full pipeline writes `data/benchmarks.json` plus its own timestamped immutable result under `benchmark/results/`. `benchmark:charts` deterministically renders both datasets into dependency-free accessible SVGs, while `benchmark:charts:check` fails if a committed chart is stale.

Machine data records the model, CPU, logical and available cores, RAM, OS, Node, V8, npm, Chrome protocol/runtime fields where applicable, power plan, commit, lock hash, source hashes, and dependency integrity. It deliberately omits hostname, username, and absolute local paths.

Official capability references: [Node 24.18 test runner](https://nodejs.org/download/release/v24.18.0/docs/api/test.html), [Mocha browser support](https://mochajs.org/running/browsers/), and [Mocha native ESM](https://mochajs.org/explainers/nodejs-native-esm-support/).
