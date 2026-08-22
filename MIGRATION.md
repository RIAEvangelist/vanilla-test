# Migrating from vanilla-test v1 to v2

Version 2 keeps the original promise of one Web-standard JavaScript module running in Node and the browser. The migration removes the old copied-install workflow, makes completion host-neutral, and raises the supported runtime baseline.

## Runtime and installation

- Use Node.js 22.12 or newer.
- Install normally with `npm install vanilla-test`.
- Import from the package name in Node: `import VanillaTest from 'vanilla-test'`.
- In a browser, map that same package name and its two runtime dependencies with an import map. Do not copy nested `node_modules` trees into test and example directories.
- Continue using ES modules. v2 does not add a CommonJS build, bundler, transpiler, or TypeScript toolchain.

## Completion and results

In v1, `report()` mixed test reporting with Node process control. In v2, the shared core is host-neutral:

```js
const result = test.report();

if (!result.ok) {
    // Let the surrounding host adapter decide what failure means.
}
```

Check the console or terminal for the detailed report.

The result and its `passed` and `failed` arrays are frozen. It includes:

```js
{
    passed,
    failed,
    total,
    failureCount,
    ok,
    report
}
```

`report()` no longer calls `process.exit()`, sets an exit code, or changes behavior when passed `false`. Remove code that depends on `report(false)` returning a different value. The Node coverage CLI owns process exit behavior.

Hosts that need an asynchronous signal can subscribe before reporting:

```js
const unsubscribe = test.onComplete(({ detail }) => {
    console.log(detail.ok);
    unsubscribe();
});

test.report();
```

Check the console for the event result and test report.

Completion delivery is listener-aware. If a completion subscription has already been registered, the first `report()` queues `vanilla-test:complete` in a microtask. A runner that has never registered a completion listener queues no completion work; registering the first completion listener after `report()` schedules delivery from the frozen snapshot. Dispatch happens at most once, its `detail` is the exact snapshot, and listeners added after dispatch receive no replay. The event name is exported as `VANILLA_TEST_COMPLETE_EVENT`.

## Test lifecycle corrections

- Test descriptions are unique within a runner and a duplicate now throws.
- `done()` now records an undecided active test as failed.
- `report()` requires the active test to be finished.
- A reported runner is final; it returns the same snapshot on repeated reports and cannot start more tests.
- Each runner instance has isolated type-checking state and results.

These checks can expose suites that v1 accidentally accepted. Give each `expects()` call a unique description, call `pass()` or `fail()`, then call `done()` before the next test and before `report()`.

## Coverage migration

Replace copied fixtures and instrumented coverage commands with the bundled coverage CLI:

```sh
vanilla-test coverage all
```

Check the terminal for coverage progress, totals, and errors.

Add `vanilla-test.config.json` and identify the shared entry plus the files owned by each runtime. Node writes built-in V8 coverage, Chrome returns precise V8 coverage over the Chrome DevTools Protocol, and the project-owned reporter produces both sets of artifacts. Reports and 100% gates remain independent under `coverage/node` and `coverage/chrome`.

There is no c8, Istanbul/nyc, Playwright, Monocart, or source instrumentation in the current coverage path. The exact JavaScript that runs normally is the JavaScript that coverage measures.

See the README for the complete configuration contract and CLI options.

## Script replacement

For a consuming project, replace the old `emulate`/recursive copy scripts with direct package commands:

```json
{
    "scripts": {
        "test": "node ./test/node.js",
        "coverage": "vanilla-test coverage all",
        "coverage:node": "vanilla-test coverage node",
        "coverage:chrome": "vanilla-test coverage chrome"
    }
}
```

Check the terminal when these npm scripts run; each command prints its result or output location.

The repository also has maintainer-only `start` and `screenshots` scripts. They are not published package commands; consumers should use their own static server or screenshot tooling when needed.
