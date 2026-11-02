// Focused real-input rail contract; also provides the pre-commit review captures.
const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const KZ = `(await import('/store/instance.js')).appStore`;
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
const range = `({top:Number(document.querySelector('.fr-top').textContent),bottom:Number(document.querySelector('.fr-bottom').textContent),total:Number(document.querySelector('.fr-total').textContent),scroll:document.querySelector('#candidatesCol').scrollTop})`;
(async () => {
  const page = await CDP.launch(9341, { windowSize: '1440,1000' });
  const errors = await collectPageErrors(page);
  const capture = async name => {
    fs.mkdirSync(workPath('artifacts'), { recursive: true });
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(workPath(`artifacts/${name}.png`), Buffer.from(shot.data, 'base64'));
    const clip = await page.evaluate(`(()=>{const r=document.querySelector('#feedRail').getBoundingClientRect();return{x:0,y:r.top,width:100,height:r.height,scale:3}})()`);
    const crop = await page.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(workPath(`artifacts/${name}-rail.png`), Buffer.from(crop.data, 'base64'));
  };
  try {
    await page.goto(ENGINE + '/#fake#flux-basic.png');
    await page.poll(`(async()=>{const s=${KZ};return s.state.entriesWithKnownSize().length>350&&s.state.feedActivity()==='settled'&&document.querySelector('.fr-tick.current')})()`, 30000);
    await sleep(300);
    const before = await page.evaluate(range);
    await capture('rail-scroll-before');
    const point = await page.evaluate(`(()=>{const r=document.querySelector('#feedRail').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await page.mouse('mouseWheel', point.x, point.y, { deltaY: 1000 });
    await page.poll(`Number(document.querySelector('.fr-top').textContent)>${before.top}`, 3000);
    const browsed = await page.evaluate(range);
    assert.equal(browsed.scroll, before.scroll, 'rail wheel must not scroll the feed');
    assert.equal(browsed.bottom-browsed.top, before.bottom-before.top, 'both labels follow the tape');
    assert.equal(await page.evaluate(`!!document.querySelector('.fr-tick.current')`), false, 'off-window current stays off-window');
    await capture('rail-scroll-browsed');
    console.log('ok rail wheel browses labels and ticks without moving feed', {before,browsed});
    // Size landings and refresh merges use this Store port to rebase the feed
    // without user travel. Observe the actual scroll event and the tape after
    // settle, not just the synchronous DOM write.
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.feed.compensate(250)})()`);
    await page.poll(`document.querySelector('#candidatesCol').scrollTop===${before.scroll+250}`);
    await page.poll(`(async()=>${KZ}.state.feedActivity()==='settled'&&${KZ}.state.feedScrollTop()===${before.scroll+250})()`);
    const compensated = await page.evaluate(range);
    assert.equal(compensated.top,browsed.top,'compensation must keep the browsed tape window');
    assert.equal(compensated.bottom,browsed.bottom,'compensation must keep both browsed labels');
    console.log('ok compensation keeps rail browsing through the native scroll event and settle',compensated);
    const feedPoint = await page.evaluate(`(()=>{const r=document.querySelector('#candidatesCol').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    // Wait for compensation's own native event, then send real feed wheel input
    // before its 150ms settle. Capture the consumer in that event, not after the
    // debounce has cleared the suppression and could conceal this regression.
    const during = await page.evaluate(`(async()=>{const s=${KZ},col=document.querySelector('#candidatesCol'),revision=s.state.feedMotionRevision();
      return new Promise(resolve=>{col.addEventListener('scroll',()=>{const top=col.scrollTop,time=performance.now();
        window.__railWindowScroll=null;
        col.addEventListener('scroll',()=>{window.__railWindowScroll={elapsed:performance.now()-time,revision:s.state.feedMotionRevision(),range:${range}}},{once:true});
        resolve({revision,after:s.state.feedMotionRevision(),range:${range},top});
      },{once:true});s.actions.feed.compensate(100)});
    })()`);
    assert.equal(during.after,during.revision,'compensation does not publish motion');
    assert.equal(during.range.top,browsed.top,'compensation keeps the browsed window before settle');
    await page.mouse('mouseWheel',feedPoint.x,feedPoint.y,{deltaY:100});
    await page.poll(`!!window.__railWindowScroll`);
    const userScroll = await page.evaluate(`window.__railWindowScroll`);
    assert(userScroll.elapsed<150,'user input is observed inside the compensation settle window');
    assert.notEqual(userScroll.range.scroll,during.top,'real wheel input moves the feed');
    assert(userScroll.revision>during.revision,'user input during compensation publishes motion');
    assert.notEqual(userScroll.range.top,browsed.top,'user input during compensation resets the rendered rail browsing');
    console.log('ok real feed wheel during compensation publishes motion and retires rail browsing',{during,userScroll});
    await page.poll(`(async()=>${KZ}.state.feedActivity()==='settled')()`);
    await page.mouse('mouseWheel',point.x,point.y,{deltaY:1000});
    await page.poll(`Number(document.querySelector('.fr-top').textContent)>${userScroll.range.top}`);
    const tick = await page.evaluate(`(()=>{const ticks=[...document.querySelectorAll('.fr-tick')],t=ticks[Math.floor(ticks.length/2)],r=t.getBoundingClientRect();return{id:t.dataset.entryId,x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await page.mouse('mousePressed',tick.x,tick.y,{clickCount:1,buttons:1});
    await page.mouse('mouseReleased',tick.x,tick.y,{clickCount:1,buttons:0});
    await page.poll(`(async()=>${KZ}.state.currentEntry()?.entry.id===${JSON.stringify(tick.id)}&&document.querySelector('.fr-tick.current')?.dataset.entryId===${JSON.stringify(tick.id)})()`,20000);
    assert(await page.evaluate(`(()=>{const c=document.querySelector('.card.current'),f=document.querySelector('#candidatesCol');if(!c)return false;const r=c.getBoundingClientRect(),v=f.getBoundingClientRect();return r.bottom>v.top&&r.top<v.bottom})()`), 'clicked entry is visible in the feed');
    console.log('ok newly browsed tick reveals entry and tape follows jump', tick.id);
    await page.mouse('mouseWheel',point.x,point.y,{deltaY:-100000});
    await page.poll(`Number(document.querySelector('.fr-top').textContent)===1`);
    await page.mouse('mouseWheel',feedPoint.x,feedPoint.y,{deltaY:650});
    await page.poll(`Number(document.querySelector('.fr-top').textContent)>1&&!!document.querySelector('.fr-tick.current')`);
    console.log('ok feed scroll retires rail browsing and re-follows wave');
    await capture('rail-scroll-following');
    assert.deepEqual(errors, []);
    console.log('PASS rail-scroll (5 consumer contracts, no page errors)');
  } catch (error) {
    console.error('rail diagnostics', await page.evaluate(`(async()=>{const s=${KZ};return{host:s.state.host(),images:s.state.images.length,known:s.state.entriesWithKnownSize().length,current:s.state.current(),activity:s.state.feedActivity(),ticks:document.querySelectorAll('.fr-tick').length,text:document.body.innerText.slice(0,500)}})()`), errors);
    throw error;
  } finally { await page.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
