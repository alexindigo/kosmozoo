// Read actual native GUI Chromium through its test-only loopback CDP endpoint.
// No browser launch, fake DOM, or application state mutation here.
const fs = require('node:fs');
const endpoint = process.env.NATIVE_CDP;
const expectedOrigin = process.env.NATIVE_ORIGIN;
const expectedSource = process.env.NATIVE_SOURCE;
(async () => {
  const targets = await (await fetch(endpoint + '/json/list')).json();
  const target = targets.find(t => t.type === 'page' && t.url.startsWith(expectedOrigin));
  if (!target) throw new Error('Native browser has no target at the selected engine origin');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map(); let nextId = 0;
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id); pending.delete(message.id);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    const deadline = Date.now() + 20000; let actual;
    do {
      const result = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
        expression: `(async()=>{const s=(await import('/store/instance.js')).appStore;const card=document.querySelector('.card');return{origin:location.origin,source:s.state.host(),images:s.state.images.length,card:!!card,text:document.body.innerText,decoded:card?.querySelector('img')?.naturalWidth??0}})()` });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      actual = result.result.value;
      if (actual.origin === expectedOrigin && actual.source === expectedSource && actual.images > 0 && actual.card && actual.decoded > 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    if (!(actual.origin === expectedOrigin && actual.source === expectedSource && actual.images > 0 && actual.card && actual.decoded > 0)) throw new Error('Native consumer did not see selected engine/source/decoded fixture: ' + JSON.stringify(actual));
    fs.writeFileSync(process.env.NATIVE_RESULT, JSON.stringify(actual, null, 2) + '\n');
    console.log('NATIVE BROWSER CONSUMER PASS:', JSON.stringify({ origin: actual.origin, source: actual.source, images: actual.images, decoded: actual.decoded }));
  } finally { socket.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
