const assert = require('node:assert/strict');
module.exports = async ({ page, evaluate }) => {
  const result = await evaluate(`(async()=>{
    const {planHistoryOverlay}=await import('/shared/features/variations/history-codec.mjs');
    const catalogue=await fetch('/api/features/variations/probe/fake%3Aflux-controlnet.png').then(r=>r.json());
    const p=catalogue.parameters.find(p=>p.key==='text'&&p.valueKind==='string');
    if(!p)throw Error('missing text fixture');
    const baseline={enabled:false,text:p.currentValue??p.current,tpl:{}};
    const entry={metadata:p,baseline,values:{enabled:true,text:'{{__proto__}}',tpl:JSON.parse('{"__proto__":"literal label"}')},touched:[]};
    const naming={metadata:{},baseline:{prefix:'',suffix:''},values:{prefix:'',suffix:''},touched:[]};
    const recipe={numeric:{},images:{},enums:{},candidates:{},texts:{[p.id]:entry},naming:{root:naming}};
    const destination={...recipe,texts:{[p.id]:{...entry,values:{...baseline,tpl:{dormant:'unsent'}}}}};
    const plan=planHistoryOverlay({format:1,recipe,cohortMode:'single'},destination,[catalogue],'single');
    const tpl=plan.patch.find(p=>p.name==='tpl')?.value;
    return {warnings:plan.warnings,overlap:plan.overlap,own:!!tpl&&Object.hasOwn(tpl,'__proto__'),value:tpl?.['__proto__'],dormant:tpl?.dormant};
  })()`);
  assert.deepEqual(result,{warnings:[],overlap:false,own:true,value:'literal label',dormant:'unsent'});
  console.log('PASS browser template labels are literal own keys and retain unrelated buffers');
};
