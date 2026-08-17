# vanilla-test

[![vanilla-test — native JavaScript testing for Node.js and browsers](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/assets/vanilla-test-header.png)](https://riaevangelist.github.io/vanilla-test/)

[Website](https://riaevangelist.github.io/vanilla-test/) · [Guide](https://riaevangelist.github.io/vanilla-test/guide/) · [Examples](https://riaevangelist.github.io/vanilla-test/example/) · [API](https://riaevangelist.github.io/vanilla-test/api/) · [Playground](https://riaevangelist.github.io/vanilla-test/playground/) · [CLI](https://riaevangelist.github.io/vanilla-test/cli/) · [Testing](https://riaevangelist.github.io/vanilla-test/testing/) · [Coverage](https://riaevangelist.github.io/vanilla-test/coverage/)

[![CI](https://github.com/RIAEvangelist/vanilla-test/actions/workflows/ci.yml/badge.svg)](https://github.com/RIAEvangelist/vanilla-test/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/vanilla-test.svg)](https://www.npmjs.com/package/vanilla-test)
[![npm downloads](https://img.shields.io/npm/dm/vanilla-test.svg)](https://www.npmjs.com/package/vanilla-test)
[![license](https://img.shields.io/github/license/RIAEvangelist/vanilla-test.svg)](https://github.com/RIAEvangelist/vanilla-test/blob/main/licence)
[![Node.js >=22.12](https://img.shields.io/badge/Node.js-%3E%3D22.12-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Google Chrome](https://img.shields.io/badge/Chrome-native%20V8%20coverage-4285F4?logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![Quality gates](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FRIAEvangelist%2Fvanilla-test%2Fmain%2Fbadges%2Fquality.json)](https://riaevangelist.github.io/vanilla-test/testing/)
[![Node core tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FRIAEvangelist%2Fvanilla-test%2Fmain%2Fbadges%2Fnode-tests.json)](https://riaevangelist.github.io/vanilla-test/testing/)
[![Chrome core tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FRIAEvangelist%2Fvanilla-test%2Fmain%2Fbadges%2Fchrome-tests.json)](https://riaevangelist.github.io/vanilla-test/testing/)
[![Tooling tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FRIAEvangelist%2Fvanilla-test%2Fmain%2Fbadges%2Ftooling-tests.json)](https://riaevangelist.github.io/vanilla-test/testing/)
[![Node core coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FRIAEvangelist%2Fvanilla-test%2Fmain%2Fbadges%2Fnode-coverage.json)](https://github.com/RIAEvangelist/vanilla-test/actions/workflows/ci.yml)
[![Chrome core coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FRIAEvangelist%2Fvanilla-test%2Fmain%2Fbadges%2Fchrome-coverage.json)](https://github.com/RIAEvangelist/vanilla-test/actions/workflows/ci.yml)

Minimal, extensible testing for JavaScript that runs directly in Node.js and the browser. The core speaks Web standards: the same untransformed ES module can execute in both runtimes, without a bundle, transpiler, or host-specific branch.

`vanilla-test` uses `EventTarget`, `CustomEvent`, and `queueMicrotask` for completion. The shared core does not import Node modules, inspect `process`, or decide a process exit code. Host tooling adapts around the test result.

## Install

```sh
npm install vanilla-test
```

Check the terminal for the install result.

Node.js 22.12 or newer is required.

## One test module, two runtimes

Save a small module under test as `src/add.js`:

```js
export function add(left, right) {
    return left + right;
}
```

Save the shared suite as `shared-test.js`:

```js
import VanillaTest from 'vanilla-test';
import { add } from './src/add.js';

async function check(test, description, assertion) {
    test.expects(description);

    try {
        await assertion();
        test.pass();
    } catch (error) {
        console.error(error);
        test.fail();
    } finally {
        test.done();
    }
}

export default async function run() {
    const test = new VanillaTest();

    await check(test, 'addition preserves the total', () => {
        test.compare(add(1, 2), 3);
    });

    await check(test, 'an async value resolves', async () => {
        const value = await Promise.resolve(42);
        test.is.number(value);
        test.compare(value, 42);
    });

    return test.report();
}
```

Check the console for the detailed test report.

That file contains no Node-only or browser-only code. Run cases sequentially: one `VanillaTest` instance has one active-test slot, so `Promise.all()` over test cases would make their lifecycles collide.

### Node adapter

```js
import run from './shared-test.js';

const result = await run();
process.exitCode = result.ok ? 0 : 1;
```

Run it with `node ./node-test.js`. Check the terminal for the report. The adapter, not the shared core, maps the result to a process exit status.

The returned result is frozen and has this shape:

```js
{
    passed: [
        '1) .expects addition preserves the total',
        '2) .expects an async value resolves'
    ],
    failed: [],
    total: 2,
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
        <p>Check the console or DevTools for the test report.</p>
        <script type="module">
            import run from './shared-test.js';
            const result = await run();
            document.body.dataset.ok = String(result.ok);
        </script>
    </body>
</html>
```

Serve the project over HTTP; browsers do not treat a `file:` URL like a web origin. This repository's example server is available with `npm start`. Check the terminal for the local URL.

## API

### Imports and exports

```js
import VanillaTest, {
    VanillaTest as NamedVanillaTest,
    VANILLA_TEST_COMPLETE_EVENT
} from 'vanilla-test';
```

| Export | Type/value | What it means |
| --- | --- | --- |
| `default` | `VanillaTest` class | The usual import. |
| `VanillaTest` | `VanillaTest` class | Named alias of the exact same class. |
| `VANILLA_TEST_COMPLETE_EVENT` | `'vanilla-test:complete'` | Event name used by `onComplete()` and native `EventTarget` listeners. |

`VanillaTest` extends the Web-standard `EventTarget`, so every instance also has native `addEventListener()`, `removeEventListener()`, and `dispatchEvent()` methods.

### Runner methods

| Member | Accepted values | Returns | What it does |
| --- | --- | --- | --- |
| `new VanillaTest()` | No required arguments | `VanillaTest` | Creates a fresh, isolated, single-use suite. Type checking starts in strict mode. |
| `test.expects(description)` | Any string | Numbered description string | Starts one uniquely described test. Only one test may be active at a time. |
| `test.pass(strict = false)` | Boolean | Active description string | Records the active test as passed. A later decision is ignored unless that later call passes `true`. |
| `test.fail(strict = false)` | Boolean | Active description string | Records the active test as failed, with the same duplicate-decision rule as `pass()`. |
| `test.done()` | No arguments | Active description string | Closes the active test. An undecided test is recorded as failed first. |
| `test.report()` | No arguments | Frozen `TestResult` | Logs and freezes the first report, queues one completion event, and seals the suite. Later calls return the identical object. |
| `test.onComplete(listener, options?)` | Function and native event-listener options | Idempotent unsubscribe function | Subscribes to completion. Register before the first report event is dispatched. |
| `test.delay(iterations = 1000)` | Nonnegative safe integer | The same `test` instance | Runs a synchronous busy loop and supports chaining. It is not a timer or asynchronous wait. |

All typed arguments are validated even when `test.strict` is `false`; for example, `test.expects(42)` and `test.delay(-1)` still throw `TypeError`.

### Assertions and strict mode

| Property | Default | What it means |
| --- | --- | --- |
| `test.is` | A strict `strong-type` instance | Full runtime type-checking surface. A valid check returns `true`; an invalid check throws in strict mode or returns `false` in non-strict mode. |
| `test.compare(actual, expected)` | Strict | Alias of `test.is.compare`. It uses JavaScript loose equality (`==`), not deep or strict equality. A mismatch throws `Error` in strict mode or returns `false` otherwise. |
| `test.throw(valueType, expectedType)` | Strict | Alias of the low-level `test.is.throw` type-error helper. It is not an `assert.throws(callback)` method. |
| `test.strict` | `true` | Gets or sets the `strong-type` failure mode. Only booleans are accepted. |

`test.strict` and the `strict` argument to `pass()` or `fail()` control different things:

```js
const test = new VanillaTest();

test.compare(1, '1');       // true: compare uses ==

test.strict = false;
test.is.string(42);         // false instead of TypeError
test.compare(1, 2);         // false instead of Error

test.expects('first decision wins');
test.pass();
test.fail();                // ignored; the test remains passed
test.fail(true);            // ReferenceError: a decision was already recorded
test.done();
```

The exact `strong-type` checker names exposed through `test.is` are:

| Group | Methods | Meaning |
| --- | --- | --- |
| Core and composition | `defined`, `any`, `exists`, `union`, `typeCheck`, `instanceCheck`, `symbolStringCheck`, `compare`, `throw` | Compose checks, test custom types, or control failure behavior. `union(value, 'string\|number')` accepts any named checker in the union. |
| Common values | `array`, `boolean`, `bigInt`, `date`, `finite`, `generator`, `asyncGenerator`, `globalThis`, `infinity`, `map`, `weakMap`, `NaN`, `null`, `number`, `object`, `promise`, `regExp`, `set`, `weakSet`, `string`, `symbol`, `undefined` | Check common JavaScript values. Names are case-sensitive, including `bigInt` and `NaN`. |
| Functions | `function`, `asyncFunction`, `generatorFunction`, `asyncGeneratorFunction` | Distinguish callable forms. |
| Errors | `error`, `evalError`, `rangeError`, `referenceError`, `syntaxError`, `typeError`, `URIError` | Check built-in error instances. |
| Buffers and typed arrays | `arrayBuffer`, `dataView`, `sharedArrayBuffer`, `bigInt64Array`, `bigUint64Array`, `float32Array`, `float64Array`, `int8Array`, `int16Array`, `int32Array`, `uint8Array`, `uint8ClampedArray`, `uint16Array`, `uint32Array` | Check binary-data containers and typed arrays. |
| Internationalization | `intlDateTimeFormat`, `intlCollator`, `intlDisplayNames`, `intlListFormat`, `intlLocale`, `intlNumberFormat`, `intlPluralRules`, `intlRelativeTimeFormat` | Check supported `Intl` objects. |
| Garbage collection | `finalizationRegistry`, `weakRef` | Check `FinalizationRegistry` and `WeakRef` instances. |

See [`strong-type`](https://github.com/RIAEvangelist/strong-type) for the dependency's detailed checker semantics. This release uses strong-type v2, including its exact-identity `compare` behavior (`Object.is`). Some helpers intentionally follow JavaScript primitives—for example, `object` uses `typeof`.

### Result object

| Field | Type | What the value means |
| --- | --- | --- |
| `passed` | Frozen `string[]` | Numbered descriptions recorded as passed, in decision order. |
| `failed` | Frozen `string[]` | Numbered descriptions recorded as failed, in decision order. |
| `total` | Nonnegative integer | `passed.length + failed.length`. |
| `failureCount` | Nonnegative integer | Number of failed tests. |
| `ok` | Boolean | `true` exactly when `failureCount === 0`. An empty suite is therefore a passing zero-test result. |
| `report` | String | ANSI-rendered console report logged by the first `report()` call. |

The outer result, `passed`, and `failed` are frozen. Repeated `report()` calls return the same object identity and do not log or dispatch again.

### Completion events

```js
import VanillaTest, { VANILLA_TEST_COMPLETE_EVENT } from 'vanilla-test';

const test = new VanillaTest();

test.onComplete(({ detail }) => {
    console.log(detail.ok, detail.failureCount);
}, { once: true });

test.addEventListener(VANILLA_TEST_COMPLETE_EVENT, ({ detail }) => {
    console.log(detail.total);
}, { once: true });

const result = test.report();
console.log(result.ok); // runs before the queued completion listeners
```

The first `report()` queues one `CustomEvent` in a microtask. Its `detail` is the exact frozen result object returned by `report()`. There is no replay for a listener registered after dispatch. `onComplete()` returns an unsubscribe function that is safe to call more than once. Check the browser or terminal console for the event result and rendered report.

### Lifecycle rules and errors

The normal sequence is `expects()` → assertion → `pass()` or `fail()` → `done()`, repeated as needed, then one final `report()`.

| Situation | Outcome |
| --- | --- |
| `pass()`, `fail()`, or `done()` without an active test | `ReferenceError` |
| A second `expects()` before `done()` | `ReferenceError` |
| Reusing an exact, case-sensitive description in one suite | `ReferenceError` |
| Calling `done()` before a decision | The active test is failed automatically. |
| Calling `pass()` or `fail()` after a decision | First decision remains; call returns normally by default or throws `ReferenceError` when that call receives `true`. |
| Calling `report()` while a test is active | `ReferenceError`; call `done()` first. |
| Starting a test after the first report | `ReferenceError`; create a new instance. |
| Reporting an empty suite | Frozen passing result with `total: 0`. |

The core has no before/after hooks and never changes `process.exitCode`. Use ordinary functions for setup/cleanup, promises for asynchronous coordination, and `onComplete()` for final notification.

## Native V8 coverage CLI

`vanilla-test` measures the source that each runtime actually executes. Node writes its built-in V8 coverage data; Chrome is launched directly through the Chrome DevTools Protocol and returns precise V8 coverage. The project-owned reporter then writes HTML, LCOV, and JSON summary files.

The coverage path uses project-owned collectors and reporting code, without source instrumentation, a browser shim, a bundler, or a transpiler. Its native range counts are intentionally different from parser-derived coverage counts.

### Coverage metrics

The JSON configuration keeps the familiar threshold key names, while the report labels explain exactly what is being counted:

| Threshold key | Report label | Meaning |
| --- | --- | --- |
| `statements` | Executable ranges | Every executable range record emitted by V8, including function roots and nested block ranges. A positive execution count is covered. V8 may collapse equal-count ranges, so totals can vary with the execution path. |
| `branches` | Block ranges | Every nested block range after a V8 function-root range. A positive execution count is covered. These are count-change regions, not parser-enumerated alternatives. |
| `functions` | Function ranges | The first, root range of every V8 function record. A positive execution count is covered. |
| `lines` | Executable lines | Source lines intersecting effective V8 ranges. A line is covered only when every intersecting effective range ran. |

Included files that were not loaded are reported explicitly and fail any enabled nonzero per-file gate. Internally, source is partitioned at V8 range boundaries; the smallest enclosing range supplies each segment's execution count. These are transparent V8-range semantics, not inferred AST statement or branch semantics. JSON and LCOV use conventional transport fields, but their native range totals are not interchangeable with parser-derived totals. The JSON `pct` field is truncated to two decimals for compatibility; gates compare the exact `covered / total` ratio, and the HTML report expands precision when a threshold needs it.

### Coverage commands

Canonical syntax:

```text
vanilla-test coverage [all|node|chrome] [options]
```

| Command | What it does |
| --- | --- |
| `vanilla-test coverage` | Runs Node, then Chrome. The omitted target defaults to `all`. |
| `vanilla-test coverage all` | Explicit form of the same two-runtime run. Reports stay separate. |
| `vanilla-test coverage node` | Runs only the Node collector and rebuilds only `coverage/node/`. |
| `vanilla-test coverage chrome` | Runs only the Chrome collector and rebuilds only `coverage/chrome/`. |
| `vanilla-test all`, `vanilla-test node`, or `vanilla-test chrome` | Supported short aliases for the three explicit `coverage` forms above. The explicit form is recommended for clarity. |
| `vanilla-test --help` | Prints CLI help without loading a configuration file. |
| `vanilla-test --version` | Prints the installed package version without loading a configuration file. |

An `all` run normally completes both collectors even if Node returns a test or threshold failure. Interruption stops the sequence. Use `npx vanilla-test ...` when the binary is not installed globally.

Complete examples:

```sh
npx vanilla-test coverage
npx vanilla-test coverage node --config ./config/vanilla-test.json
npx vanilla-test coverage chrome --headed --timeout-ms 60000
npx vanilla-test coverage chrome --chrome-path "/opt/google/chrome/google-chrome"
```

The optional target must appear before the options. Options use space-separated values only: use `--config path`, not `--config=path`. An unknown option, repeated option, missing value, or invalid value exits with status `2`.

### CLI options

| Option | Value/default | What it changes |
| --- | --- | --- |
| `--config <path>` | Default: `vanilla-test.config.json` | Selects strict JSON configuration. The path is resolved from the shell's current working directory; that file's directory becomes the project root. |
| `--chrome-path <path>` | No default override | Uses one Chrome executable for this run. The CLI path is resolved from the current working directory and overrides `chrome.executablePath`. It is checked only when Chrome runs. |
| `--headed` | Flag; Chrome is headless by default | Forces `chrome.headless` to `false` so the coverage run is visible. There is no inverse `--headless` flag. |
| `--timeout-ms <ms>` | Config value or `30000` | Overrides the test timeout. Accepts decimal digits from `1` through `3600000`. |
| `--help` | Flag | Prints help and exits `0`; no configuration is loaded. |
| `--version` | Flag | Prints the installed version and exits `0`; no configuration is loaded. |

### npm run commands

These scripts are included in this repository:

| npm command | Underlying command | What it is for |
| --- | --- | --- |
| `npm test` | `npm run test:core && npm run test:tooling` | Runs every core and tooling test in sequence. This is the normal local verification command. |
| `npm run test:core` | `node ./test/node.js` | Runs all 42 unique shared cases across the Unit, Functional, Integration, and Regression sets directly in Node.js. |
| `npm run test:unit` | `node ./test/node.js unit` | Runs the 15 isolated export, type, delegate, strict-state, and delay cases. |
| `npm run test:functional` | `node ./test/node.js functional` | Runs the 10 public lifecycle and reporting-outcome cases. |
| `npm run test:integration` | `node ./test/node.js integration` | Runs the 8 report, event, listener, and instance-composition cases. |
| `npm run test:regression` | `node ./test/node.js regression` | Runs the 9 state-integrity and idempotence cases. |
| `npm run test:tooling` | `node --test ./test/tooling.js ./test/output.js ./test/server-security.js ./test/status-builder.js ./test/benchmark.js` | Runs CLI, reporting, output-transaction, local-server security, benchmark-harness, and site-status tests. |
| `npm run benchmark` | `node ./benchmark/run.js` | Runs the auditable one-million-case Node and real-Chrome pipelines with native coverage and report generation. Install the private pinned competitors first with `npm ci --prefix benchmark`. |
| `npm run benchmark:smoke` | `node ./benchmark/run.js --cases 101 ...` | Runs the same complete benchmark paths with 101 cases and one measured sample for harness verification. |
| `npm run coverage` | `node ./bin/vanilla-test.js coverage` | Runs both native coverage collectors. |
| `npm run coverage:node` | `node ./bin/vanilla-test.js coverage node` | Runs only Node coverage. |
| `npm run coverage:chrome` | `node ./bin/vanilla-test.js coverage chrome` | Runs only Chrome coverage. |
| `npm run site:status` | `node ./scripts/build-site-status.js --run-tooling` | Rebuilds the documentation site's status data and Shields badges from the current reports, while refreshing the tooling-test result. |
| `npm run screenshots` | `node ./scripts/screenshots.js` | Smoke-tests the playground in Chrome, then regenerates the browser-run and native-report images. Run coverage first so both report pages exist. |
| `npm start` | `node ./scripts/serve.js` | Serves the repository locally and prints its URL. |

Pass CLI options through an npm script after `--`:

```sh
npm run coverage -- --timeout-ms 60000
npm run coverage:chrome -- --headed
npm run coverage:chrome -- --chrome-path "/opt/google/chrome/google-chrome"
```

Check the terminal after every npm command. Test output and failures appear there; coverage metrics are written to the configured reports directory.

### Complete coverage setup

Use the shared `shared-test.js` suite from [One test module, two runtimes](#one-test-module-two-runtimes), then save this strict JSON as `vanilla-test.config.json`:

```json
{
    "entry": "./shared-test.js",
    "reportsDirectory": "./coverage",
    "thresholds": {
        "statements": 100,
        "branches": 100,
        "functions": 100,
        "lines": 100
    },
    "timeoutMs": 30000,
    "node": {
        "include": [
            "src/**/*.js"
        ]
    },
    "chrome": {
        "include": [
            "src/**/*.js"
        ],
        "imports": {},
        "headless": true,
        "executablePath": null
    }
}
```

Then run:

```sh
npx vanilla-test coverage
```

The entry may be synchronous or asynchronous. The CLI imports it, calls it with no arguments, awaits its return value, validates the result, then checks coverage.

| Entry contract | Requirement |
| --- | --- |
| Export | A default function or named `run` function. A callable default export wins when both exist. |
| Return value | A non-array object with `ok: boolean` and `failureCount: nonnegative safe integer`. Extra fields are allowed. |
| Consistency | `ok` must equal `failureCount === 0`. |
| Timeout | Node applies it to import plus execution. Chrome applies it separately to navigation and waiting for the result. |

### Configuration reference

The configuration is strict JSON: comments, trailing commas, and unknown keys are rejected. All configuration-relative paths use the selected configuration file's directory as the project root.

| Top-level key | Required | Default | Meaning and accepted values |
| --- | --- | --- | --- |
| `entry` | Yes | — | Nonempty path to the shared test entry. It must resolve to an existing file inside the project root. |
| `reportsDirectory` | No | `./coverage` | Output directory inside, but not equal to, the project root. Each selected runtime stages a complete report and then atomically replaces only its own marked report directory. |
| `thresholds` | No | All four values are `100` | Coverage minimums. If the object is present, all four keys below are required. |
| `timeoutMs` | No | `30000` | Safe integer from `1` through `3600000` milliseconds. |
| `node` | For `all` or `node` | — | Node collector settings. It may be omitted from a Chrome-only configuration. Only the selected runtime configuration is required and validated. |
| `chrome` | For `all` or `chrome` | — | Chrome collector settings. It may be omitted from a Node-only configuration. Only the selected runtime configuration is required and validated. |

| Threshold key | Required together | Accepted value | Enforcement |
| --- | --- | --- | --- |
| `statements` | Yes | Finite number from `0` through `100`; decimals are allowed | Node: every included file. Chrome: aggregate total and every included file. |
| `branches` | Yes | Finite number from `0` through `100`; decimals are allowed | Same runtime rule. |
| `functions` | Yes | Finite number from `0` through `100`; decimals are allowed | Same runtime rule. |
| `lines` | Yes | Finite number from `0` through `100`; decimals are allowed | Same runtime rule. |

| `node` key | Required | Meaning |
| --- | --- | --- |
| `include` | Yes | Nonempty array of positive project-relative source globs. The combined patterns must match at least one existing file. No other `node` keys are accepted. |

| `chrome` key | Required/default | Meaning |
| --- | --- | --- |
| `include` | Required | Nonempty array of positive project-relative source globs. The combined patterns must match at least one existing file. |
| `imports` | Default: `{}` | Import-map additions or overrides: each key is a module specifier and each value is an existing local file inside the project. Remote URLs and paths escaping the root are rejected. |
| `headless` | Default: `true` | Boolean. Use `false` to show Chrome, or use `--headed` for one run. |
| `executablePath` | Default: `null` | `null` means discover installed Google Chrome Stable. A string selects an executable; a relative config value resolves from the configuration directory. |

Include patterns support `*` within one path segment, `**` recursively, and `?` for one non-slash character:

| Pattern | Matches |
| --- | --- |
| `index.js` | One exact root-relative file. |
| `src/*.js` | JavaScript files directly inside `src/`. |
| `src/**/*.js` | JavaScript files recursively below `src/`. |
| `test/file?.js` | Names such as `test/file1.js`, with one character in place of `?`. |

Absolute patterns, `..` path escapes, and `!` negation are rejected. Character classes, brace expansion, and extglobs are not supported. Matching and validation skip `node_modules`, `coverage`, and `.git` directories.

The CLI generates local import-map entries for `vanilla-test`, `ansi-colors-es6`, and `strong-type` when they exist. Values in `chrome.imports` override generated entries and may add the local modules used by your suite. A leading `/` is project-root-relative.

### Choosing Chrome with `executablePath`

The default is useful—not a placeholder:

```json
{
    "chrome": {
        "include": ["src/**/*.js"],
        "imports": {},
        "headless": true,
        "executablePath": null
    }
}
```

With `null`, `vanilla-test` checks `CHROME_PATH` first, then the standard Google Chrome Stable locations for Windows, macOS, or Linux, followed by Chrome names available on `PATH`. Install Chrome Stable or choose it explicitly if discovery cannot find it.

For a fixed nonstandard installation, set a JSON path. Remember that JSON escapes Windows backslashes:

```json
{
    "chrome": {
        "include": ["src/**/*.js"],
        "imports": {},
        "headless": true,
        "executablePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    }
}
```

For machine-specific or CI paths, keep the committed value `null` and override it at runtime:

```powershell
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run coverage:chrome

npm run coverage:chrome -- --chrome-path 'D:\Browsers\Chrome\chrome.exe'
```

```sh
CHROME_PATH=/usr/bin/google-chrome-stable npm run coverage:chrome
npm run coverage:chrome -- --chrome-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Check the terminal for the suite result, Chrome-path errors, and the final exit status. Inspect the configured reports directory for coverage details.

Keep Chrome's sandbox enabled for normal local runs. If an isolated Linux CI runner cannot provide a usable Chrome sandbox, opt out explicitly for that job only:

```sh
VANILLA_TEST_CHROME_NO_SANDBOX=1 npm run coverage
```

Check the terminal and CI log for the suite result and final exit status.

The variable accepts only `0`, `1`, an empty value, or an unset value; empty and unset both preserve the sandbox. `1` adds Chrome's `--no-sandbox` launch flag and reduces browser isolation, so do not set it on a general-purpose workstation or an untrusted shared runner.

| Setting precedence | Highest to lowest |
| --- | --- |
| Chrome executable | `--chrome-path` → configured `chrome.executablePath` → `CHROME_PATH` → platform discovery |
| Timeout | `--timeout-ms` → configured `timeoutMs` → `30000` |
| Headless mode | `--headed` forces `false` → configured `chrome.headless` → `true` |
| Browser import | Configured `chrome.imports` entry → generated local default |
| Chrome sandbox | Enabled by default; `VANILLA_TEST_CHROME_NO_SANDBOX=1` disables it only for constrained CI |

### Exit statuses

| Status | Meaning |
| --- | --- |
| `0` | Selected suites and enabled coverage gates passed; also used by `--help` and `--version`. |
| `1` | A valid suite reported failures or an enabled coverage threshold was missed. |
| `2` | CLI/configuration error, missing runtime prerequisite or Chrome, import/execution rejection, timeout, malformed result, or collector/reporter failure. |
| `130` | The run was interrupted with `SIGINT` or `SIGTERM`. |

For `all`, combined severity is `130`, then `2`, then `1`, then `0`.

### Report files

The selected runtime is written to a temporary staging directory first. After a valid run completes—even when tests or thresholds fail—the complete staged output atomically replaces the previous report. Configuration, harness, timeout, collector, and interruption failures clean up staging and preserve the previous known-good report. An unselected sibling report remains. HTML reports are standalone and have no external assets or third-party branding.

| Key path | Contents |
| --- | --- |
| `coverage/node/index.html` | Project-owned Node native V8 report. |
| `coverage/node/lcov.info` | Node data in conventional LCOV transport format; metric semantics remain native V8 ranges. |
| `coverage/node/coverage-summary.json` | Node aggregate and per-file native metric totals. |
| `coverage/node/test-results.json` | Plain, ANSI-free Node suite summary: status, counts, and passed/failed descriptions. |
| `coverage/node/.vanilla-test-coverage.json` | Ownership marker that permits later vanilla-test runs to replace this exact Node report safely. |
| `coverage/chrome/index.html` | Project-owned Chrome native V8 report. |
| `coverage/chrome/lcov.info` | Chrome data in conventional LCOV transport format; metric semantics remain native V8 ranges. |
| `coverage/chrome/coverage-summary.json` | Chrome aggregate and per-file native metric totals. |
| `coverage/chrome/test-results.json` | Plain, ANSI-free Chrome suite summary: status, counts, and passed/failed descriptions. |
| `coverage/chrome/.vanilla-test-coverage.json` | Ownership marker that permits later vanilla-test runs to replace this exact Chrome report safely. An unmarked or differently owned directory is refused. |
| `coverage/chrome/vanilla-test-chrome.png` | Successful Chrome harness screenshot. |

## Reproducible one-million-case benchmarks

The [benchmark dashboard](https://riaevangelist.github.io/vanilla-test/benchmark/) keeps Node and real-Chrome results in separate lanes and compares vanilla-test only with comparable or richer runners: the exact runtime's built-in `node:test` and pinned Mocha. The workload is exactly 1,000,000 uniquely named real cases in 1,000 bounded suites of 1,000—not a raw loop and not a claimed monolithic suite.

Every cold-wall sample includes host startup, framework lifecycle, detailed report materialization into a silent sink, native V8 coverage, exact-count and checksum validation, test JSON, coverage JSON, LCOV and standalone HTML writes, and teardown. The dashboard publishes all samples, distribution statistics, package integrity, commit provenance, and the benchmark machine's CPU, cores, RAM, OS, Node, V8, Chrome, power plan, and affinity policy.

Reference run on commit `65a0dfa3b96a59469ee0ac81704bbeb73736fde9` (five measured samples, medians):

| Native lane | Runner | Cold wall | Cold throughput | Peak sampled memory |
|---|---:|---:|---:|---:|
| Node | Mocha 11.8.0 | 8.87 s | 112,772 cases/s | 2,687 MiB RSS |
| Node | vanilla-test 2.1.1 | 12.50 s | 79,975 cases/s | 377 MiB RSS |
| Node | node:test / Node 24.18.0 | 78.16 s | 12,794 cases/s | 6,425 MiB RSS |
| Chrome | Mocha 11.8.0 | 9.92 s | 100,791 cases/s | 1,301 MiB JS heap |
| Chrome | vanilla-test 2.1.1 | 10.89 s | 91,852 cases/s | 218 MiB JS heap |

Those numbers describe this exact hardware and workload: Alienware 18 Area-51 AA18250, Intel Core Ultra 9 275HX (24 logical cores), 63.46 GiB RAM, Windows 11 Home build 26200, Balanced power plan, Node 24.18.0 / V8 13.6, and Chrome 151.0.7922.138 / V8 15.1. Node and Chrome remain separate rankings; their memory counters are also host-specific.

```sh
npm ci --prefix benchmark
npm run benchmark

# isolate one native host
node benchmark/run.js --runtime node
node benchmark/run.js --runtime browser
```

The complete source stays in [`benchmark/`](benchmark/README.md), and the dashboard exposes each runner adapter in a focused source dialog instead of crowding the result tables. Raw published data is available at [`data/benchmarks.json`](data/benchmarks.json).

## Reports and screenshots

The same source is exercised untransformed in real Chrome and Node.js.

### Chrome test run

![vanilla-test running in Google Chrome](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-chrome-v2.png)

The captured page groups 42 unique cases into Unit, Functional, Integration, and Regression sets. Its visible Chrome-console panel renders the same `ansi-colors-es6` test output forwarded to the real DevTools console.

### Browser playground

![vanilla-test browser playground with ANSI test output](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-playground-v2.png)

The default sandboxed module shows its ANSI-colored expectations, pass markers, and summary in the on-page console while preserving the DevTools output.

### One-million-case native pipeline benchmark

![vanilla-test one-million-case Node and Chrome benchmark](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-benchmark-v2.png)

The benchmark view publishes separate Node and real-Chrome rankings alongside the machine, runtime, methodology, exact commit, lock integrity, and downloadable raw samples.

### Chrome native V8 coverage

![vanilla-test Chrome native V8 coverage](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-chrome-coverage-v2.png)

### Node native V8 coverage

![vanilla-test Node native V8 coverage](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-node-coverage-v2.png)

Both coverage images show the project-owned native V8 reporter. Earlier third-party report screenshots and branding are no longer used. Generate fresh local images with `npm run screenshots`; check the terminal for the saved locations. CI also uploads its coverage and screenshot artifacts for inspection.

## Development

```sh
npm ci
npm test
npm run coverage
npm start
```

Check the terminal for test output, coverage results, and the local server URL.

GitHub Actions tests the minimum Node 22.12 runtime and current Node 24 LTS, runs the independent Node and real-Chrome coverage gates on Node 24, verifies the packed npm artifact, and uploads the generated reports and screenshots.

See the [v2 migration guide](https://github.com/RIAEvangelist/vanilla-test/blob/main/MIGRATION.md) when upgrading from v1 and the [changelog](https://github.com/RIAEvangelist/vanilla-test/blob/main/CHANGELOG.md) for release details.

## License

[MIT](licence)
