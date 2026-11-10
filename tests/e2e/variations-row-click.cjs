const assert = require('node:assert/strict');
const withRecipe = require('./variations-polish-fixture.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');

module.exports = async ({ cdp, FAKE, KZ, check }) => withRecipe({ cdp, FAKE, KZ, name: 'row-click.png' }, async ({ type }) => {
  for (const [kind, row] of [['numeric','[data-param-key="9.steps"]'],['enum','[data-enum-id="9.scheduler"]'],['text','[data-text-id="2.text"]'],['images','[data-image-id="470.image"]']]) {
    const checked = () => cdp.evaluate(`!!document.querySelector('${row}.on')`);
    const box = `${row} > .vz-parameter-heading .vz-parameter-remove`;
    const id = {numeric:'9.steps',enum:'9.scheduler',text:'2.text',images:'470.image'}[kind];
    const catalogue = `[data-catalogue-id="${id}"]`;
    if (await checked()) await cdp.clickAt(box);
    for (const area of ['.vz-catalogue-name', '.vz-catalogue-current', '.vz-catalogue-context']) {
      await type('.vz-suffix', 'row-click');
      const naming = await cdp.evaluate("document.querySelector('.vz-suffix').value");
      await cdp.clickAt(`${catalogue} ${area}`);
      assert.equal(await checked(),false,`${kind}: catalogue text must not add implicitly`);
      await addParameter(cdp,id);
      assert(await checked(), `${kind}: explicit Add did not enable row`);
      // Enable may auto-append a token; a closed name must not insert another.
      const token = `{${await cdp.evaluate(`document.querySelector('${row}').dataset.paramKey||document.querySelector('${row}').dataset.enumId||document.querySelector('${row}').dataset.textId||document.querySelector('${row}').dataset.imageId`)}}`;
      const suffix = await cdp.evaluate("document.querySelector('.vz-suffix').value");
      assert.equal(suffix, naming, JSON.stringify({kind,area,naming,suffix,token}));
      await cdp.clickAt(`${row} .vz-parameter-current`); assert(await checked(), `${kind}: open line turned row off`);
      await cdp.clickAt(`${row} .vz-parameter-heading`); assert(await checked());
      await cdp.clickAt(box); assert.equal(await checked(), false, `${kind}: checkbox did not disable`);
    }
    await addParameter(cdp,id); assert(await checked(), `${kind}: Add did not enable`);
    const before = await cdp.evaluate("document.querySelector('.vz-suffix').value");
    await cdp.clickAt(`${row} .vz-parameter-name`);
    assert(await checked()); assert.notEqual(await cdp.evaluate("document.querySelector('.vz-suffix').value"), before, `${kind}: open name did not insert token`);
    await cdp.clickAt(box);
    const padding = await cdp.evaluate(`(()=>{const r=document.querySelector('${catalogue}').getBoundingClientRect();return{x:r.left+4,y:r.top+r.height/2}})()`);
    await cdp.mouse('mousePressed', padding.x, padding.y, { buttons: 1, clickCount: 1 });
    await cdp.mouse('mouseReleased', padding.x, padding.y, { buttons: 0, clickCount: 1 });
    assert.equal(await checked(),false, `${kind}: catalogue padding must not add implicitly`);
    await cdp.evaluate(`document.querySelector('${catalogue} button').focus()`);
    await cdp.keyTrusted(' ', { code: 'Space', vk: 32 }); assert(await checked(), `${kind}: keyboard checkbox did not enable`);
    // Enabled-first ordering moves the card; reacquire its native control.
    await cdp.evaluate(`document.querySelector('${box}').focus()`);
    await cdp.keyTrusted(' ', { code: 'Space', vk: 32 }); assert.equal(await checked(), false, `${kind}: keyboard checkbox did not disable`);
    check(`${kind}: explicit Add only; open line stays on; off returns to catalogue; native keyboard add/off and manual token insertion`, true);
  }
});
