// Import an incomplete archived recipe through the real capture protocol.
// The UI correctly refuses to Run it; recall still needs old/imported records
// whose raw values are incomplete, without weakening that admission gate.
async function rejectedNumericCapture(page, originalId) {
  return page.evaluate(`(async()=>{
    const store=(await import('/store/instance.js')).appStore;
    const history=store.actions.variations.services.history;
    const {decodeHistoryRecipe}=await import('/shared/features/variations/history-codec.mjs');
    const {snapshotDraft}=await import('/shared/features/variations/recipe-model.mjs');
    const {sourceOrigin,sameOrigin}=await import('/shared/source-origin.mjs');
    const record=await history.open(${JSON.stringify(originalId)});
    try {
      const snapshot=snapshotDraft(decodeHistoryRecipe(record));
      for(const rows of Object.values(snapshot))for(const entry of Object.values(rows))if(Object.hasOwn(entry.values,'enabled'))entry.values.enabled=false;
      Object.assign(snapshot.numeric['9.denoise'].values,{enabled:true,mode:'value',value:'1e'});
      snapshot.naming.root.values={...snapshot.naming.root.baseline};
      const ticket={runId:crypto.randomUUID(),snapshot,targets:record.targets,cohortMode:record.cohortMode,destination:record.destination};
      const check=target=>{if(!sameOrigin(target.origin,sourceOrigin(target.host,store.state.hosts[target.host])))throw Error('fixture source retired')};
      const captured=await history.capture(ticket,new Map(record.targets.map(target=>[target.id,target.context])),check);
      await history.finish(ticket.runId,null);
      return {id:captured.id,captureState:captured.captureState};
    } finally {await history.release(record)}
  })()`);
}
module.exports = { rejectedNumericCapture };
