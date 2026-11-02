// Band color and geometry at the actual rail consumer, before/after wheel browsing.
const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
const KZ = `(await import('/store/instance.js')).appStore`;
const audit = `(()=>{
  const rail=document.querySelector('#feedRail'),start=Number(document.querySelector('.fr-top').textContent)-1;
  const ticks=[...rail.querySelectorAll('.fr-tick')],r=rail.getBoundingClientRect();
  const rows=ticks.map((tick,i)=>{const row=tick.closest('.fr-row')??tick.parentElement,box=row.getBoundingClientRect(),tb=tick.getBoundingClientRect();return{index:start+i,color:getComputedStyle(row).backgroundColor,left:box.left,top:box.top,bottom:box.bottom,width:box.width,height:box.height,tickColor:getComputedStyle(tick).backgroundColor,tickWidth:tb.width,tickHeight:tb.height}});
  return {start,rows,rail:{left:r.left,right:r.right,width:r.width},stripLeft:document.querySelector('main').getBoundingClientRect().left,feedLeft:document.querySelector('#candidatesCol').getBoundingClientRect().left,tickLeft:ticks[0].getBoundingClientRect().left,labelLeft:rail.querySelector('.fr-top').getBoundingClientRect().left,step:parseFloat(getComputedStyle(rail).getPropertyValue('--fr-tick-step')),scroll:document.querySelector('#candidatesCol').scrollTop};
})()`;
(async()=>{
  const page=await CDP.launch(9343,{windowSize:'1440,1000'}),errors=await collectPageErrors(page);
  const capture=async name=>{
    fs.mkdirSync(workPath('artifacts'),{recursive:true});
    const shot=await page.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(workPath(`artifacts/${name}.png`),Buffer.from(shot.data,'base64'));
    const clip=await page.evaluate(`(()=>{const r=document.querySelector('#feedRail').getBoundingClientRect();return{x:0,y:r.top,width:60,height:r.height,scale:4}})()`);
    const crop=await page.send('Page.captureScreenshot',{format:'png',clip});
    fs.writeFileSync(workPath(`artifacts/${name}-rail.png`),Buffer.from(crop.data,'base64'));
  };
  const verify=({rows,rail,step,stripLeft,feedLeft,tickLeft,labelLeft})=>{
    assert(Math.abs(rail.left-stripLeft)<=0.5,'band begins at the window strip edge');
    assert(Math.abs(rail.right-feedLeft)<=0.5,'band ends at the feed column boundary');
    assert.equal(feedLeft,28,'feed column does not shift');
    assert.equal(tickLeft,8,'tick x-position does not shift');
    assert.equal(labelLeft,8,'label x-position does not shift');
    const at=i=>rows.find(row=>row.index===i);
    assert.equal(at(19).color,at(40).color,'indices 19 and 40 use the normal background');
    assert.equal(at(20).color,at(39).color,'indices 20 through 39 use the lighter background');
    assert.notEqual(at(19).color,at(20).color,'absolute 20-tick bands alternate');
    assert.equal(at(40).top-at(20).top,20*step,'one band is exactly 20 tick steps tall');
    for(let i=0;i<rows.length;i++){
      const row=rows[i];
      assert.equal(row.width,rail.width,'band row covers full rail width');
      assert.equal(row.left,rail.left,'band starts at the rail edge');
      assert.equal(row.height,step,'row background includes the inter-tick gap');
      assert.equal(row.color,Math.floor(row.index/20)%2?at(20).color:at(19).color,'every row follows its absolute index');
      assert.equal(row.tickHeight,2,'tick height retained');
      if(i)assert.equal(row.top,rows[i-1].bottom,'no unpainted gaps between band rows');
    }
  };
  try{
    await page.goto(ENGINE+'/#fake#flux-basic.png');
    await page.poll(`(async()=>${KZ}.state.entriesWithKnownSize().length>350&&!!document.querySelector('.fr-tick.current'))()`,30000);
    await sleep(300);
    // Other feed specs may publish newer entries ahead of flux-basic. Own the
    // tape range these absolute boundary checks need instead of assuming that
    // revealing that fixture also follows the first twenty entries.
    const point=await page.evaluate(`(()=>{const r=document.querySelector('#feedRail').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await page.mouse('mouseWheel',point.x,point.y,{deltaY:-1000000});
    await page.poll(`Number(document.querySelector('.fr-top').textContent)===1`);
    await capture('rail-stripes-before');
    const initial=await page.evaluate(audit);verify(initial);
    assert.equal(initial.rows.find(row=>row.index===19).color,'rgb(17, 17, 17)','normal band keeps the existing rail background');
    assert(initial.rows.every(row=>row.tickWidth===10||row.tickWidth===18),'tick and wave widths retained');
    console.log('ok band boundary colors and full-width contiguous geometry',JSON.stringify({normal:initial.rows[19].color,lighter:initial.rows[20].color,bandHeight:initial.rows[40].top-initial.rows[20].top,railWidth:initial.rail.width}));
    await capture('rail-stripes-default');
    await page.mouse('mouseWheel',point.x,point.y,{deltaY:85});
    await page.poll(`Number(document.querySelector('.fr-top').textContent)===18`);
    const scrolled=await page.evaluate(audit);verify(scrolled);
    assert.equal(scrolled.scroll,initial.scroll,'band browsing does not move the feed');
    for(const row of scrolled.rows){const previous=initial.rows.find(r=>r.index===row.index);if(previous)assert.equal(row.tickColor,previous.tickColor,'tick decoration unchanged by band browsing')}
    console.log('ok absolute band colors stay anchored through a partial-band rail scroll',JSON.stringify({start:scrolled.start,normal:scrolled.rows.find(r=>r.index===19).color,lighter:scrolled.rows.find(r=>r.index===20).color}));
    await capture('rail-stripes-browsed');
    assert.deepEqual(errors,[]);console.log('PASS rail-stripes (2 consumer contracts, no page errors)');
  }finally{await page.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
