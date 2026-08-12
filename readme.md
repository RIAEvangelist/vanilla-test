![vanilla-test — native JavaScript testing for Node.js and browsers](assets/vanilla-test-header.png)

[Visit the vanilla-test GitHub.io site](https://riaevangelist.github.io/vanilla-test/)

[![CI](https://github.com/RIAEvangelist/vanilla-test/actions/workflows/ci.yml/badge.svg)](https://github.com/RIAEvangelist/vanilla-test/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/vanilla-test.svg)](https://www.npmjs.com/package/vanilla-test)
[![npm downloads](https://img.shields.io/npm/dm/vanilla-test.svg)](https://www.npmjs.com/package/vanilla-test)
[![license](https://img.shields.io/github/license/RIAEvangelist/vanilla-test.svg)](licence)
[![Node.js >=22.12](https://img.shields.io/badge/Node.js-%3E%3D22.12-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Google Chrome](https://img.shields.io/badge/Chrome-native%20V8%20coverage-4285F4?logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![Node core coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FRIAEvangelist%2Fvanilla-test%2Fmain%2Fbadges%2Fnode-coverage.json)](https://github.com/RIAEvangelist/vanilla-test/actions/workflows/ci.yml)
[![Chrome core coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FRIAEvangelist%2Fvanilla-test%2Fmain%2Fbadges%2Fchrome-coverage.json)](https://github.com/RIAEvangelist/vanilla-test/actions/workflows/ci.yml)

Minimal, extensible testing for JavaScript that runs directly in Node.js and the browser. The core speaks Web standards: the same untransformed ES module can execute in both runtimes, without a bundle, transpiler, or host-specific branch.

`vanilla-test` uses `EventTarget`, `CustomEvent`, and `queueMicrotask` for completion. The shared core does not import Node modules, inspect `process`, or decide a process exit code. Host tooling adapts around the test result.

## Install

```sh
npm install vanilla-test
```

Node.js 22.12 or newer is required.

## One test module, two runtimes

```js
import VanillaTest from 'vanilla-test';

export default async function run() {
    const test = new VanillaTest();

    test.expects('addition preserves the total');

    try {
        test.compare(1 + 2, 3);
        test.pass();
    } catch (error) {
        console.error(error);
        test.fail();
    }

    test.done();

    return test.report();
}
```

That file contains no Node-only or browser-only code. Import and call `run()` from a thin Node or browser adapter, or give the module directly to the coverage CLI for both runtimes.

The returned result is frozen and has this shape:

```js
{
    passed: ['1) .expects addition preserves the total'],
    failed: [],
    total: 1,
    failureCount: 0,
    ok: true,
    report: 'rendered console report'
}
```

### Browser import map

Browsers resolve package names through an import map. No source rewrite is needed:

```html
<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>vanilla-test</title>
        <script type="importmap">
        {
            "imports": {
                "vanilla-test": "/node_modules/vanilla-test/index.js",
                "ansi-colors-es6": "/node_modules/ansi-colors-es6/index.js",
                "strong-type": "/node_modules/strong-type/index.js"
            }
        }
        </script>
    </head>
    <body>
        <script type="module">
            import run from './shared-test.js';
            const result = await run();
            document.body.dataset.ok = String(result.ok);
        </script>
    </body>
</html>
```

Serve the project over HTTP; browsers do not treat a `file:` URL like a web origin. This repository's example server is available with `npm start`.

## API

### `new VanillaTest()`

Creates an isolated test runner. Each instance owns its descriptions, active test, and results.

### `test.expects(description)`

Starts one test and returns its numbered description. Descriptions must be strings and unique within the instance. Finish the active test before starting another.

### `test.pass(strict = false)` / `test.fail(strict = false)`

Records the active test once. Repeating a decision is ignored by default; strict mode throws a `ReferenceError`.

### `test.done()`

Finishes the active test and returns its numbered description. An undecided test is failed automatically.

### `test.report()`

Prints the report, freezes and returns the result snapshot, then announces completion in a microtask. Calling it again returns the same snapshot. A reported instance cannot start another test.

The core never calls `process.exit()` or sets `process.exitCode`. The Node coverage adapter maps `result.ok` to its own exit status; browser callers can consume the same result directly.

### `test.onComplete(listener, options)`

Subscribes to the `vanilla-test:complete` event and returns an unsubscribe function. The listener receives the frozen result at `event.detail`.

```js
const unsubscribe = test.onComplete((event) => {
    console.log(event.detail.ok);
    unsubscribe();
});

test.report();
```

The event name is also exported as `VANILLA_TEST_COMPLETE_EVENT`.

### `test.is`, `test.compare`, `test.throw`, and `test.strict`

These expose the runtime type checks provided by [`strong-type`](https://github.com/RIAEvangelist/strong-type). `compare(actual, expected)` throws when the values do not compare successfully.

### `test.delay(iterations = 1000)`

Performs a short synchronous loop for a nonnegative safe-integer iteration count and returns the runner for chaining. Prefer promises and events for real asynchronous coordination.

## Native V8 coverage

`vanilla-test` keeps coverage outside the shared test module and measures each runtime independently.

The repository's 100% gates apply to the shipped Web-standard core (`index.js`). The Node-only coverage CLI is exercised by integration, package-smoke, invalid-input, timeout, and path-safety checks without mixing host tooling into the isomorphic core score.

- Node coverage uses [`c8`](https://github.com/bcoe/c8) over Node's native V8 coverage.
- Chrome coverage launches installed Google Chrome with Playwright, collects Chrome's native precise V8 coverage, and renders it with [`monocart-coverage-reports`](https://github.com/cenfun/monocart-coverage-reports).
- Included but never loaded source files count as 0%.
- Node and Chrome each enforce their own statement, branch, function, and line thresholds.
- There is no source instrumentation, `nyc`, browser shim, bundler, or transpiler in the coverage path.

Install Google Chrome Stable before running Chrome coverage. The CLI deliberately does not substitute another browser.

### Commands

From this repository:

```sh
npm test
npm run coverage
npm run coverage:node
npm run coverage:chrome
npm run screenshots
```

For an installed package or with `npx`:

```sh
vanilla-test coverage
vanilla-test coverage all
vanilla-test coverage node
vanilla-test coverage chrome
```

`coverage` and `coverage all` run both collectors and keep both reports. Ordinary failure in one runtime does not discard the other runtime's report.

Useful CLI options:

```text
--config <path>       configuration file (default: vanilla-test.config.json)
--chrome-path <path>  explicit Google Chrome executable
--headed              show Chrome while coverage runs
--timeout-ms <ms>     completion timeout
--help                command help
--version             package version
```

Exit status `0` means tests and thresholds passed, `1` means an assertion or coverage gate failed, `2` means the harness or configuration failed, and `130` means the run was interrupted.

### Configuration

Create `vanilla-test.config.json` in the project being measured:

```json
{
    "entry": "./test/CI.js",
    "reportsDirectory": "./coverage",
    "thresholds": {
        "statements": 100,
        "branches": 100,
        "functions": 100,
        "lines": 100
    },
    "timeoutMs": 30000,
    "node": {
        "include": ["index.js"]
    },
    "chrome": {
        "include": ["index.js"],
        "imports": {},
        "headless": true,
        "executablePath": null
    }
}
```

Paths are resolved from the configuration file's directory. Keep `entry`, included source, reports, and served browser imports inside the project root. The CLI rejects unknown keys, invalid thresholds and timeouts, empty include scopes, and escaping paths.

The CLI supplies local import-map defaults for `vanilla-test` and its runtime dependencies. Use `chrome.imports` only to override those package specifiers or to add imports used by your own shared test entry.

A CLI entry module exports a default or named `run()` function and returns its final result. The result must expose both `ok` and `failureCount`, and the values must agree, so the adapter can distinguish a finished passing suite from a failed or malformed run.

Reports are written separately:

```text
coverage/
  node/
    index.html
    lcov.info
    coverage-summary.json
  chrome/
    index.html
    lcov.info
    coverage-summary.json
```

## Reports and screenshots

The same source is exercised untransformed in real Chrome and Node.js.

### Chrome test run

![vanilla-test running in Google Chrome](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-chrome-v2.png)

### Chrome native V8 coverage

![vanilla-test Chrome native V8 coverage](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-chrome-coverage-v2.png)

### Node native V8 coverage

![vanilla-test Node native V8 coverage](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-node-coverage-v2.png)

Generate fresh local images with `npm run screenshots`. CI also uploads its coverage and screenshot artifacts for inspection.

## Development

```sh
npm ci
npm test
npm run coverage
npm start
```

GitHub Actions tests the minimum Node 22.12 runtime and current Node 24 LTS, runs the independent Node and real-Chrome coverage gates on Node 24, verifies the packed npm artifact, and uploads the generated reports and screenshots.

See the [v2 migration guide](https://github.com/RIAEvangelist/vanilla-test/blob/main/MIGRATION.md) when upgrading from v1 and the [changelog](https://github.com/RIAEvangelist/vanilla-test/blob/main/CHANGELOG.md) for release details.

## License

[MIT](licence)
