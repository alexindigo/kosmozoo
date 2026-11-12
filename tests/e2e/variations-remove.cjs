const assert = require('node:assert/strict');
const { addParameter } = require('./variation-add-helpers.cjs');
module.exports = async ({ cdp, check, parameterId }) => {
  const row = `[data-param-key="${parameterId}"]`, button = row + ' .vz-parameter-remove';
  const geometry = await cdp.evaluate(`(()=>{const h=document.querySelector('${row} .vz-parameter-heading').getBoundingClientRect(),b=document.querySelector('${button}').getBoundingClientRect(),s=document.querySelector('${button} svg').getBoundingClientRect();return {header:h.toJSON(),button:b.toJSON(),gaps:[s.left-b.left,b.right-s.right,s.top-b.top,b.bottom-s.bottom],checkboxes:document.querySelectorAll('${row} .vz-parameter-heading input').length}})()`);
  assert.equal(geometry.checkboxes, 0);
  assert(Math.max(...geometry.gaps)-Math.min(...geometry.gaps)<=1);
  assert(Math.abs(geometry.header.right-geometry.button.right)<=1);
  await cdp.evaluate(`document.querySelector('${button}').focus()`);
  await cdp.keyTrusted(' ', { code:'Space', vk:32 });
  assert(await cdp.evaluate(`!document.querySelector('${row}')`));
  await addParameter(cdp, parameterId);
  check('shared remove icon: top-right, symmetric gaps, no heading checkbox, native keyboard off/re-add', true, JSON.stringify(geometry));
};
