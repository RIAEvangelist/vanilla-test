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

Completion is dispatched as `vanilla-test:complete` in a microtask. The event name is exported as `VANILLA_TEST_COMPLETE_EVENT`.

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

Add `vanilla-test.config.json` and identify the shared entry plus the files owned by each runtime. Node uses c8 with native V8 coverage. Chrome uses real Google Chrome's native precise V8 coverage through Playwright and Monocart. Reports and 100% gates remain independent under `coverage/node` and `coverage/chrome`.

There is no Istanbul/nyc source instrumentation in v2. The exact JavaScript that runs normally is the JavaScript that coverage measures.

See the README for the complete configuration contract and CLI options.

## Script replacement

Replace the old `emulate`/recursive copy scripts with direct commands:

```json
{
    "scripts": {
        "test": "node ./test/node.js",
        "coverage": "vanilla-test coverage all",
        "coverage:node": "vanilla-test coverage node",
        "coverage:chrome": "vanilla-test coverage chrome",
        "start": "node ./scripts/serve.js",
        "screenshots": "node ./scripts/screenshots.js"
    }
}
```

The exact repository scripts may include internal entry paths while developing the package; consumers should use the published `vanilla-test` executable.
