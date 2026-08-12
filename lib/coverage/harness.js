function json(value) {
    return JSON.stringify(value).replaceAll('<', '\\u003c');
}

export function createHarness(config) {
    const entry = json(config.entryUrl);

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>vanilla-test · Chrome coverage</title>
<script type="importmap">${json({ imports: config.chrome.imports })}</script>
<style>
:root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: #07111f; color: #e7f2ff; }
* { box-sizing: border-box; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 48px 24px; background: radial-gradient(circle at 20% 10%, #123b5c 0, transparent 38%), linear-gradient(145deg, #07111f, #0a1a2d); }
main { width: min(900px, 100%); border: 1px solid #29435f; border-radius: 22px; padding: 34px; background: rgba(7, 17, 31, .92); box-shadow: 0 30px 80px #0009; }
.eyebrow { color: #7cb9e8; letter-spacing: .14em; text-transform: uppercase; font-size: 13px; }
h1 { margin: 10px 0 26px; font: 700 clamp(30px, 6vw, 58px)/1.05 system-ui, sans-serif; }
[data-ok="true"] h1, [data-ok="true"] .value { color: #69f0ae; }
[data-ok="false"] h1, [data-ok="false"] .value { color: #ff7692; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.metric { padding: 18px; border: 1px solid #29435f; border-radius: 14px; background: #0c1d31; }
.label { color: #89a4be; font: 600 12px/1.4 system-ui, sans-serif; text-transform: uppercase; letter-spacing: .08em; }
.value { margin-top: 8px; font-size: 30px; font-weight: 800; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 24px 0 0; padding: 18px; border-radius: 14px; background: #040b14; color: #adc4d9; }
@media (max-width: 600px) { .grid { grid-template-columns: 1fr; } main { padding: 24px; } }
</style>
</head>
<body>
<main data-vanilla-test-status data-ok="pending">
  <div class="eyebrow">Native V8 · Google Chrome</div>
  <h1 data-title>Running vanilla-test…</h1>
  <div class="grid">
    <div class="metric"><div class="label">Status</div><div class="value" data-state>RUNNING</div></div>
    <div class="metric"><div class="label">Tests</div><div class="value" data-total>—</div></div>
    <div class="metric"><div class="label">Failures</div><div class="value" data-failures>—</div></div>
  </div>
  <pre data-details>Loading ${entry}</pre>
</main>
<script type="module">
const status = document.querySelector('[data-vanilla-test-status]');
const text = (selector, value) => { status.querySelector(selector).textContent = String(value); };
const valid = (value) => value && typeof value === 'object' && typeof value.ok === 'boolean'
    && Number.isSafeInteger(value.failureCount) && value.failureCount >= 0
    && value.ok === (value.failureCount === 0);
const render = (ok, title, result, details) => {
    status.dataset.ok = String(ok);
    text('[data-title]', title);
    text('[data-state]', ok ? 'PASSED' : 'FAILED');
    const total = result?.total ?? ((result?.passed?.length ?? 0) + (result?.failed?.length ?? 0));
    text('[data-total]', total);
    text('[data-failures]', result?.failureCount ?? '-');
    text('[data-details]', details);
};
globalThis.__vanillaTestRenderHarnessError = (message) => render(false, 'Chrome harness error', null, message);
try {
    const namespace = await import(${entry});
    const run = typeof namespace.default === 'function' ? namespace.default : namespace.run;
    if (typeof run !== 'function') throw new TypeError('Entry must export a default function or named run function.');
    const result = await run();
    if (!valid(result)) throw new TypeError('Entry must return consistent { ok, failureCount }.');
    globalThis.__VANILLA_TEST_COVERAGE_RESULT__ = { kind: 'result', value: result };
    const detail = Array.isArray(result.failed) && result.failed.length
        ? result.failed.join('\\n')
        : 'All shared web-standard tests completed successfully.';
    render(result.ok, result.ok ? 'All tests passed' : 'Test failures detected', result, detail);
} catch (error) {
    const message = error?.stack || String(error);
    globalThis.__VANILLA_TEST_COVERAGE_RESULT__ = { kind: 'harness-error', message };
    render(false, 'Chrome harness error', null, message);
    console.error(message);
}
</script>
</body>
</html>`;
}
