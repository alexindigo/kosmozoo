// Dispose the app through an actual reload, then reopen captured public targets.
// Recovery tests deliberately omit this. No private recipe-registry access.
exports.freshRecipe = async cdp => {
  const opening = await cdp.evaluate(`(async()=>{const s=(await import('/store/instance.js')).appStore;
    return {ids:s.state.variations.images.map(image=>image.id),images:document.querySelectorAll('.vz-image-set').length}})()`);
  const loader = (await cdp.send('Page.getFrameTree')).frameTree.frame.loaderId;
  await cdp.send('Page.reload');
  // A complete old document is not readiness for a new navigation. Wait for the
  // reload's document identity before reading the new app's boot state.
  const deadline = Date.now() + 10000;
  while ((await cdp.send('Page.getFrameTree')).frameTree.frame.loaderId === loader) {
    if (Date.now() > deadline) throw new Error('freshRecipe: reload did not commit');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await cdp.poll("document.readyState !== 'loading'");
  // loading starts false before boot begins. An accepted revision also proves
  // the fresh page's initial inventory settled, including valid empty results.
  await cdp.poll(`(async()=>{const s=(await import('/store/instance.js')).appStore;return s.state.inventory.revision!==null&&!s.state.inventory.loading&&${JSON.stringify(opening.ids)}.every(id=>!!s.state.hosts[id.slice(0,id.indexOf(':'))])})()`);
  await cdp.evaluate(`(async()=>{const s=(await import('/store/instance.js')).appStore;
    return s.handles.invoke('variations.open',${JSON.stringify(opening.ids.length > 1 ? { ids: opening.ids, bulk: true } : { id: opening.ids[0] })})})()`);
  await cdp.poll(`document.querySelectorAll('.vz-slider-row').length>0&&document.querySelectorAll('.vz-image-set').length>=${opening.images}`);
};
