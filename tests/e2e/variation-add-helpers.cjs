// Explicit test setup: add only the parameters used by the scenario.
async function addParameter(cdp, id) {
  const catalogue = `[data-catalogue-id="${id}"]`;
  await cdp.poll(`!!document.querySelector(${JSON.stringify(catalogue)})`);
  if (!await cdp.evaluate(`document.querySelector(${JSON.stringify(catalogue)}).classList.contains('vz-catalogue-hidden')`)) {
    await cdp.evaluate(`document.querySelector('.vz-field-filter').value`);
    await cdp.clickAt(`${catalogue} .vz-catalogue-add`);
  }
  await cdp.poll(`document.querySelector(${JSON.stringify(catalogue)}).classList.contains('vz-catalogue-hidden')`);
}
async function toggleParameter(cdp, id) {
  const selector = `[data-param-key="${id}"] .vz-parameter-remove, [data-image-id="${id}"] .vz-parameter-remove, [data-enum-id="${id}"] .vz-parameter-remove, [data-text-id="${id}"] .vz-parameter-remove, [data-candidate-id="${id}"] .vz-parameter-remove`;
  if (await cdp.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) await cdp.clickAt(selector);
  else await addParameter(cdp, id);
}
// Explicit opt-in for acquisition/empty-set scenarios. Exercise the ordinary
// removable reference through the same native button a user presses.
async function removeRecordedImage(cdp, id) {
  const row = `[data-image-id="${id}"]`, tile = `${row} [data-image-kind="reference"]`;
  await cdp.poll(`!!document.querySelector(${JSON.stringify(tile)})`);
  await cdp.clickAt(`${tile} .vz-image-remove button`);
  await cdp.poll(`!document.querySelector(${JSON.stringify(tile)})`);
}
// The Variations count is planned by the engine after a debounce. Its aria-busy
// is the product's settledness signal: read or compare it only once settled.
// `expected` is exact text, or { test } over `count`/`el`; `and` adds page state.
async function settledCount(cdp, expected, { and = 'true', timeout = 20000 } = {}) {
  const test = expected === undefined ? 'true' : typeof expected === 'object' ? expected.test : `count===${JSON.stringify(String(expected))}`;
  const probe = `(()=>{const el=document.querySelector('.vz-count');if(!el||el.getAttribute('aria-busy')!=='false')return null;const count=el.textContent;return (${test})&&(${and})?{count}:null})()`;
  try { return (await cdp.poll(probe, timeout)).count; }
  catch (error) {
    error.message += ' settledCount ' + JSON.stringify({ expected, and, observed: await cdp.evaluate(`(()=>{const el=document.querySelector('.vz-count');return el&&{count:el.textContent,busy:el.getAttribute('aria-busy')}})()`) });
    throw error;
  }
}
// Scenario command port: an intended Run waits for the same public admission
// settlement as the native button. Invalid raw values still reach Run unchanged.
const variationInvoker = (cdp, store) => async (id, args = {}) => {
  if (id === 'variations.run') await settledCount(cdp);
  return cdp.evaluate(`(async()=>${store}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
};
module.exports = { addParameter, toggleParameter, removeRecordedImage, settledCount, variationInvoker };
