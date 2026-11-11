// Native component contract, independent of navigation or arrival policies.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {CDP,collectPageErrors}=require('./cdp.cjs');
async function run(page){
  const bytes=Buffer.alloc(44+16000);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);
  bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(16000,40);
  await page.goto((process.env.E2E_ENGINE??'http://127.0.0.1:20480')+'/#fixture-dir');
  await page.poll(`!!document.querySelector('.card')`,20000);
  await page.evaluate(`(async()=>{const {render}=await import('/vendor/solid/web.mjs'),{createComponent}=await import('/vendor/solid/solid.mjs'),{MediaBox}=await import('/components/MediaBox.js');
    const root=document.createElement('div');root.id='exposure-native-probe';root.style.cssText='position:fixed;inset:100px 100px auto;width:800px;z-index:1000';document.body.append(root);
    window.nativeExposure=null;window.nativeExposureDispose=render(()=>createComponent(MediaBox,{kind:'audio',size:{w:1024,h:160},src:${JSON.stringify('data:audio/wav;base64,'+bytes.toString('base64'))},alt:'exposure.wav',
      registerExposure(input){window.nativeExposure=input;return()=>{if(window.nativeExposure===input)window.nativeExposure=null;};}}),root);
  })()`);
  try{
    await page.poll(`document.querySelector('#exposure-native-probe audio')?.readyState>=2&&window.nativeExposure?.ready()`,20000);
    const actual=await page.evaluate(`(()=>{const input=window.nativeExposure,r=input.element.getBoundingClientRect(),a=document.querySelector('#exposure-native-probe audio');return {painted:input.element.classList.contains('media-audio-face'),width:r.width,height:r.height,paused:a.paused,ready:input.ready()};})()`);
    fs.mkdirSync(process.env.E2E_EVIDENCE,{recursive:true});fs.writeFileSync(path.join(process.env.E2E_EVIDENCE,'native.json'),JSON.stringify(actual,null,2));
    assert.equal(actual.painted,true,'audio exposure observes the painted face, not the native audio element');assert(actual.width>0&&actual.height>0);assert(actual.paused);assert(actual.ready);
    console.log('PASS loaded paused audio exposes its actual painted face');
  }finally{await page.evaluate(`window.nativeExposureDispose();document.querySelector('#exposure-native-probe').remove();delete window.nativeExposure;delete window.nativeExposureDispose;`);}
}
module.exports={run};
if(require.main===module)(async()=>{const page=await CDP.launch(9354);const errors=await collectPageErrors(page);try{await run(page);assert.deepEqual(errors,[]);}finally{await page.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
