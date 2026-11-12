const assert = require('node:assert/strict');
const withRecipe = require('./variations-polish-fixture.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');

module.exports = async ({ cdp, FAKE, KZ, check }) => withRecipe({ cdp, FAKE, KZ, name: 'range-handles.png' }, async ({ invoke, type }) => {
  const row = '[data-param-key="9.denoise"]';
  const field = part => `${row} input[aria-label$=" ${part}"]`;
  const failures = [], expected = [];
  for (const [lower, upper] of [[0.1, 0.4], [0.6, 0.9], [0.2, 0.8]]) {
    await type(field('From'), String(lower)); await type(field('To'), String(upper)); await type(`${row} .vz-row-inc-input`, '0.05');
    expected.length = 0;
    for (const [index, part, delta] of [[0, 'From', 0.1], [1, 'To', -0.05]]) {
      const selector = `${row} .noUi-handle[data-handle="${index}"]`;
      await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
      const geometry = await cdp.evaluate(`(()=>{const h=document.querySelector(${JSON.stringify(selector)}),r=h.getBoundingClientRect(),base=h.closest('.noUi-base').getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,width:base.width,hit:document.elementFromPoint(x,y).className,handle:document.elementFromPoint(x,y).closest('.noUi-handle')?.dataset.handle}})()`);
      console.log('handle hit', index, geometry);
      const before = await cdp.evaluate(`document.querySelector(${JSON.stringify(field(part))}).value`);
      await cdp.drag(geometry.x, geometry.y, geometry.x + geometry.width * delta, geometry.y);
      const after = await cdp.evaluate(`document.querySelector(${JSON.stringify(field(part))}).value`);
      try {
        assert.equal(geometry.handle, String(index), `handle ${index} hit area was covered by ${geometry.hit}`);
        assert.notEqual(after, before, `handle ${index} did not change ${part} raw field`);
      } catch (error) { failures.push(error.message); }
      expected.push(after);
    }
  }
  assert.deepEqual(failures, [], failures.join('; '));
  // A widget value is not enough: in-session row remount projects its raw text.
  await cdp.clickAt('.vz-close'); await cdp.poll("!!document.querySelector('.vz-discard')");
  await cdp.clickAt('.vz-keep');
  await cdp.clickAt(`${row} .vz-parameter-remove`); await addParameter(cdp,'9.denoise');
  assert.deepEqual(await cdp.evaluate(`[document.querySelector(${JSON.stringify(field('From'))}).value,document.querySelector(${JSON.stringify(field('To'))}).value]`), expected);
  const jobsBefore = (await (await fetch(FAKE + '/__test/enqueues')).json()).length;
  assert.equal((await invoke('variations.run')).adopted, true);
  const jobs = (await (await fetch(FAKE + '/__test/enqueues')).json()).slice(jobsBefore);
  assert(jobs.some(job => job.prompt['9'].inputs.denoise === Number(expected[0])));
  assert(jobs.some(job => job.prompt['9'].inputs.denoise === Number(expected[1])));
  check('both range handles change raw fields, in-session row values and submitted graph endpoints', true);
  await cdp.poll("!document.querySelector('.vz-panel')", 6000);
});
