// Explicit product-level removal for tests that require a fresh recipe. Recovery
// tests deliberately omit this. Never reach into the feature's private registry.
exports.discardRecipe = async cdp => {
  await cdp.evaluate("window.__discardedRecipePanel = document.querySelector('.vz-panel')");
  await cdp.clickAt('.vz-workspace-discard');
  await cdp.poll("!!document.querySelector('.vz-discard')");
  await cdp.clickAt('.vz-discard-confirm');
  await cdp.poll("document.querySelector('.vz-panel')!==window.__discardedRecipePanel&&document.querySelectorAll('.vz-slider-row').length>0");
  await cdp.evaluate('delete window.__discardedRecipePanel');
};
