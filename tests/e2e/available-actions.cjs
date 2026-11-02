// Availability is an owner-rendered action set, never a disabled form. Real
// Chromium observes DOM absence, replacement status and stable layout slots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const { openImageFolder } = require('./image-picker-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18780';
const FAKE = process.env.E2E_FAKE ?? 'http://127.0.0.1:18781';
const KZ = '(await import("/store/instance.js")).appStore';

(async () => {
  const page = await CDP.launch(9362, { windowSize: '1800,1200' });
  const errors = await collectPageErrors(page), records = [], failures = [];
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const frame = () => page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const check = async (name, expression) => {
    await frame(); const result = await page.evaluate(expression);
    records.push({ name, result }); if (!result) failures.push(name);
    console.log(`${result ? 'PASS' : 'FAIL'} ${name}`);
  };
  const clean = selector => `![...document.querySelectorAll(${JSON.stringify(selector)})].some(e=>e.matches('[disabled],[aria-disabled]'))`;
  const capture = async name => {
    await frame(); const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(workPath('artifacts', `available-${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  const http = async (base, path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    assert(response.ok, `${path}: ${response.status}`); return response.json();
  };
  try {
    fs.mkdirSync(workPath('artifacts'), { recursive: true });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await http(FAKE, '/__test/activity', 'POST', { captureEnqueue: true });
    await page.goto(ENGINE);
    await page.poll(`(async()=>!!${KZ}.state.hosts.fake&&!!document.querySelector('.card'))()`);
    // Native component probes inject only public inputs/callbacks. No view
    // reaches into a consumer; unresolved promises model actual pending IO.
    await page.evaluate(`(async()=>{
      const {createSignal}=await import('/vendor/solid/solid.mjs');
      const {render,createComponent}=await import('/vendor/solid/web.mjs');
      const {FolderImages}=await import('/features/variations/FolderImages.js');
      const {FolderPicker}=await import('/components/FolderPicker.js');
      const {MediaControls}=await import('/components/MediaControls.js');
      const root=document.createElement('div');root.id='availability-probe';root.style.cssText='position:fixed;inset:100px 300px auto;background:var(--surface);z-index:1000;padding:20px';document.body.append(root);
      const mount=()=>{const el=document.createElement('div');root.append(el);return el};
      const [cap,setCap]=createSignal(null),[supported,setSupported]=createSignal(undefined),[duration,setDuration]=createSignal(0);
      window.__available={setCap,setSupported,setDuration};
      const disposers=[render(()=>createComponent(FolderImages,{capability:cap,registerEditor:()=>()=>{},rememberFocus(){},onChoose:()=>new Promise(resolve=>window.__available.choose=resolve),onAdd:()=>new Promise(resolve=>window.__available.add=resolve)}),mount()),
        render(()=>createComponent(FolderPicker,{get supported(){return supported()},options:['','nested'],value:'',onSelect(){}}),mount()),
        render(()=>createComponent(MediaControls,{get duration(){return duration()},current:0,paused:true,muted:false,loop:false,onSeek(){},onToggle(){},onMute(){},onLoop(){}}),mount())];
      window.__available.dispose=()=>{disposers.forEach(dispose=>dispose());root.remove()};
    })()`);
    await check('unknown folder capabilities expose neither chooser nor header picker', "!document.querySelector('#availability-probe .vz-folder-chooser')&&!document.querySelector('#availability-probe #outputFolder')");
    await page.evaluate('__available.setCap({available:false});__available.setSupported(false)');
    await check('unavailable chooser and header picker are absent; empty path has no Add', "!document.querySelector('#availability-probe .vz-folder-chooser')&&!document.querySelector('#availability-probe #outputFolder')&&!document.querySelector('#availability-probe .vz-folder-add')");
    await page.evaluate('__available.setCap({available:true});__available.setSupported(true)');
    await check('known available folder controls mount', "!!document.querySelector('#availability-probe .vz-folder-chooser button')&&!!document.querySelector('#availability-probe #outputFolder')");
    await page.clickAt('#availability-probe .vz-folder-path'); await page.send('Input.insertText', { text: '/images' });
    await check('typed path offers Add and no disabled controls', `!!document.querySelector('#availability-probe .vz-folder-add')&&${clean('#availability-probe *')}`);
    await page.clickAt('#availability-probe .vz-folder-chooser button');
    await check('choosing replaces both folder actions with Reading folder status in their row', "!document.querySelector('#availability-probe .vz-folder-chooser')&&!document.querySelector('#availability-probe .vz-folder-add')&&document.querySelector('#availability-probe .vz-folder-controls [role=status]')?.textContent==='Reading folder…'");
    await check('choosing has no disabled controls', clean('#availability-probe *'));
    await page.evaluate('__available.choose({path:null,cancelled:true})');
    await page.poll("!!document.querySelector('#availability-probe .vz-folder-add')");
    await page.clickAt('#availability-probe .vz-folder-add');
    await check('listing replaces both actions with Reading folder status', "!document.querySelector('#availability-probe .vz-folder-chooser')&&!document.querySelector('#availability-probe .vz-folder-add')&&document.querySelector('#availability-probe .vz-folder-controls [role=status]')?.textContent==='Reading folder…'");
    await check('listing has no disabled controls', clean('#availability-probe *'));
    await page.evaluate('__available.add({count:1})');
    await page.poll("!!document.querySelector('#availability-probe .vz-folder-add')");
    const mediaGeometry = () => page.evaluate("[...document.querySelectorAll('#availability-probe .media-controls, #availability-probe .media-controls button, #availability-probe .media-time')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})");
    const unknown = await mediaGeometry();
    await check('unknown duration omits seek but retains controls row', "!!document.querySelector('#availability-probe .media-controls')&&!document.querySelector('#availability-probe input.media-seek')");
    await page.evaluate('__available.setDuration(12)'); await frame();
    const known = await mediaGeometry();
    const mediaStable = known.length === unknown.length && known.every((box, i) => box.every((v, j) => Math.abs(v - unknown[i][j]) <= 1));
    records.push({ name: 'media geometry', unknown, known, result: mediaStable }); if (!mediaStable) failures.push('media geometry shifts with duration');
    await check('known duration offers seek and no disabled controls', `!!document.querySelector('#availability-probe input.media-seek')&&${clean('#availability-probe *')}`);
    await page.evaluate('__available.dispose()');

    await page.evaluate("fetch('/api/collections/fake/entries/flux-controlnet.png/bytes').then(r=>r.arrayBuffer()).then(()=>true)");
    await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
    await page.poll("!!document.querySelector('.vz-image-set')&&!!document.querySelector('.vz-row-inc-input')");
    if (!await page.evaluate("document.querySelector('.vz-image-set .checkbox').checked")) await page.clickAt('.vz-image-set .checkbox');
    await openImageFolder(page);
    await check('actual browser folder form has no unavailable actions or disabled controls', `!document.querySelector('.vz-folder-chooser')&&!document.querySelector('.vz-folder-add')&&${clean('.vz-panel *, #chrome .folder-picker *')}`);
    await capture('folder');
    await page.evaluate("(()=>{const e=document.querySelector('.vz-row-inc-input');e.value='0.01';e.dispatchEvent(new Event('input',{bubbles:true}))})()");
    await check('halve step at its floor is absent', "!document.querySelector('.vz-row-inc [title=\"Halve step\"]')");
    await page.evaluate("(()=>{const e=document.querySelector('.vz-row-inc-input');e.value='0.02';e.dispatchEvent(new Event('input',{bubbles:true}))})()");
    await check('halve step above its floor is available', "!!document.querySelector('.vz-row-inc [title=\"Halve step\"]')");
    await page.evaluate(`(()=>{const original=window.fetch;window.__availableRestore=()=>window.fetch=original;window.fetch=(url,options)=>String(url).includes('/features/variations/run')?new Promise(resolve=>window.__availableRun=()=>resolve(new Response(JSON.stringify({error:'Availability test rejection'}),{status:400}))):original(url,options)})()`);
    // Disable the empty image axis so the request reaches the transport.
    await page.clickAt('.vz-image-set .checkbox');
    await page.evaluate(`(async()=>{window.__availablePending=${KZ}.handles.invoke('variations.run');return true})()`);
    await page.poll('!!window.__availableRun');
    await check('queuing status replaces Run in the final sidebar slot', `!document.querySelector('button.vz-run')&&document.querySelector('.vz-run-slot [role=status]')?.textContent==='Queuing…'&&${clean('.vz-panel *')}`);
    await page.evaluate('__availableRun()'); await page.poll("!!document.querySelector('button.vz-run')");
    await page.evaluate('__availableRestore()');
    await page.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    if (await page.evaluate("!!document.querySelector('.vz-discard')")) await page.clickAt('.vz-discard-confirm');
    await page.poll("!document.querySelector('.vz-panel')");

    // Retire a real source identity; the next opening is a fresh editable draft.
    await http(ENGINE, '/api/collections', 'POST', { name: 'availability-owner', address: new URL(FAKE).host });
    await page.poll(`(async()=>!!${KZ}.state.hosts['availability-owner'])()`);
    await page.evaluate("fetch('/api/collections/availability-owner/entries/flux-basic.png/bytes').then(r=>r.arrayBuffer()).then(()=>true)");
    await invoke('variations.open', { id: 'availability-owner:flux-basic.png' }); await page.poll("!!document.querySelector('.vz-prefix')");
    await page.poll("document.querySelectorAll('.vz-slider-row').length>0");
    await page.clickAt('.vz-prefix'); await page.send('Input.insertText', { text: 'retained-prefix' });
    await page.poll("document.querySelector('.vz-prefix').value==='retained-prefix'");
    // A real accepted fake run closes and releases this draft.
    await invoke('variations.run'); await page.poll("!document.querySelector('.vz-panel')", 6000);
    const old = await page.evaluate(`(async()=>${KZ}.state.hosts['availability-owner'].sourceVersion.incarnation)()`);
    await http(ENGINE, '/api/collections/availability-owner', 'DELETE');
    await http(ENGINE, '/api/collections', 'POST', { name: 'availability-owner', address: new URL(FAKE).host });
    await page.poll(`(async()=>${KZ}.state.hosts['availability-owner']?.sourceVersion.incarnation!==${JSON.stringify(old)}&&!!${KZ}.state.hosts['availability-owner'])()`);
    await page.evaluate("fetch('/api/collections/availability-owner/entries/flux-basic.png/bytes').then(r=>r.arrayBuffer()).then(()=>true)");
    await invoke('variations.open', { id: 'availability-owner:flux-basic.png' }); await page.poll("document.querySelectorAll('.vz-slider-row').length>0");
    await check('source replacement opens fresh naming inputs and Run without recipe recovery controls', `!!document.querySelector('.vz-naming-group input')&&!!document.querySelector('button.vz-run')&&document.querySelector('.vz-prefix').value===''&&!document.querySelector('.vz-workspace-new,.vz-workspace-status')&&${clean('.vz-panel *')}`);
    await capture('fresh-session'); await invoke('variations.close'); await page.poll("!document.querySelector('.vz-panel')");

    // A failed delete must restore both actions after the status-only phase.
    await invoke('image.delete.request', { id: 'fake:flux-lora.png' }); await page.poll("!!document.querySelector('.confirm-ok')");
    await page.evaluate(`(()=>{const original=window.fetch;window.__deleteRestore=()=>window.fetch=original;window.fetch=(url,options)=>options?.method==='DELETE'?new Promise(resolve=>window.__deleteFinish=()=>resolve(new Response(JSON.stringify({error:'Delete rejected for test'}),{status:500}))):original(url,options)})()`);
    await page.clickAt('.confirm-ok'); await page.poll('!!window.__deleteFinish');
    await check('pending delete replaces both buttons with same-row status', `!document.querySelector('.confirm-actions button')&&document.querySelector('.confirm-actions [role=status]')?.textContent==='Deleting 1 image…'&&${clean('#confirmPanel *')}`);
    await page.evaluate('__deleteFinish()'); await page.poll("!!document.querySelector('.confirm-ok')&&!!document.querySelector('.confirm-cancel')");
    await check('failed delete restores available actions and reports the error', `${clean('#confirmPanel *')}&&document.querySelector('.confirm-error')?.textContent.includes('Could not delete')`);
    await page.evaluate('__deleteRestore()'); await invoke('image.delete.cancel');

    await invoke('workbench.openPair', { left: { source: 'fake', file: 'flux-basic.png' }, right: { source: 'fake', file: 'flux-lora.png' } });
    await invoke('workbench.mode', { mode: 'two-up' }); await page.poll("!!document.querySelector('.dz-lockbtn')");
    const geometry = () => page.evaluate("['#diffBar','#diffCtl','.viewer-keys','#diffClose'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]})");
    const paired = await geometry();
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.ui.setWorkspace('anchors');for(const a of [...s.state.anchors])s.actions.anchors.remove(a.name)})()`);
    await page.poll(`(async()=>!${KZ}.state.diffPair().b)()`); await frame();
    const single = await geometry();
    const viewerStable = paired.every((box, i) => box.every((v, j) => Math.abs(v - single[i][j]) <= 1));
    records.push({ name: 'viewer geometry', paired, single, result: viewerStable }); if (!viewerStable) failures.push('viewer toolbar shifts without pair');
    await check('single-item viewer omits comparison controls/modes without disabled leftovers', `!document.querySelector('#diffModes')&&!document.querySelector('#diffCtl button')&&${clean('#diffBar *')}`);
    await invoke('workbench.close');
    const exceptions = new Set(['components/HostPicker.tsx', 'components/IconButton.tsx', 'components/Checkbox.tsx']);
    const disabled = fs.readdirSync(workPath('client-solid'), { recursive: true }).filter(path => /\.(tsx|js)$/.test(path) && /\bdisabled\s*=/.test(fs.readFileSync(workPath('client-solid', path), 'utf8')));
    const unexpected = disabled.filter(path => !exceptions.has(path));
    records.push({ name: 'source availability contract', disabled, unexpected, result: !unexpected.length });
    failures.push(...unexpected.map(path => 'disabled user-facing control: ' + path));
    assert.equal(errors.length, 0, JSON.stringify(errors));
  } finally {
    fs.writeFileSync(workPath('artifacts', 'available-actions.json'), JSON.stringify({ records, failures, errors }, null, 2));
    await page.close();
  }
  console.log(`availability: ${records.length} observations, ${failures.length} failures`);
  assert.deepEqual(failures, []);
})().catch(error => { console.error(error); process.exitCode = 1; });
