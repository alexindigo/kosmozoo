// Real typing -> shared count/Run expansion -> engine -> actual fake enqueue graphs.
const assert=require('node:assert/strict');
module.exports=async({cdp,FAKE,KZ,check,closeAndDiscard})=>{
  const textField='.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-text-values';
  const textToggle='.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-imgrow-head .vz-cb';
  const control=async body=>{const response=await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);};
  const enqueues=async()=>await(await fetch(FAKE+'/__test/enqueues')).json();
  const type=async(selector,text)=>{
    await cdp.clickAt(selector);await cdp.evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});field.focus();field.select();})()`);
    await cdp.send('Input.insertText',{text});
    await cdp.poll(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(text)}`);
  };
  try{
    await cdp.evaluate(`(async()=>{const s=${KZ};await s.actions.hosts.select('fake');
      await fetch('/api/collections/fake/entries/flux-basic.png/bytes');await s.handles.invoke('variations.open',{id:'fake:flux-basic.png'});})()`);
    await cdp.poll(`!!document.querySelector(${JSON.stringify(textToggle)})`,10000);
    await cdp.clickAt('.vz-slider-row[data-param-key="BasicScheduler.denoise"] .vz-cb');
    await cdp.clickAt(textToggle);await cdp.poll(`!!document.querySelector(${JSON.stringify(textField)})`);
    const literal='  First paragraph.\n\nSecond paragraph.\n  Indented line.\n';
    await type(textField,literal);
    await cdp.poll("document.querySelector('.vz-count')?.textContent==='1'");
    await control({captureEnqueue:true});const before=(await enqueues()).length;
    await cdp.clickAt('.vz-run');await cdp.poll("document.querySelector('.vz-error')?.textContent==='submitted 1/1'",10000);
    const plain=(await enqueues()).slice(before);assert.equal(plain.length,1);assert.equal(plain[0].prompt['2'].inputs.text,literal);
    assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(textField)}).value`),literal);
    check('multiline text: real typed paragraphs count once and reach one actual enqueue unchanged, editor retained',true,JSON.stringify({jobs:plain.length,text:plain[0].prompt['2'].inputs.text}));

    const template='First {{animal}}.\n\nSecond {{style}}.\nAgain {{animal}}.\n';
    await type(textField,template);await cdp.poll("document.querySelectorAll('.vz-textrow .vz-tpl-input').length===2");
    await type('.vz-textrow .vz-tpl-row:nth-of-type(1) .vz-tpl-input','cat; dog');
    await type('.vz-textrow .vz-tpl-row:nth-of-type(2) .vz-tpl-input','oil; ; ink');
    await cdp.poll("document.querySelector('.vz-count')?.textContent==='6'");
    const start=(await enqueues()).length;await cdp.clickAt('.vz-run');
    await cdp.poll("document.querySelector('.vz-error')?.textContent==='submitted 6/6'",10000);
    const expected=['cat','dog'].flatMap(animal=>['oil','','ink'].map(style=>`First ${animal}.\n\nSecond ${style}.\nAgain ${animal}.\n`));
    const templates=(await enqueues()).slice(start).map(job=>job.prompt['2'].inputs.text);
    assert.deepEqual(templates,expected);
    assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(textField)}).value`),template);
    check('multiline templates: labels spanning paragraphs create only six whole-prompt Cartesian enqueue values',true,JSON.stringify({jobs:templates.length}));
  }finally{await control({captureEnqueue:false});if(await cdp.evaluate("!!document.querySelector('.vz-panel')"))await closeAndDiscard();}
};
