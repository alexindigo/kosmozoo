// Explicit product-level removal for tests that require a fresh recipe. Recovery
// tests deliberately omit this. Never reach into the feature's private registry.
exports.discardRecipe = async cdp => {
  const previous = await cdp.evaluate("document.querySelector('.vz-workspace').value");
  await cdp.clickAt('.vz-workspace-discard');
  await cdp.poll("!!document.querySelector('.vz-discard')");
  await cdp.clickAt('.vz-discard-confirm');
  await cdp.poll(`document.querySelector('.vz-workspace')?.value!==${JSON.stringify(previous)}&&document.querySelectorAll('.vz-slider-row').length>0`);
};
