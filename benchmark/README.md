# vanilla-test benchmark

This private benchmark workspace measures complete native testing pipelines without changing the published `vanilla-test` package or its production dependencies.

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

Coverage is intentionally enabled because this is an end-to-end pipeline benchmark, not a pure runner microbenchmark. The data retains both runner time and cold wall time so those boundaries remain visible.

One full rehearsal is discarded. Five measured samples follow in deterministic randomized runner order. Entrants never run in parallel, no measured sample is removed, and median, quartiles, median absolute deviation, range, and a deterministic bootstrap interval are published with the raw samples. A sample is invalid if any case is missing, duplicated, failed, or has the wrong checksum or report set.

Each fresh Node worker receives the same 16 GiB V8 heap ceiling. The cap is intentionally generous enough for richer runners that retain their full million-case event model; actual sampled memory remains visible in every result.

## Reproduce

```sh
npm ci
npm ci --prefix benchmark
npm run benchmark
```

Run one isolated lane or a small harness smoke:

```sh
node benchmark/run.js --runtime node
node benchmark/run.js --runtime browser
npm run benchmark:smoke
```

The default command writes `data/benchmarks.json` and a timestamped immutable copy under `benchmark/results/`. Machine data records the model, CPU, logical and available cores, RAM, OS, Node, V8, npm, Chrome protocol/runtime fields, power plan, commit, lock hash, and dependency integrity. It deliberately omits hostname, username, and absolute local paths.

Official capability references: [Node 24.18 test runner](https://nodejs.org/download/release/v24.18.0/docs/api/test.html), [Mocha browser support](https://mochajs.org/running/browsers/), and [Mocha native ESM](https://mochajs.org/explainers/nodejs-native-esm-support/).
