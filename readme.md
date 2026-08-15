![vanilla-test — native JavaScript testing for Node.js and browsers](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/assets/vanilla-test-header.png)

# vanilla-test

Zero-build, Web-standard JavaScript testing for Node.js and Google Chrome, with independent native V8 coverage in both runtimes.

[Engineer documentation](https://riaevangelist.github.io/vanilla-test/) · [Get started](https://riaevangelist.github.io/vanilla-test/guide/) · [API](https://riaevangelist.github.io/vanilla-test/api/) · [Testing](https://riaevangelist.github.io/vanilla-test/testing/) · [Coverage](https://riaevangelist.github.io/vanilla-test/coverage/) · [CLI](https://riaevangelist.github.io/vanilla-test/cli/)

[![CI](https://github.com/RIAEvangelist/vanilla-test/actions/workflows/ci.yml/badge.svg)](https://github.com/RIAEvangelist/vanilla-test/actions/workflows/ci.yml)
[![Quality gates](https://img.shields.io/endpoint?url=https%3A%2F%2Friaevangelist.github.io%2Fvanilla-test%2Fbadges%2Fquality.json)](https://riaevangelist.github.io/vanilla-test/testing/)
[![Node shared-core tests](https://img.shields.io/endpoint?url=https%3A%2F%2Friaevangelist.github.io%2Fvanilla-test%2Fbadges%2Fnode-tests.json)](https://riaevangelist.github.io/vanilla-test/testing/)
[![Chrome shared-core tests](https://img.shields.io/endpoint?url=https%3A%2F%2Friaevangelist.github.io%2Fvanilla-test%2Fbadges%2Fchrome-tests.json)](https://riaevangelist.github.io/vanilla-test/testing/)
[![Node tooling tests](https://img.shields.io/endpoint?url=https%3A%2F%2Friaevangelist.github.io%2Fvanilla-test%2Fbadges%2Ftooling-tests.json)](https://riaevangelist.github.io/vanilla-test/testing/)
[![Node shared-core coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Friaevangelist.github.io%2Fvanilla-test%2Fbadges%2Fnode-coverage.json)](https://riaevangelist.github.io/vanilla-test/coverage/)
[![Chrome shared-core coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Friaevangelist.github.io%2Fvanilla-test%2Fbadges%2Fchrome-coverage.json)](https://riaevangelist.github.io/vanilla-test/coverage/)
[![npm version](https://img.shields.io/npm/v/vanilla-test.svg)](https://www.npmjs.com/package/vanilla-test)
[![npm downloads](https://img.shields.io/npm/dm/vanilla-test.svg)](https://www.npmjs.com/package/vanilla-test)
[![license](https://img.shields.io/github/license/RIAEvangelist/vanilla-test.svg)](licence)

The same untransformed ES module can run in Node and the browser. The core uses `EventTarget`, `CustomEvent`, and `queueMicrotask`; it does not import Node modules, inspect `process`, bundle source, or decide a host exit code.

## Requirements and install

- Node.js 22.12 or newer
- Native ES modules
- Google Chrome Stable when collecting Chrome coverage

```sh
npm install vanilla-test
```

## Quick start

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

Every `expects()` starts one active test. Decide it, call `done()`, then start the next test or call `report()`.

The returned result is deeply immutable:

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

In Node, a thin adapter maps `result.ok` to `process.exitCode`. In the browser, an import map resolves the same package specifier. The [getting-started guide](https://riaevangelist.github.io/vanilla-test/guide/) shows both adapters end to end.

## Test and coverage evidence

The badges above are generated from the latest published main-build artifacts. The linked pages show exact counts, runtime versions, covered/total values, commit, timestamp, scope, and raw reports.

| Gate | What it proves |
| --- | --- |
| Shared-core suite | The same host-neutral API and lifecycle checks pass in Node and real Chrome. |
| Node tooling suite | CLI parsing, exit codes, configuration, globbing, server containment, timeouts, and result validation behave correctly. |
| Packed-package smoke | A clean project can install the generated npm tarball, import `vanilla-test`, and run a result. |
| Node coverage | c8 measures the configured shared core through Node's native V8 coverage. |
| Chrome coverage | Playwright collects real Chrome precise V8 coverage and Monocart renders it. |

Coverage percentages apply to the configured shared-core scope (`index.js`) and are enforced independently for statements, branches, functions, and lines. Node and Chrome reporters count source constructs differently, so their raw totals are not cross-runtime size comparisons.

- [Testing strategy and live browser verification](https://riaevangelist.github.io/vanilla-test/testing/)
- [Coverage metrics and detailed reports](https://riaevangelist.github.io/vanilla-test/coverage/)
- [Machine-readable published status](https://riaevangelist.github.io/vanilla-test/data/status.json)

## Commands

```sh
npm test
npm run coverage
npm run coverage:node
npm run coverage:chrome
```

Installed-package CLI:

```sh
vanilla-test coverage [all|node|chrome]
```

Exit status `0` means all requested tests and gates passed, `1` means an assertion or threshold failed, `2` means the harness or configuration failed, and `130` means the run was interrupted. See the [CLI and configuration reference](https://riaevangelist.github.io/vanilla-test/cli/) for the JSON contract, flags, output layout, and path rules.

## Documentation

- [Get started](https://riaevangelist.github.io/vanilla-test/guide/) — shared suite, Node adapter, browser import map
- [API reference](https://riaevangelist.github.io/vanilla-test/api/) — lifecycle, methods, results, events, and errors
- [Testing strategy](https://riaevangelist.github.io/vanilla-test/testing/) — suite boundaries, runtime matrix, package smoke
- [Native V8 coverage](https://riaevangelist.github.io/vanilla-test/coverage/) — generated metrics, scope, thresholds, and reports
- [Coverage CLI](https://riaevangelist.github.io/vanilla-test/cli/) — commands, options, configuration, exit codes, CI
- [v1 to v2 migration](MIGRATION.md)
- [Changelog](CHANGELOG.md)

## Development

```sh
npm ci
npm test
npm run coverage
npm start
```

## License

[MIT](licence)
