// Visibility is observed at focusin, including the retained popup after Keep editing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { openImageAdd } = require('./image-picker-helpers.cjs');
const { workPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18260';
const FAKE = process.env.E2E_FAKE ?? 'http://127.0.0.1:18261';
const KZ = '(await import("/store/instance.js")).appStore';

(async () => {
  const page = await CDP.launch(9363, { windowSize: '1600,1000' });
  const errors = await collectPageErrors(page), problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  const post = async (url, body) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert(response.ok, `${url}: ${response.status}`);
  };
  const invoke = (id, args = {}) => page.evaluate(`(async () => ${KZ}.handles.invoke(${JSON.stringify(id)}, ${JSON.stringify(args)}))()`);
  const type = async (selector, value) => {
    await page.clickAt(selector);
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await page.send('Input.insertText', { text: value });
    await page.poll(`document.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(value)}`);
  };
  try {
    const info = await (await fetch(FAKE + '/api/object_info')).json();
    info.KSamplerSelect.input.required.sampler_name = [Array.from({ length: 12 }, (_, i) => i ? `sampler_${i}` : 'euler'), {}];
    await post(FAKE + '/__test/activity', { objectInfoByHost: { '127.0.0.2': info } });
    await post(ENGINE + '/api/collections', { name: 'ui-rules', address: `127.0.0.2:${new URL(FAKE).port}` });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.goto(ENGINE + '/#fake#flux-controlnet.png');
    await page.poll('!!document.querySelector(".card")');
    await page.evaluate("fetch('/api/collections/ui-rules/entries/flux-controlnet.png/bytes').then(r => r.arrayBuffer()).then(() => true)");
    await invoke('variations.open', { id: 'ui-rules:flux-controlnet.png' });
    await page.poll('!!document.querySelector(".vz-image-set")');
    await page.clickAt('[data-enum-id="8.sampler_name"] .checkbox');
    await page.poll('!!document.querySelector(".vz-enum-selected")');
    await page.clickAt('[data-text-id="2.text"] .checkbox');
    await type('[data-text-id="2.text"] .vz-text-values', 'A portrait of {{animal}}.');
    await type('.vz-tpl-input', 'cat; dog');
    if (!await page.evaluate('document.querySelector(".vz-image-set .checkbox").checked')) await page.clickAt('.vz-image-set .checkbox');
    await openImageAdd(page);
    await page.evaluate(`(() => {
      window.__pickerFocus = [];
      document.addEventListener('focusin', event => {
        const popup = event.target.closest?.('.vz-input-popover');
        if (!popup) return;
        const box = event.target.getBoundingClientRect();
        window.__pickerFocus.push({ target: event.target.className, opacity: getComputedStyle(popup).opacity,
          open: popup.matches(':popover-open'), width: box.width, height: box.height });
      }, true);
    })()`);
    await page.clickAt('.vz-input-trigger');
    await page.poll('!!document.querySelector(".vz-input-option") && getComputedStyle(document.querySelector(".vz-input-popover")).opacity === "1"');
    await page.poll('document.activeElement.matches(".vz-input-search")');
    await type('.vz-input-search', 'canny');
    await page.clickAt('.vz-input-option[data-input-name="canny.png"]');
    await page.poll('document.querySelector(".vz-input-summary").textContent === "1 selected"');
    await page.evaluate(`(() => { const search = document.querySelector('.vz-input-search'); window.__search = search; search.focus(); search.setSelectionRange(1, 3); search.dispatchEvent(new Event('select')); })()`);
    await page.evaluate(`(async () => { ${KZ}.handles.invoke('variations.close'); return true; })()`);
    await page.poll('!!document.querySelector(".vz-keep")');
    await page.clickAt('.vz-keep');
    await page.poll('!document.querySelector(".vz-keep") && document.activeElement.matches(".vz-input-search")');
    const retained = await page.evaluate(`(() => { const search = document.querySelector('.vz-input-search'); return { same: search === window.__search, query: search.value, start: search.selectionStart, end: search.selectionEnd }; })()`);
    check(retained.same && retained.query === 'canny' && retained.start === 1 && retained.end === 3, 'Keep editing lost native search identity/query/caret');
    // Another real open gets its own focus lifetime; no old callback may focus a retired popup.
    await page.keyTrusted('Escape', { vk: 27 });
    await page.poll('!document.querySelector(".vz-input-popover")');
    await page.clickAt('.vz-input-trigger');
    await page.poll('document.activeElement.matches(".vz-input-search")');
    const observations = await page.evaluate(`(() => {
      const foreground = getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim();
      const probe = document.createElement('span'); probe.style.color = 'var(--foreground)'; document.body.append(probe);
      const color = getComputedStyle(probe).color; probe.remove();
      const selectors = ['.vz-tpl-label', '.vz-enum-selected', '.vz-input-summary', '.vz-image-plus'];
      return { focus: window.__pickerFocus, foreground, color, text: selectors.map(selector => {
        const el = document.querySelector(selector); return { selector, text: el?.textContent, color: el && getComputedStyle(el).color };
      }), inlineState: [...document.querySelectorAll('.vz-input-popover, .vz-thumbnail img, .vz-current-point')].filter(el => ['opacity', 'pointer-events', 'visibility', 'display'].some(key => el.style.getPropertyValue(key))).map(el => el.outerHTML) };
    })()`);
    check(observations.focus.length >= 3, 'did not observe initial, resumed and reopened picker focus');
    check(observations.focus.every(event => event.opacity === '1' && event.open && event.width > 0 && event.height > 0), 'picker focused before visible placement');
    for (const row of observations.text) check(row.color === observations.color, `${row.selector} is muted: ${row.color}`);
    check(observations.inlineState.length === 0, 'inline state presentation remains in rendered picker/thumbnail/marker');
    for (const file of ['InputPicker.tsx', 'Thumbnail.tsx', 'SliderRow.tsx']) {
      const source = fs.readFileSync(workPath('client-solid/features/variations/' + file), 'utf8');
      check(!/\b(?:opacity|visibility|display)\s*:|["']pointer-events["']\s*:/.test(source), `${file} retains inline state styles`);
    }
    check(errors.length === 0, 'uncaught browser errors');
    // Keep the small-sheet frame reproducible for before/after pixel review.
    await type('.vz-input-search', '');
    await page.evaluate("document.querySelector('.vz-sliders').scrollTop = 0");
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.mkdirSync(workPath('artifacts'), { recursive: true });
    const image = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(workPath('artifacts/variations-ui-rules.png'), Buffer.from(image.data, 'base64'));
    // A populated sheet gives the real placement owner room above the trigger,
    // leaving the numeric mode row below it unobscured in the full-frame capture.
    await page.keyTrusted('Escape', { vk: 27 });
    await page.poll('!document.querySelector(".vz-input-popover")');
    await page.evaluate(`(async () => {
      const bytes = await (await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer();
      const files = new DataTransfer(), input = document.querySelector('.vz-imgfilespick');
      for (let i = 0; i < 10; i++) files.items.add(new File([bytes], 'study-' + i + '.png', { type: 'image/png' }));
      input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.poll('document.querySelectorAll(".vz-image-tile").length === 11 && !document.querySelector(".vz-image-check")');
    await page.evaluate("document.querySelector('.vz-sliders').scrollTop = 0");
    await page.clickAt('.vz-input-trigger');
    await page.poll('document.activeElement.matches(".vz-input-search") && getComputedStyle(document.querySelector(".vz-input-popover")).opacity === "1"');
    await page.poll('[...document.querySelectorAll(".vz-image-tile img, .vz-input-option img")].every(img => img.complete && img.naturalWidth > 0)');
    await page.evaluate("document.querySelector('.vz-sliders').scrollTop = 0");
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const exposed = await page.evaluate(`(() => {
      const button = document.querySelector('[data-param-key="9.denoise"] .mode-switch button'), box = button.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight && button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })()`);
    check(exposed, 'capture must expose the actual Range/Value row beside the open picker');
    const expanded = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(workPath('artifacts/variations-ui-rules-expanded.png'), Buffer.from(expanded.data, 'base64'));
    fs.writeFileSync(workPath('artifacts/variations-ui-rules.json'), JSON.stringify({ observations, retained, errors, problems }, null, 2));
    console.log(JSON.stringify({ observations, retained, errors, problems }));
    assert.deepEqual(problems, []);
    console.log('PASS visible picker focus on open/resume/reopen; class-owned state; foreground labels/selections/actions');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
