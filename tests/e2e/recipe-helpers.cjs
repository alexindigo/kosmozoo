// A fresh draft is an ordinary close/discard and reopen of the captured targets.
exports.freshRecipe = async cdp => {
  const opening = await cdp.evaluate(`(async()=>{const s=(await import('/store/instance.js')).appStore;
    return {ids:s.state.variations.images.map(image=>image.id),images:document.querySelectorAll('.vz-image-set').length}})()`);
  await cdp.evaluate(`(async()=>{const s=(await import('/store/instance.js')).appStore;s.handles.invoke('variations.close');return true})()`);
  if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
  await cdp.poll("!document.querySelector('.vz-panel')");
  await cdp.evaluate(`(async()=>{const s=(await import('/store/instance.js')).appStore;
    return s.handles.invoke('variations.open',${JSON.stringify(opening.ids.length > 1 ? { ids: opening.ids, bulk: true } : { id: opening.ids[0] })})})()`);
  await cdp.poll(`document.querySelectorAll('.vz-catalogue-row').length>0`);
};
