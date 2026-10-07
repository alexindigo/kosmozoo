// tests/e2e/feed.e2e.cjs — the §3.5 feed invariant as a spec: after a fling
// and a settle, every rendered card's height is EXACTLY cardHeight(size,
// colW) — estimateSize is the only geometry, nothing corrects it — and the
// current card's top does not move across a 5 s meta-poll window (meta
// patches never change geometry).
//
// Run via tests/e2e/run.sh (step 7; the dims pass has drained by then).

const { CDP, sleep, collectPageErrors } = require("./cdp.cjs");

const ENGINE = process.env.E2E_ENGINE ?? "http://127.0.0.1:18260";
const KZ = `(await import("/store/instance.js")).appStore`;
async function capture(page, name) {
  const fs = require('node:fs');
  fs.mkdirSync('/work/tests/e2e/.shots', { recursive: true });
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`/work/tests/e2e/.shots/${name}.png`, Buffer.from(shot.data, 'base64'));
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

// one audit: per-card height vs the ONE formula + the current card's top
const AUDIT = `(async () => {
  const kz = ${KZ};
  const { cardHeight } = await import("/store/sizes.js");
  const col = document.getElementById("candidatesCol");
  const colW = col.clientWidth;
  const cards = [...document.querySelectorAll(".card")];
  let maxDelta = 0, nullSize = 0;
  for (const el of cards) {
    const size = kz.state.cardSize(Number(el.dataset.idx));
    if (!size) { nullSize++; continue; }
    const d = Math.abs(el.getBoundingClientRect().height - cardHeight(size, colW));
    if (d > maxDelta) maxDelta = d;
  }
  const cur = document.querySelector(".card.current");
  return {
    cards: cards.length, nullSize, maxDelta,
    currentTop: cur ? cur.getBoundingClientRect().top : null,
    scrollTop: col.scrollTop,
  };
})()`;

async function railMotion(page) {
  await page.evaluate(`(async () => {
    const s=${KZ}; await s.actions.hosts.select('fixture-dir'); s.actions.ui.setWorkspace('details');
    s.actions.ui.setFilter(''); s.actions.folders.select('');
    if(s.state.judgmentPrefs.hideUp)s.actions.judgments.toggleHideUp();
    for(const im of s.state.images){
      await fetch('/api/collections/fixture-dir/entries/'+encodeURIComponent(im.filename)+'/bytes');
      await s.actions.judgments.dispatch(im.id,{type:'set',patch:{vote:null,favorite:null,bookmark:null}});
    }
    await s.actions.ui.refresh();
    window.__railOriginal=s.state.images.find(im=>im.filename.endsWith('.png')&&im.meta)?.filename??s.state.images[0].filename;
    s.actions.current.set('fixture-dir',window.__railOriginal);
    s.actions.feed.restoreToIndex(s.state.currentEntry().index);
  })()`);
  await page.poll(`(async()=>${KZ}.state.feedActivity()==='settled'&&document.querySelector('#workspace .info-body .ws-head .ws-name')?.textContent===window.__railOriginal)()`,20000);
  await capture(page,'rail-idle-before');
  const neutral=await page.evaluate(`(()=>{
    const tick=document.querySelector('#feedRail .fr-tick:not(.current)'),card=document.querySelector('.card:not(.current)');
    const probe=document.createElement('span');document.body.appendChild(probe);
    probe.style.color='var(--foreground-dim)';const railExpected=getComputedStyle(probe).color;
    probe.style.color='var(--focused-background)';const cardExpected=getComputedStyle(probe).color;probe.remove();
    return {rail:getComputedStyle(tick).backgroundColor,railExpected,card:card?getComputedStyle(card).borderColor:cardExpected,cardExpected};
  })()`);
  check('rail neutral: subdued foreground-dim while card neutral stays focused-background',neutral.rail===neutral.railExpected&&neutral.card===neutral.cardExpected,JSON.stringify(neutral));
  await page.evaluate(`(async()=>{
    const s=${KZ},col=s.state.feedScrollEl();const start=performance.now(),frames=[],events=[];
    const frame=()=>{const items=s.state.feedVirtualizer().getVirtualItems(),mid=col.scrollTop+col.clientHeight/2;
      let target=null;for(const item of items){if(item.start>mid)break;target=s.state.feedEntryAt(item.index)?.id??target;}
      frames.push({at:performance.now()-start,top:col.scrollTop,activity:s.state.feedActivity(),target,
        marker:document.querySelector('#feedRail .fr-tick.current')?.dataset.entryId??null,
        current:JSON.stringify(s.state.current()),trail:JSON.stringify(s.state.currentStack()),url:location.href,
        memory:localStorage.getItem('kosmozoo.sourceBrowse.v1'),name:document.querySelector('#workspace .info-body .ws-head .ws-name')?.textContent??null});
      if(performance.now()-start<3000)window.__railFrame=requestAnimationFrame(frame);};
    const onScroll=()=>events.push({at:performance.now()-start,top:col.scrollTop});col.addEventListener('scroll',onScroll);
    window.__railRecord={frames,events,stop(){cancelAnimationFrame(window.__railFrame);col.removeEventListener('scroll',onScroll);}};frame();
  })()`);
  try {
    const point=await page.evaluate(`(()=>{const r=document.getElementById('candidatesCol').getBoundingClientRect();const x=r.left+2,y=r.top+r.height/2;return{x,y,hit:document.elementFromPoint(x,y)?.className};})()`);
    console.log('RAIL WHEEL TARGET',JSON.stringify(point));
    let motionShot;
    for(let i=0;i<10;i++){
      await page.mouse('mouseWheel',point.x,point.y,{deltaY:700,modifiers:0});
      if(i===4)motionShot=capture(page,'rail-during-motion');
      await sleep(50);
    }
    await motionShot;
    await page.poll(`(async()=>{const s=${KZ};return s.state.feedActivity()==='settled'&&s.state.current()?.image!==window.__railOriginal&&document.querySelector('#workspace .info-body .ws-head .ws-name')?.textContent===s.state.current()?.image&&document.querySelector('#feedRail .fr-tick.current')?.dataset.entryId===s.state.currentEntry()?.entry.id;})()`,20000);
    await page.poll(`window.__railRecord.frames.some(f=>f.activity==='settled'&&f.current!==window.__railRecord.frames[0].current)`);
    const record=await page.evaluate(`window.__railRecord.stop();({frames:window.__railRecord.frames,events:window.__railRecord.events})`);
    require('node:fs').writeFileSync('/work/tests/e2e/.shots/rail-frames.json',JSON.stringify(record,null,2));
    const original=record.frames[0],moving=record.frames.filter(f=>f.activity==='scrolling'&&f.marker&&f.marker!==original.marker);
    const unchanged=f=>['current','trail','url','memory','name'].every(k=>f[k]===original[k]);
    const eventGaps=record.events.slice(1).map((e,i)=>e.at-record.events[i].at);
    const continuous=record.events.length>=4&&record.events.at(-1).at-record.events[0].at>150&&eventGaps.every(g=>g<150);
    check('rail timing: multiple live markers during continuous native scrolling while current/trail/URL/memory/rendered metadata remain deferred',
      continuous&&moving.length>=3&&new Set(moving.map(f=>f.marker)).size>=2&&moving.every(f=>unchanged(f)&&f.marker===f.target),
      JSON.stringify({events:record.events.length,maxGap:Math.max(...eventGaps),movingFrames:moving.length,markers:[...new Set(moving.map(f=>f.marker))]}));
    const handed=record.frames.filter(f=>f.activity==='settled'&&f.current!==original.current);
    check('rail settle: fresh current/URL and visible metadata adopt target without outgoing-marker flash',handed.length>0&&handed.every(f=>f.marker===JSON.parse(f.current).remote+':'+JSON.parse(f.current).image&&f.name===JSON.parse(f.current).image),JSON.stringify(handed.at(-1)));
    const audit=await page.evaluate(AUDIT);check('rail timing: exact retained card heights',audit.maxDelta===0&&audit.nullSize===0,JSON.stringify(audit));
    await capture(page,'rail-idle-after');
  } finally {
    const record=await page.evaluate(`window.__railRecord?.stop();({frames:window.__railRecord?.frames??[],events:window.__railRecord?.events??[]})`);
    require('node:fs').writeFileSync('/work/tests/e2e/.shots/rail-frames-final.json',JSON.stringify(record,null,2));
    console.log('RAIL RECORDER',JSON.stringify({events:record.events.length,frames:record.frames.length,last:record.frames.at(-1)}));
    await page.evaluate(`delete window.__railRecord;delete window.__railFrame`);
  }
}

(async () => {
  const page = await CDP.launch(9335, { windowSize: "1600,1200" });
  const pageErrors = await collectPageErrors(page);

  await page.goto(ENGINE + "/");
  await page.poll("!!document.querySelector('.card')", 20000);

  // deterministic substrate: the fake collection, every entry dimmed
  await page.evaluate(`(async () => {
    const kz = ${KZ};
    if (kz.state.host() !== "fake") await kz.actions.hosts.select("fake");
  })()`);
  await page.poll(`(async () => ${KZ}.state.images.length > 3000)()`, 20000);
  const dims = await page.evaluate(`(async () => (await (await fetch("/api/prefetch")).json()).dimsPending)()`);
  check("dims pass drained before the feed audit", dims === 0, `dimsPending=${dims}`);
  try { await railMotion(page); } catch(error) { check('rail scroll timing consumer',false,error.message); }

  // Card actions use the disposable folder collection, never a real host.
  await page.evaluate(`(async () => {
    const kz = ${KZ};
    await kz.actions.hosts.select("fixture-dir");
    const im = kz.state.images.find((i) => i.filename === "flux-basic.png");
    await kz.actions.judgments.dispatch(im.id, { type: "set", patch: { vote: null, favorite: null, bookmark: null } });
    kz.actions.current.set("fixture-dir", im.filename);
    kz.actions.feed.restoreToIndex(kz.state.imageIdxById().get(im.id));
  })()`);
  const card = '.card[data-name="flux-basic.png"]';
  await page.poll(`!!document.querySelector('${card}')`, 20000);
  const controls = await page.evaluate(`(() => {
    const el = document.querySelector('${card}');
    const buttons = [...el.querySelectorAll('.btnwrap button')];
    return {
      order: buttons.map((b) => b.className.split(' ')[1]),
      iconOnly: buttons.filter((b) => b.matches('.bookmark,.download')).every((b) => b.querySelector('svg') && !b.textContent.trim() && b.getAttribute('aria-label')),
      height: el.getBoundingClientRect().height,
      bookmark: !!el.querySelector('.bookmark'), download: !!el.querySelector('.download'),
    };
  })()`);
  const starAt = controls.order.indexOf("favorite");
  check("card actions: bookmark between star and icon-only download",
    controls.bookmark && controls.download && controls.iconOnly
      && controls.order[starAt + 1] === "bookmark" && controls.order[starAt + 2] === "download", JSON.stringify(controls));

  if (controls.bookmark && controls.download) {
    await page.clickAt(card + ' .bookmark');
    await page.poll(`(async () => {
      const el = document.querySelector('${card} .bookmark');
      const r = await fetch('/api/collections/fixture-dir/entries/flux-basic.png');
      return el?.getAttribute('aria-pressed') === 'true' && (await r.json()).judgment?.bookmark === true;
    })()`, 10000);
    const independent = await page.evaluate(`(() => {
      const el = document.querySelector('${card}');
      return { star: el.querySelector('.favorite').getAttribute('aria-pressed'), color: getComputedStyle(el.querySelector('.bookmark')).color, height: el.getBoundingClientRect().height };
    })()`);
    check("bookmark: blue, immediate independent toggle without geometry change",
      independent.star === "false" && independent.color === "rgb(56, 189, 248)"
        && independent.height === controls.height, JSON.stringify(independent));
    await page.goto(ENGINE + '/#fixture-dir#flux-basic.png');
    await page.poll(`document.querySelector('${card} .bookmark')?.getAttribute('aria-pressed') === 'true'`, 20000);
    check("bookmark: persisted state reaches the reloaded card", true);
    await page.clickAt(card + ' .favorite');
    await page.poll(`document.querySelector('${card} .favorite')?.getAttribute('aria-pressed') === 'true'`, 10000);
    check("favorite: toggling star leaves bookmark enabled",
      await page.evaluate(`document.querySelector('${card} .bookmark').getAttribute('aria-pressed') === 'true'`));
    await page.clickAt(card + ' .bookmark');
    await page.poll(`(async () => !(await (await fetch('/api/collections/fixture-dir/entries/flux-basic.png')).json()).judgment?.bookmark)()`, 10000);
    check("bookmark: clearing it leaves favorite enabled",
      await page.evaluate(`document.querySelector('${card} .favorite').getAttribute('aria-pressed') === 'true'`));

    const fs = require('fs');
    const dir = fs.mkdtempSync('/tmp/kz-card-download-');
    try {
      await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
      await page.clickAt(card + ' .download');
      for (let i = 0; i < 100 && !fs.readdirSync(dir).some((n) => n.endsWith('.png')); i++) await sleep(50);
      const files = fs.readdirSync(dir).filter((n) => n.endsWith('.png'));
      check("download icon: click produces image bytes", files.length === 1 && fs.statSync(dir + '/' + files[0]).size > 100);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // Each state retains its border treatment when current, and changes
  // decoration only (including the rail's corresponding color).
  for (const [mode, token] of [["plain", "--foreground-bright"], ["up", "--positive-dim"], ["down", "--negative"], ["bookmark", "--primary"], ["favorite", "--attention"], ["favorite-bookmark", "--attention"]]) {
    const appearance = await page.evaluate(`(async () => {
      const kz = ${KZ};
      const im = kz.state.images.find((i) => i.filename === "flux-basic.png");
      if (!kz.state.judgmentPrefs.revealThumbedDown) kz.actions.judgments.toggleReveal();
      await kz.actions.judgments.dispatch(im.id, { type: "set", patch: {
        favorite: ${JSON.stringify(mode.startsWith("favorite"))},
        bookmark: ${JSON.stringify(mode.includes("bookmark"))},
        vote: ${JSON.stringify(mode === "up" || mode === "down" ? mode : null)},
      } });
      kz.actions.current.set("fixture-dir", im.filename);
      const el = document.querySelector('${card}');
      const cs = getComputedStyle(el);
      const probe = document.createElement('span');
      probe.style.color = 'var(${token})'; document.body.appendChild(probe);
      const expected = getComputedStyle(probe).color; probe.remove();
      const shadowProbe = document.createElement('span');
      shadowProbe.style.boxShadow = 'inset 0 0 12px color-mix(in srgb, var(${token}) 35%, transparent)';
      document.body.appendChild(shadowProbe);
      const expectedGlow = getComputedStyle(shadowProbe).boxShadow; shadowProbe.remove();
      const tick = [...document.querySelectorAll('#feedRail .fr-tick')].find((t) => t.dataset.entryId === im.id);
      const state = kz.state.cardState(im.id);
      return { border: cs.borderColor, expected, glow: cs.boxShadow, expectedGlow, height: el.getBoundingClientRect().height,
        rail: tick ? getComputedStyle(tick).backgroundColor : null,
        treatment: state.treatment, cardTreatment: el.dataset.treatment, tickTreatment: tick?.dataset.treatment,
        favorite: el.querySelector('.favorite').getAttribute('aria-pressed'),
        bookmark: el.querySelector('.bookmark').getAttribute('aria-pressed'),
      };
    })()`);
    check("current " + mode + ": matching border, inward glow and rail; height unchanged",
      appearance.border === appearance.expected && appearance.glow === appearance.expectedGlow
        && appearance.height === controls.height && appearance.rail === appearance.expected
        && appearance.treatment === appearance.cardTreatment && appearance.treatment === appearance.tickTreatment
        && appearance.favorite === String(mode.startsWith("favorite"))
        && appearance.bookmark === String(mode.includes("bookmark")), JSON.stringify(appearance));
  }

  const origins = await page.evaluate(`(async () => {
    const kz = ${KZ};
    const im = kz.state.images.find((i) => i.filename === "flux-basic.png");
    const id = im.id;
    const snapshot = () => {
      const el = document.querySelector('${card}');
      const tick = [...document.querySelectorAll('#feedRail .fr-tick')].find((t) => t.dataset.entryId === id);
      return { bookmark: el.querySelector('.bookmark').getAttribute('aria-pressed'),
        border: getComputedStyle(el).borderColor, tick: getComputedStyle(tick).backgroundColor,
        treatment: el.dataset.treatment };
    };
    await kz.actions.judgments.dispatch(id, { type: "set", patch: { favorite: null, vote: null, bookmark: null } });
    kz.actions.current.set("fixture-dir", im.filename);
    await kz.actions.judgments.dispatch(id, { type: "toggle", field: "bookmark" });
    const programmatic = snapshot();
    kz.actions.keys.register("test.bookmark.intent", "Alt+Shift+F8", () =>
      kz.actions.judgments.dispatch(id, { type: "toggle", field: "bookmark" }));
    return { programmatic };
  })()`);
  check("programmatic intent: bookmark drives both border and tick blue",
    origins.programmatic.bookmark === 'true' && origins.programmatic.border === 'rgb(56, 189, 248)'
      && origins.programmatic.tick === origins.programmatic.border, JSON.stringify(origins));
  await page.key("F8", { alt: true, shift: true });
  await page.poll(`(async () => {
    const j = (await (await fetch('/api/collections/fixture-dir/entries/flux-basic.png')).json()).judgment;
    return !j?.bookmark && document.querySelector('${card} .bookmark')?.getAttribute('aria-pressed') === 'false';
  })()`, 10000);
  check("keyboard intent: same handler clears bookmark, control and treatment", true);
  const fromApi = await page.evaluate(`(async () => {
    const kz = ${KZ};
    const r = await fetch('/api/collections/fixture-dir/entries/flux-basic.png/judgment', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: true, bookmark: true })
    });
    if (!r.ok) throw new Error('fixture judgment failed');
    await kz.actions.ui.refresh();
    const el = document.querySelector('${card}');
    const id = kz.state.images.find((i) => i.filename === 'flux-basic.png').id;
    kz.actions.current.set('fixture-dir', 'flux-basic.png');
    const tick = [...document.querySelectorAll('#feedRail .fr-tick')].find((t) => t.dataset.entryId === id);
    const cs = getComputedStyle(el);
    return { border: cs.borderColor, tick: getComputedStyle(tick).backgroundColor, glow: cs.boxShadow,
      star: el.querySelector('.favorite').getAttribute('aria-pressed'), bookmark: el.querySelector('.bookmark').getAttribute('aria-pressed') };
  })()`);
  check("API/refresh state: mixed favorite/bookmark controls active, orange border/glow/tick",
    fromApi.star === 'true' && fromApi.bookmark === 'true' && fromApi.border === 'rgb(255, 136, 0)'
      && fromApi.tick === fromApi.border && fromApi.glow.includes('inset'), JSON.stringify(fromApi));
  const fixedGlow = await page.evaluate(`(async () => {
    const kz = ${KZ};
    const el = document.querySelector('${card}');
    const before = getComputedStyle(el).boxShadow;
    const height = el.getBoundingClientRect().height;
    kz.actions.current.set('fixture-dir', 'flux-lora.png');
    const after = getComputedStyle(el).boxShadow;
    const probe = document.createElement('span');
    probe.style.boxShadow = 'inset 0 0 12px color-mix(in srgb, var(--focused-background) 35%, transparent)';
    document.body.appendChild(probe);
    const expectedAfter = getComputedStyle(probe).boxShadow; probe.remove();
    return { before, after, expectedAfter, heightUnchanged: el.getBoundingClientRect().height === height,
      border: getComputedStyle(el).borderColor };
  })()`);
  check("current moves: shadow remains drawn with fixed geometry, only color changes",
    fixedGlow.before.includes('0px 0px 12px 0px inset') && fixedGlow.after.includes('0px 0px 12px 0px inset')
      && fixedGlow.before !== fixedGlow.after && fixedGlow.heightUnchanged
      && fixedGlow.after === fixedGlow.expectedAfter
      && fixedGlow.border === 'rgb(255, 136, 0)', JSON.stringify(fixedGlow));
  await page.evaluate(`(async () => ${KZ}.actions.current.set('fixture-dir', 'flux-basic.png'))()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.poll(`(async () => {
    const audit = await ${AUDIT};
    return audit.cards > 0 && audit.maxDelta === 0;
  })()`, 10000);
  const narrow = await page.evaluate(AUDIT);
  check("narrow viewport: icon controls preserve exact card geometry", narrow.cards > 0 && narrow.nullSize === 0 && narrow.maxDelta === 0, JSON.stringify(narrow));
  const containment = await page.evaluate(`(() => {
    const el = document.querySelector('${card}');
    const bounds = el.getBoundingClientRect();
    return [...el.querySelectorAll('.btnwrap button')].every((b) => {
      const r = b.getBoundingClientRect();
      return r.left >= bounds.left && r.right <= bounds.right;
    });
  })()`);
  check("narrow viewport: every card action remains inside its card", containment);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  const compressedWidth = await page.evaluate(`(async () => {
    const kz = ${KZ};
    const previous = kz.state.anchorPaneWidth();
    kz.actions.anchors.setPaneWidth(560);
    return previous;
  })()`);
  await page.poll(`(async () => {
    const audit = await ${AUDIT};
    return audit.cards > 0 && audit.maxDelta === 0;
  })()`, 10000);
  await page.poll(`(() => {
    const el = document.querySelector('${card}');
    const bounds = el.getBoundingClientRect();
    return [...el.querySelectorAll('.btnwrap button')].every((b) => {
      const r = b.getBoundingClientRect(); return r.left >= bounds.left && r.right <= bounds.right;
    });
  })()`, 10000);
  const compressed = await page.evaluate(AUDIT);
  check("resized workspace: narrow feed actions fit with exact geometry on desktop", compressed.cards > 0 && compressed.nullSize === 0 && compressed.maxDelta === 0, JSON.stringify(compressed));
  await page.evaluate(`(async () => ${KZ}.actions.anchors.setPaneWidth(${compressedWidth}))()`);
  await page.send('Emulation.clearDeviceMetricsOverride');
  const reordered = await page.evaluate(`(async () => {
    const kz = ${KZ};
    const { api } = await import('/js/api.mjs');
    const { cardHeight, gridGapPx } = await import('/store/sizes.js');
    const original = api.inventory;
    const inventory = await original('fixture-dir'), rows = inventory.entries;
    api.inventory = async (id) => id === 'fixture-dir' ? { ...inventory, entries: [...rows].reverse() } : original(id);
    try {
      await kz.actions.ui.refresh();
      const list = kz.state.entriesWithKnownSize();
      const expected = new Map(); let start = 0;
      for (const idx of list) {
        const im = kz.state.images[idx];
        const size = cardHeight(kz.state.cardSize(idx), kz.state.feedScrollEl().clientWidth) + gridGapPx();
        expected.set(im.id, { start, size }); start += size;
      }
      return kz.state.feedVirtualizer().getVirtualItems().every((it) => {
        const im = kz.state.feedEntryAt(it.index);
        const rect = expected.get(im.id);
        return it.key === im.id && it.start === rect.start && it.size === rect.size;
      });
    } finally {
      api.inventory = original;
      await kz.actions.ui.refresh();
    }
  })()`);
  check("same-count reorder: virtual keys, offsets and sizes match the identity-keyed feed", reordered);
  const smallLanding = await page.evaluate(`(async () => {
    const kz = ${KZ};
    const { api } = await import('/js/api.mjs');
    const original = api.inventory;
    const inventory = await original('fixture-dir'), rows = inventory.entries;
    const withheld = rows.find((e) => e.name === 'flux-controlnet.png');
    const base = rows.filter((e) => e !== withheld);
    api.inventory = async (id) => id === 'fixture-dir' ? { ...inventory, entries: base } : original(id);
    try {
      kz.actions.current.set('fixture-dir', base[0].name);
      await kz.actions.images.reload();
      const vz = kz.state.feedVirtualizer(), col = kz.state.feedScrollEl();
      const anchorName = base[2].name;
      const index = kz.state.images.findIndex((im) => im.filename === anchorName);
      const pos = kz.state.feedPositionOf(kz.state.images[index].id);
      col.scrollTop = vz.getVirtualItems().find((it) => it.index === pos).start + 20;
      col.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 250));
      const el = () => [...document.querySelectorAll('.card')].find((e) => e.dataset.name === anchorName);
      const beforeCard = el();
      const beforeEditor = beforeCard.querySelector('textarea');
      const before = beforeCard.getBoundingClientRect().top;
      api.inventory = async (id) => id === 'fixture-dir' ? { ...inventory, entries: [base[0], withheld, ...base.slice(1)] } : original(id);
      await kz.actions.ui.refresh();
      return { before, after: el().getBoundingClientRect().top,
        sameCard: beforeCard === el(), sameEditor: !!beforeEditor && beforeEditor === el().querySelector('textarea') };
    } finally {
      api.inventory = original;
      await kz.actions.ui.refresh();
    }
  })()`);
  check("small feed scroll: inserts before the actual viewport anchor do not move its card",
    // The browser rounds scroll offsets to physical pixels; card layout
    // remains fractional. Bound that rounding, not a card-sized movement.
    Math.abs(smallLanding.before - smallLanding.after) < 1, JSON.stringify(smallLanding));
  check("small feed insertion: retained entry keeps the same mounted card and editor",
    smallLanding.sameCard && smallLanding.sameEditor, JSON.stringify(smallLanding));
  await page.evaluate(`(async () => {
    const kz = ${KZ};
    const im = kz.state.images.find((i) => i.filename === "flux-basic.png");
    await kz.actions.judgments.dispatch(im.id, { type: "set", patch: { vote: null, favorite: null, bookmark: null } });
    if (kz.state.judgmentPrefs.revealThumbedDown) kz.actions.judgments.toggleReveal();
    await kz.actions.hosts.select("fake");
  })()`);
  await page.poll(`(async () => ${KZ}.state.images.length > 3000)()`, 20000);

  // fling deep into the list, then settle — settled means the scroll
  // position held still across a beat and the current card was assigned
  // (no fixed sleep)
  await page.evaluate(`(() => { document.getElementById("candidatesCol").scrollTop = 144000; })()`);
  await page.poll(`(async () => {
    const c = document.getElementById("candidatesCol");
    const a = c.scrollTop;
    await new Promise(r => setTimeout(r, 250));
    return a === c.scrollTop && !!document.querySelector(".card.current");
  })()`, 15000);

  const a1 = await page.evaluate(AUDIT);
  check("cards rendered after the fling", a1.cards > 0, `${a1.cards} cards @ scrollTop ${a1.scrollTop}`);
  check("every card height === cardHeight(size, colW)", a1.nullSize === 0 && a1.maxDelta === 0,
    `nullSize=${a1.nullSize} maxDelta=${a1.maxDelta}`);

  // meta patches land inside this window — geometry must not move. The
  // 5 s span IS the assertion (the poll interval is 5 s), not a settle
  // sleep: the audit runs again after it, unchanged.
  await sleep(5000);
  const a2 = await page.evaluate(AUDIT);
  check("heights still exact after the 5 s meta window", a2.nullSize === 0 && a2.maxDelta === 0,
    `nullSize=${a2.nullSize} maxDelta=${a2.maxDelta}`);
  check("current card's top did not move", a1.currentTop !== null && a2.currentTop === a1.currentTop,
    `${a1.currentTop} -> ${a2.currentTop}`);

  // --- above-fold landings: a size landing behind the fold inserts a card
  // above the viewport; the feed compensates, so the list does not shift ---
  const prefetchCtl = (kv) => page.evaluate(`(async () => {
    await fetch("/api/prefetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(${JSON.stringify(kv)}) });
  })()`);
  try {
    const FAKE = process.env.E2E_FAKE ?? "http://127.0.0.1:18261";
    const fakeAddr = FAKE.replace(/^https?:\/\//, "");
    // an "undimmed" collection: a fresh id on the same fake host with the
    // walk DISABLED (walk lanes frozen, prio lanes drain), so only wanted
    // files ever carry dims. Both flags are set explicitly — the engine's
    // settings persist across suite runs. The dims prio lane shares one
    // event loop with every collection's worker, so the case waits for the
    // boot backlog to drain first (a no-op late in the suite).
    await page.poll(`(async () => {
      const pf = await (await fetch("/api/prefetch")).json();
      return pf.ingestPending === 0 && pf.dimsPending === 0;
    })()`, 300000);
    await prefetchCtl({ enabled: false, paused: false });
    await page.evaluate(`(async () => {
      await fetch("/api/collections/undim", { method: "DELETE" }).catch(() => null); // residue from an earlier run
      const r = await fetch("/api/collections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "undim", address: "${fakeAddr}" }) });
      return r.status;
    })()`);
    const names = await page.evaluate(`(async () =>
      (await (await fetch("/api/collections/undim/entries")).json()).map((e) => e.name))()`);
    check("undim collection listed", names.length > 2000, `${names.length} entries`);
    // dims for [0..1599] except the 50-name window [1400..1449] — the
    // behind window that must resolve before anything below it
    const wanted = names.filter((_, i) => i < 1600 && !(i >= 1400 && i < 1450));
    await page.evaluate(`(async () => {
      const r = await fetch("/api/collections/undim/want", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: ${JSON.stringify(wanted)} }),
      });
      if (!r.ok) throw new Error("want failed: " + r.status + " " + (await r.text()));
    })()`);
    // engine-side first: the wanted 1550 carry dims (the prio lane drains
    // at ~20/s while the walk stays frozen); then the client's meta poll
    // merges them into the known list within a poll cycle
    await page.poll(`(async () =>
      (await (await fetch("/api/collections/undim/entries")).json())
        .filter((e) => e.width != null).length >= 1550)()`, 180000);
    await page.evaluate(`(async () => { await ${KZ}.actions.hosts.select("undim"); })()`);
    await page.poll(`(async () => ${KZ}.state.entriesWithKnownSize().length >= 1550)()`, 30000);

    // scrub-jump deep into the list, settle, audit
    await page.evaluate(`(async () => {
      const kz = ${KZ};
      kz.actions.feed.restoreToIndex(kz.state.entriesWithKnownSize()[1500]);
    })()`);
    await page.poll(`(async () => {
      const c = document.getElementById("candidatesCol");
      const a = c.scrollTop;
      await new Promise(r => setTimeout(r, 250));
      return a === c.scrollTop && !!document.querySelector(".card.current");
    })()`, 15000);
    const b1 = await page.evaluate(AUDIT);

    // the behind window lands above the fold — poll its two ends in
    await page.poll(`(async () => {
      const kz = ${KZ};
      const known = new Set(kz.state.entriesWithKnownSize());
      const imgs = kz.state.images;
      return known.has(imgs.findIndex((i) => i.filename === ${JSON.stringify(names[1400])}))
          && known.has(imgs.findIndex((i) => i.filename === ${JSON.stringify(names[1449])}));
    })()`, 60000);
    check("behind window landed above the fold", true);
    const b2 = await page.evaluate(AUDIT);
    check("current card's top did not move across the landings",
      b1.currentTop !== null && b2.currentTop === b1.currentTop, `${b1.currentTop} -> ${b2.currentTop}`);
    check("heights still exact after the landings", b2.nullSize === 0 && b2.maxDelta === 0,
      `nullSize=${b2.nullSize} maxDelta=${b2.maxDelta}`);
  } catch (e) {
    check("above-fold landings case", false, e.message.slice(0, 200));
  } finally {
    // leave the engine as found: walk resumed, scratch collection gone
    try {
      await page.evaluate(`(async () => {
        await fetch("/api/prefetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, paused: false }) });
        await fetch("/api/collections/undim", { method: "DELETE" }).catch(() => null);
      })()`);
    } catch { /* engine teardown handles it */ }
  }

  // The topbar-only split must follow the actual feed edge without changing
  // the main composition: two workspace modes, widths, expansion and real drag.
  try {
    await page.evaluate(`(async () => {
      const s = ${KZ}; await s.actions.hosts.select('fake'); s.actions.ui.setFilter('');
    })()`);
    const geometry = `(() => {
      const region = document.getElementById('candidatesCol').getBoundingClientRect();
      const icon = document.getElementById('filterBtn').getBoundingClientRect();
      const control = document.querySelector('.feed-filter').getBoundingClientRect();
      const input = document.getElementById('filter').getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(document.getElementById('chrome')).getPropertyValue('--chrome-inset'));
      return { delta: Math.max(Math.abs(control.right - (region.right - inset)), Math.abs(icon.right - (region.right - inset))), icon: icon.right,
        inputLeft: input.left, inputRight: input.right, iconLeft: icon.left, boundary: region.right,
        barRight: document.getElementById('wsBar').getBoundingClientRect().right, viewport: innerWidth };
    })()`;
    for (const width of [1400, 780, 480]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const space of ['details', 'anchors']) {
        await page.evaluate(`(async () => ${KZ}.actions.ui.setWorkspace('${space}'))()`);
        await page.poll(`(${geometry}).delta <= 1`);
        const before = await page.evaluate(geometry);
        await page.clickAt('#filterBtn');
        await page.poll(`!document.getElementById('filter').hidden && document.activeElement.id === 'filter'`);
        const after = await page.evaluate(geometry);
        check(`filter geometry ${width}/${space}: same feed edge, input left, icon stationary`,
          after.delta <= 1 && Math.abs(before.icon - after.icon) < 1 && after.inputRight <= after.iconLeft && after.barRight <= after.viewport,
          JSON.stringify({ before, after }));
        await page.evaluate(`(async () => {
          const s = ${KZ}; await s.actions.hosts.patch('fake', { pinned: true });
          await s.actions.hosts.patch('another', { pinned: true }); s.actions.folders.select('geometry/long-caption');
        })()`);
        await page.poll(`(${geometry}).delta <= 1`);
        check(`folder/pin geometry ${width}/${space}: caption and separated scroll strip retain the feed boundary`, await page.evaluate(`(() => {
          const icon = document.getElementById('filterBtn').getBoundingClientRect();
          const folder = document.getElementById('outputFolder').getBoundingClientRect();
          const separator = document.querySelector('.pinned-separator').getBoundingClientRect();
          const strip = document.querySelector('.pinned-sources').getBoundingClientRect();
          return (${geometry}).delta <= 1 && Math.abs(icon.right - ${after.icon}) <= 1 && folder.width > 0 &&
            separator.right <= strip.left + 1 && document.getElementById('outputFolder').title.includes('geometry/long-caption');
        })()`));
        await page.evaluate(`(async () => { const s = ${KZ}; s.actions.folders.select('');
          await s.actions.hosts.patch('fake', { pinned: false }); await s.actions.hosts.patch('another', { pinned: false }); })()`);
        await page.poll(`(${geometry}).delta <= 1 && !document.querySelector('.pinned-separator')`);
        check(`empty-pin geometry ${width}/${space}: no separator and unchanged flexible boundary`, (await page.evaluate(geometry)).delta <= 1);
        await capture(page, `filter-expanded-${width}-${space}`);
        const divider = await page.evaluate(`(() => {
          const r = document.getElementById('divider').getBoundingClientRect();
          return { x: r.left + r.width/2, y: r.top + Math.min(100, r.height/2) };
        })()`);
        await page.drag(divider.x, divider.y, Math.max(40, divider.x - 30), divider.y);
        await page.poll(`(${geometry}).delta <= 1`);
        check(`filter geometry ${width}/${space}: follows trusted pane drag`, (await page.evaluate(geometry)).delta <= 1);
        await page.key('Escape');
        await page.poll(`document.getElementById('filter').hidden`);
      }
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(async () => ${KZ}.actions.anchors.setPaneWidth(300))()`);
  } catch (error) { check('topbar JS-synchronized geometry', false, error.message); }

  // End-of-chain proof: real external completion -> listing -> real image
  // acquisition -> decoded card, while the incremental merge retains edits.
  const FAKE_ACTIVITY = process.env.E2E_FAKE ?? 'http://127.0.0.1:18261';
  const control = async (body) => {
    const r = await fetch(FAKE_ACTIVITY + '/__test/activity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('activity fixture control failed');
  };
  try {
    await control({ reset: true });
    await page.evaluate(`(async () => {
      const s = ${KZ}; await s.actions.hosts.select('fake');
      s.actions.ui.setWorkspace('details');
      await s.actions.hosts.patch('fake', { pinned: true, autoRefresh: true });
      await s.actions.hosts.pollActivity('fake');
      s.actions.current.set('fake', 'flux-basic.png');
      s.actions.feed.restoreToIndex(s.state.currentEntry().index);
      s.actions.selected.set('fake:flux-basic.png', true);
      s.actions.ui.setFilter('.png');
      const blob = await (await fetch('/api/collections/fake/entries/flux-basic.png/bytes')).blob();
      await s.actions.anchors.addFiles([new File([blob], 'source-refresh-anchor.png', { type: 'image/png' })]);
      s.actions.ui.setWorkspace('anchors');
      s.actions.diff.setMode('split'); s.actions.diff.setSplit(.37);
      s.actions.views.set('fake:flux-basic.png', { s: 2, txf: .1, tyf: .2 }, { persist: false });
      s.actions.views.set('anchor:source-refresh-anchor.png', { s: 2, txf: .1, tyf: .2 }, { persist: false });
      const { api } = await import('/js/api.mjs');
      let release; const gate = new Promise((r) => release = r);
      window.__sourceApi = { setJudgment: api.setJudgment, inventory: api.inventory, want: api.want };
      window.__sourceRelease = release; window.__sourceUnknown = false; window.__sourceWanted = false;
      api.setJudgment = async (...args) => { await gate; return window.__sourceApi.setJudgment(...args); };
      api.inventory = async (id) => {
        const inventory = await window.__sourceApi.inventory(id);
        const output = inventory.entries.find((r) => r.name === 'e2e-source-completed.png');
        if (output && !output.width) window.__sourceUnknown = true;
        return inventory;
      };
      api.want = async (id, files) => {
        if (id === 'fake' && files.includes('e2e-source-completed.png')) window.__sourceWanted = true;
        return window.__sourceApi.want(id, files);
      };
      await fetch('/api/prefetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: true }) });
    })()`);
    await page.poll(`(async () => ${KZ}.state.feedActivity() === 'settled' && document.querySelector('.card[data-name="flux-basic.png"] img')?.naturalWidth > 0)()`);
    const origin = '.card[data-name="flux-basic.png"]';
    await page.clickAt(origin + ' .bookmark');
    await page.poll(`document.querySelector('${origin} .bookmark').getAttribute('aria-pressed') === 'true'`);
    await page.clickAt(origin + ' textarea.pos');
    await page.send('Input.insertText', { text: 'pending source-refresh note' });
    await page.poll(`(async () => ${KZ}.state.drafts['fake:flux-basic.png:pos']?.includes('pending source-refresh note'))()`);
    await page.clickAt(origin + ' .variations');
    await page.poll(`!!document.querySelector('.vz-row-inc-input')`, 20000);
    await page.evaluate(`(() => {
      const input = document.querySelector('.vz-row-inc-input');
      input.value = '3'; input.dispatchEvent(new Event('input', { bubbles: true }));
      window.__sourceModal = document.querySelector('.vz-panel'); window.__sourceField = input;
    })()`);
    const before = await page.evaluate(`(async () => {
      const s = ${KZ}; s.actions.diff.ensureRightDefault(); s.actions.diff.open();
      window.__sourceCard = document.querySelector('${origin}');
      return { current: s.state.current(), trail: s.state.currentStack(), url: location.href,
        top: window.__sourceCard.getBoundingClientRect().top, pair: s.state.diffPair(),
        view: JSON.stringify({ feed: s.state.views['fake:flux-basic.png'], right: s.state.views['anchor:source-refresh-anchor.png'] }), anchors: s.state.anchors.map((a) => a.name),
        draft: s.state.drafts['fake:flux-basic.png:pos'], field: window.__sourceField.value };
    })()`);
    await capture(page, 'source-edited-session-before');
    await control({ finish: [{ id: 'feed-external-finish', output: 'e2e-source-completed.png' }] });
    await page.poll(`(async () => ${KZ}.state.images.some((i) => i.filename === 'e2e-source-completed.png'))()`, 20000);
    await page.poll(`(async () => ${KZ}.state.images.find((i) => i.filename === 'e2e-source-completed.png')?.width > 0)()`, 20000);
    const preserved = await page.evaluate(`(async () => {
      const s = ${KZ};
      return { current: s.state.current(), trail: s.state.currentStack(), url: location.href,
        top: document.querySelector('${origin}').getBoundingClientRect().top, pair: s.state.diffPair(),
        view: JSON.stringify({ feed: s.state.views['fake:flux-basic.png'], right: s.state.views['anchor:source-refresh-anchor.png'] }), anchors: s.state.anchors.map((a) => a.name),
        draft: s.state.drafts['fake:flux-basic.png:pos'], field: window.__sourceField.value,
        sameCard: window.__sourceCard === document.querySelector('${origin}'),
        sameModal: window.__sourceModal === document.querySelector('.vz-panel'),
        sameField: window.__sourceField === document.querySelector('.vz-row-inc-input'),
        selected: s.state.selected['fake:flux-basic.png'], filter: s.state.filter(),
        split: s.state.diff.splitT, mode: s.state.diff.mode, bookmark: s.state.images.find((i) => i.filename === 'flux-basic.png').judgment.bookmark,
        unknown: window.__sourceUnknown, wanted: window.__sourceWanted };
    })()`);
    check('completion insertion preserves mounted card/modal, pending notes/judgment, pair/crops, URL and viewport',
      preserved.sameCard && preserved.sameModal && preserved.sameField && preserved.selected && preserved.bookmark &&
      JSON.parse(before.view).feed?.s > 1 && JSON.parse(before.view).right?.s > 1 &&
      preserved.filter === '.png' && preserved.split === .37 && preserved.mode === 'split' &&
      Math.abs(preserved.top - before.top) <= 1 &&
      ['current', 'trail', 'url', 'pair', 'view', 'anchors', 'draft', 'field'].every((key) => JSON.stringify(preserved[key]) === JSON.stringify(before[key])),
      JSON.stringify({ before, after: preserved }));
    check('new output begins unknown-sized and is promoted through real want/dimension acquisition', preserved.unknown && preserved.wanted);
    await capture(page, 'source-edited-session-after');
    await page.key('Escape');
    await page.poll(`(async () => !${KZ}.state.variations.open)()`);
    await page.key('Escape');
    await page.poll(`(async () => !${KZ}.state.diff.open)()`);
    await page.evaluate(`(async () => ${KZ}.actions.feed.scrollTop())()`);
    await page.poll(`(async () => {
      const s = ${KZ}, card = document.querySelector('.card[data-name="e2e-source-completed.png"]');
      const image = card?.querySelector('img');
      if (!image?.naturalWidth || s.state.feedActivity() !== 'settled' || s.state.feedScrollEl().scrollTop > 1) return false;
      const box = image.getBoundingClientRect(), feed = s.state.feedScrollEl().getBoundingClientRect();
      return box.top < feed.bottom && box.bottom > feed.top && box.width > 0 && box.height > 0;
    })()`, 20000);
    check('external finish automatically produces a decoded/rendered output card without refresh click', true);
    await capture(page, 'source-completed-output-1400');
    await page.evaluate(`(async () => ${KZ}.actions.hosts.patch('fake', { autoRefresh: false }))()`);
    await page.poll(`(async () => !${KZ}.state.hosts.fake.autoRefresh)()`);
    const nonce = await page.evaluate(`(async () => ${KZ}.state.feedMergeNonce())()`);
    await control({ finish: [{ id: 'feed-disabled-finish', output: 'e2e-source-disabled.png' }] });
    await page.poll(`(async () => {
      const r = await (await fetch('/api/collections/fake/activity')).json();
      return r.terminalRevision >= 2 && ${KZ}.state.sourceActivity.fake?.terminalRevision === r.terminalRevision;
    })()`, 20000);
    check('auto-refresh off leaves feed unchanged through observed finish', await page.evaluate(`(async () =>
      !${KZ}.state.images.some((i) => i.filename === 'e2e-source-disabled.png') && ${KZ}.state.feedMergeNonce() === ${nonce})()`));
    await page.clickAt('#refreshBtn');
    await page.poll(`(async () => ${KZ}.state.images.some((i) => i.filename === 'e2e-source-disabled.png'))()`, 10000);
    check('manual refresh still merges disabled-source output', true);
    await page.evaluate(`(async () => { const s = ${KZ}; await s.actions.hosts.patch('fake', { autoRefresh: true }); await s.actions.hosts.select('another'); })()`);
    await control({ finish: [{ id: 'feed-inactive-finish', output: 'e2e-source-inactive.png' }] });
    await page.poll(`(async () => ${KZ}.state.sourceActivity.fake?.terminalRevision >= 3)()`, 20000);
    check('inactive completion never switches selected source or writes its feed', await page.evaluate(`(async () =>
      ${KZ}.state.host() === 'another' && ${KZ}.state.images.every((i) => i.host === 'another'))()`));
    await page.clickAt('.pinned-source[data-source="fake"]');
    await page.poll(`document.querySelector('.card[data-name="e2e-source-inactive.png"] img')?.naturalWidth > 0`, 20000);
    check('normal pinned selection reads latest completed output', true);
    // A slow initial history baseline may absorb an execution as old history.
    // First-known activity must still catch up a feed loaded while unknown.
    await control({ delays: { history: 4000 } });
    await page.evaluate(`(async () => {
      const s = ${KZ};
      await fetch('/api/prefetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: false, enabled: true }) });
      await s.actions.hosts.add('startup-window', '127.0.0.2:${new URL(FAKE_ACTIVITY).port}');
      await s.actions.hosts.patch('startup-window', { autoRefresh: true });
      await fetch('/api/collections/startup-window/entries/flux-basic.png/bytes');
      await s.actions.hosts.select('startup-window');
    })()`);
    await page.poll(`(async () => ${KZ}.state.sourceActivity['startup-window']?.state === 'unknown')()`, 5000);
    await control({ finish: [{ id: 'during-startup-history', output: 'e2e-startup-window.png' }] });
    await page.poll(`document.querySelector('.card[data-name="e2e-startup-window.png"] img')?.naturalWidth > 0`, 25000);
    const startup = await page.evaluate(`(async () => ({
      host: ${KZ}.state.host(), revision: ${KZ}.state.sourceActivity['startup-window'].terminalRevision,
      decoded: document.querySelector('.card[data-name="e2e-startup-window.png"] img').naturalWidth,
    }))()`);
    check('first known activity catches up decoded output without replaying startup history as new finishes',
      startup.host === 'startup-window' && startup.revision === 0 && startup.decoded > 0, JSON.stringify(startup));
    await control({ delays: {} });
    await page.evaluate(`(async () => { const s = ${KZ}; await s.actions.hosts.select('fake'); await s.actions.hosts.remove('startup-window'); })()`);
  } catch (error) { check('source completion consumer/preservation case', false, error.message); }
  finally {
    await control({ reset: true });
    await page.evaluate(`(async () => {
      const s = ${KZ}, { api } = await import('/js/api.mjs');
      window.__sourceRelease?.();
      if (window.__sourceApi) Object.assign(api, window.__sourceApi);
      if (s.state.hosts['startup-window']) { await s.actions.hosts.select('fake'); await s.actions.hosts.remove('startup-window'); }
      await s.actions.judgments.dispatch('fake:flux-basic.png', { type: 'set', patch: { bookmark: null, notes: null } });
      s.actions.anchors.remove('source-refresh-anchor.png');
      s.actions.ui.setFilter(''); s.actions.bulk.clear();
      await s.actions.hosts.patch('fake', { pinned: false, autoRefresh: false });
      await fetch('/api/prefetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: false, enabled: true }) });
    })()`);
  }

  try {
    await control({ reset: true, publish: [{ name: 'scoped/seed.png', width: 96, height: 80 }] });
    await page.evaluate(`(async () => { const s = ${KZ}; s.actions.ui.setFilter('');
      await s.actions.hosts.select('fake'); await s.actions.ui.refresh(); s.actions.folders.select('scoped');
      await s.actions.hosts.patch('fake', { autoRefresh: true }); await s.actions.hosts.pollActivity('fake'); })()`);
    await page.poll(`document.querySelector('.card.current[data-name="scoped/seed.png"] img')?.naturalWidth === 96`, 20000);
    await page.evaluate(`(async () => {
      const s = ${KZ}, { api } = await import('/js/api.mjs');
      window.__nestedApi = { inventory: api.inventory, want: api.want };
      window.__nestedUnknown = false; window.__nestedWanted = false;
      window.__nestedResponses = [];
      api.inventory = async (id) => {
        const inventory = await window.__nestedApi.inventory(id);
        const row = inventory.entries.find(e => e.name === 'scoped/deep/completed.png');
        window.__nestedResponses.push({ id, width: row?.width, height: row?.height, present: !!row });
        if (row && !row.width) window.__nestedUnknown = true;
        return inventory;
      };
      api.want = async (id, files) => {
        if (id === 'fake' && files.includes('scoped/deep/completed.png')) window.__nestedWanted = true;
        return window.__nestedApi.want(id, files);
      };
      await fetch('/api/prefetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: true }) });
      // Drain any refresh that started before installing the observer. Its
      // awaiting original API function cannot be intercepted retroactively.
      await s.actions.ui.refresh();
    })()`);
    console.log('NESTED PRE-PUBLICATION', JSON.stringify(await page.evaluate(`(async () => ({
      prefetch: await (await fetch('/api/prefetch')).json(),
      entry: await (await fetch('/api/collections/fake/entries/scoped%2Fdeep%2Fcompleted.png')).json()
    }))()`)));
    await control({ finish: [
      { id: 'nested-auto-complete', output: 'scoped/deep/completed.png', width: 87, height: 73, color: [20, 120, 200, 255] },
      { id: 'nested-auto-sibling', output: 'scoped-other/sibling.png', width: 91, height: 77 },
    ] });
    await page.poll(`document.querySelector('.card[data-name="scoped/deep/completed.png"] img')?.naturalWidth === 87`, 25000);
    check('nested completion retains the prior current instead of stealing focus', await page.evaluate(`(async () => ${KZ}.state.current()?.image === 'scoped/seed.png')()`));
    await page.evaluate(`(async () => ${KZ}.actions.feed.scrollTop())()`);
    await page.poll(`(async () => {
      const s = ${KZ}, image = document.querySelector('.card[data-name="scoped/deep/completed.png"] img');
      if (!image?.naturalWidth || s.state.feedActivity() !== 'settled' || s.state.feedScrollEl().scrollTop > 1) return false;
      const r = image.getBoundingClientRect(), feed = s.state.feedScrollEl().getBoundingClientRect();
      return r.width > 0 && r.top < feed.bottom && r.bottom > feed.top;
    })()`, 20000);
    const nested = await page.evaluate(`(async () => {
      const s = ${KZ}, image = document.querySelector('.card[data-name="scoped/deep/completed.png"] img'), r = image.getBoundingClientRect();
      return { folder: s.state.selectedFolder(), current: s.state.current(), decoded: image.naturalHeight,
        visible: r.width > 0 && r.bottom > 0 && r.top < innerHeight, unknown: window.__nestedUnknown, wanted: window.__nestedWanted,
        responses: window.__nestedResponses,
        siblingListed: s.state.images.some(e => e.filename === 'scoped-other/sibling.png'),
        siblingExcluded: !s.state.view().some(i => s.state.images[i].filename.startsWith('scoped-other/')) };
    })()`);
    check('external completion auto-refreshes the selected subtree through actual nested bytes/dimensions', nested.folder === 'scoped' && nested.decoded === 73 && nested.visible && nested.unknown && nested.wanted, JSON.stringify(nested));
    check('sibling completion stays in full inventory but outside the selected subtree', nested.siblingListed && nested.siblingExcluded, JSON.stringify(nested));
    await capture(page, 'output-folders-auto-nested-1400');
  } catch (error) { check('nested auto-refresh consumer case', false, error.message); }
  finally {
    await control({ reset: true });
    await page.evaluate(`(async () => { const s = ${KZ}, { api } = await import('/js/api.mjs');
      if (window.__nestedApi) Object.assign(api, window.__nestedApi);
      s.actions.ui.setFilter(''); s.actions.folders.select(''); await s.actions.hosts.patch('fake', { autoRefresh: false });
      await fetch('/api/prefetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: false }) });
      await s.actions.ui.refresh(); })()`);
  }

  // Chronology is exercised through actual fake source dates, never a sorted
  // API replacement. The unchanged-byte touch must reorder retained editors.
  try {
    const files = [
      { name: 'chronology-root-today.png', mtime: 2100000004 },
      { name: 'chronology/nested-yesterday.png', mtime: 2100000003 },
      { name: 'chronology-root-last-week.png', mtime: 2100000002 },
      { name: 'chronology/deep/nested-older.png', mtime: 2100000001 },
      { name: 'chronology-tail.png', mtime: 2100000000 },
    ].map(f => ({ ...f, width: 512, height: 512 }));
    await control({ reset: true, publish: [...files].reverse() });
    await page.goto(ENGINE + '/?filter=chronology#fake');
    const scopedNames = `(async () => { const s = ${KZ}; return s.state.view().map(i => s.state.images[i].filename); })()`;
    const expected = files.map(f => f.name);
    await page.poll(`(async () => JSON.stringify(await ${scopedNames}) === ${JSON.stringify(JSON.stringify(expected))})()`, 20000);
    await page.poll(`document.querySelector('.card[data-name="${expected[0]}"] img')?.naturalWidth === 512`, 20000);
    const parity = await page.evaluate(`(async () => {
      const s = ${KZ}, r = await (await fetch('/api/collections/fake/entries?inventory=1')).json();
      const entries = r.entries.filter(e => e.name.includes('chronology'));
      return r.chronology.complete && entries.every((e, i) => e.name === ${JSON.stringify(expected)}[i] &&
        e.modified.atMs === ${JSON.stringify(files.map(f => f.mtime * 1000))}[i] &&
        JSON.stringify(e.modified) === JSON.stringify(s.state.images.find(im => im.filename === e.name).modified));
    })()`);
    check('unified chronology: actual HTTP dates reach API/store and decoded root-before-nested-before-root feed', parity);
    const anchor = expected[2], selector = `.card[data-name="${anchor}"]`;
    await page.evaluate(`(async () => {
      const s = ${KZ}; s.actions.current.set('fake', ${JSON.stringify(anchor)});
      s.actions.feed.restoreToIndex(s.state.currentEntry().index);
      s.actions.selected.set('fake:' + ${JSON.stringify(anchor)}, true);
      const { api } = await import('/js/api.mjs');
      window.__chronologyWriter = api.setJudgment;
      let release; const gate = new Promise(r => release = r); window.__chronologyRelease = release;
      api.setJudgment = async (...args) => { await gate; return window.__chronologyWriter(...args); };
    })()`);
    await page.poll(`document.querySelector('${selector} img')?.naturalWidth === 512`, 20000);
    await page.clickAt(selector + ' textarea.pos');
    await page.send('Input.insertText', { text: 'pending chronology draft' });
    await page.poll(`(async () => ${KZ}.state.drafts['fake:${anchor}:pos'] === 'pending chronology draft')()`);
    const zoomPoint = await page.evaluate(`(() => {
      const r = document.querySelector('${selector} img').getBoundingClientRect(),
        f = document.getElementById('candidatesCol').getBoundingClientRect();
      return { x: (r.left + r.right) / 2, y: (Math.max(r.top, f.top) + Math.min(r.bottom, f.bottom)) / 2 };
    })()`);
    await page.mouse('mouseWheel', zoomPoint.x, zoomPoint.y, { modifiers: 2, deltaY: -100 });
    await page.poll(`(async () => ${KZ}.state.views['fake:${anchor}']?.s > 1)()`);
    const snapshot = `(async () => { const s = ${KZ}, card = document.querySelector('${selector}'); return {
      current: s.state.current(), trail: s.state.currentStack(), url: location.href,
      draft: s.state.drafts['fake:${anchor}:pos'], view: JSON.stringify(s.state.views['fake:${anchor}']),
      selected: s.state.selected['fake:${anchor}'], top: card.getBoundingClientRect().top,
      height: card.getBoundingClientRect().height, scrollTop: s.state.feedScrollEl().scrollTop,
      scrollMax: s.state.feedScrollEl().scrollHeight - s.state.feedScrollEl().clientHeight,
      editorText: card.querySelector('textarea.pos').value }; })()`;
    await page.evaluate(`window.__chronologyCard = document.querySelector('${selector}'); window.__chronologyEditor = window.__chronologyCard.querySelector('textarea.pos')`);
    const before = await page.evaluate(snapshot);
    await capture(page, 'chronology-timestamp-reorder-before');
    await control({ publish: [{ ...files[3], mtime: 2100000005 }] });
    await page.evaluate(`(async () => ${KZ}.actions.ui.refresh())()`);
    const reorderedNames = [expected[3], ...expected.slice(0, 3), expected[4]];
    await page.poll(`(async () => JSON.stringify(await ${scopedNames}) === ${JSON.stringify(JSON.stringify(reorderedNames))})()`);
    const after = await page.evaluate(snapshot);
    const mounted = await page.evaluate(`window.__chronologyCard === document.querySelector('${selector}') && window.__chronologyEditor === document.querySelector('${selector} textarea.pos')`);
    check('unified chronology: timestamp-only same-count reorder preserves mounted editor, draft, selection, zoom, current/trail/URL and viewport',
      mounted && JSON.parse(before.view).s > 1 && Math.abs(before.top - after.top) <= 1 && before.height === after.height &&
      ['current','trail','url','draft','view','selected','editorText'].every(k => JSON.stringify(before[k]) === JSON.stringify(after[k])), JSON.stringify({before,after,mounted}));
    const audit = await page.evaluate(AUDIT);
    check('unified chronology: exact card heights after timestamp-only reorder', audit.maxDelta === 0 && audit.nullSize === 0, JSON.stringify(audit));
    await capture(page, 'chronology-timestamp-reorder-after');
    await page.evaluate(`(async () => { const s=${KZ}; await s.actions.hosts.patch('fake', { autoRefresh:true }); await s.actions.hosts.pollActivity('fake'); })()`);
    await control({ finish: [{ id:'chronology-root-finish', output:'chronology/deep/auto-root.png', width:512, height:512, mtime:2100000006 }] });
    await page.poll(`(async () => ${KZ}.state.images[0]?.filename === 'chronology/deep/auto-root.png')()`, 20000);
    await page.evaluate(`(async () => ${KZ}.actions.feed.scrollTop())()`);
    await page.poll(`document.querySelector('.card[data-name="chronology/deep/auto-root.png"] img')?.naturalWidth === 512`, 20000);
    check('unified chronology: automatic root feed interleaves and decodes newest descendant above roots', true);
    await page.evaluate(`(async () => { const s=${KZ}; s.actions.folders.select('chronology'); })()`);
    await page.poll(`(async () => JSON.stringify(await ${scopedNames}) === ${JSON.stringify(JSON.stringify(['chronology/deep/auto-root.png', expected[3], expected[1]]))})()`);
    check('unified chronology: selected subtree is the server chronology subsequence', true);
    await control({ publish: [{ ...files[1], mtime:2100000007 }] });
    await page.evaluate(`(async () => ${KZ}.actions.ui.refresh())()`);
    await page.poll(`(async () => (await ${scopedNames})[0] === ${JSON.stringify(expected[1])})()`);
    await page.evaluate(`(async () => ${KZ}.actions.feed.scrollTop())()`);
    await page.poll(`document.querySelector('.card[data-name="${expected[1]}"] img')?.naturalWidth === 512`, 20000);
    check('unified chronology: manual subtree refresh observes unchanged-byte touch and decoded head', true);
    await control({ finish: [{ id:'chronology-subtree-finish', output:'chronology/deep/auto-subtree.png', width:512, height:512, mtime:2100000008 }] });
    await page.poll(`(async () => (await ${scopedNames})[0] === 'chronology/deep/auto-subtree.png')()`, 20000);
    await page.evaluate(`(async () => ${KZ}.actions.feed.scrollTop())()`);
    await page.poll(`document.querySelector('.card[data-name="chronology/deep/auto-subtree.png"] img')?.naturalWidth === 512`, 20000);
    check('unified chronology: automatic subtree refresh decodes its true chronological head', true);
    await capture(page, 'chronology-auto-subtree');
    await page.clickAt('.card[data-name="chronology/deep/auto-subtree.png"] textarea.pos');
    await page.send('Input.insertText', { text: 'chronological upper note' });
    await page.poll(`(async () => ${KZ}.state.drafts['fake:chronology/deep/auto-subtree.png:pos'] === 'chronological upper note')()`);
    await page.evaluate(`(async () => { const s=${KZ}; s.actions.current.set('fake',${JSON.stringify(expected[1])}); s.actions.feed.restoreToIndex(s.state.currentEntry().index); })()`);
    const below = `.card[data-name="${expected[1]}"]`;
    await page.poll(`!!document.querySelector('${below} textarea.pos')`);
    await page.clickAt(below + ' .boxcol:last-child .btnrow button:last-child');
    await page.poll(`document.querySelector('${below} textarea.pos').value === 'chronological upper note'`);
    check('unified chronology: scoped note-copy above uses the newer chronological neighbor draft', true);
    const rail = await page.evaluate(`(async () => { const s=${KZ}; const names=s.state.view().map(i=>s.state.images[i].id);
      const ticks=[...document.querySelectorAll('#feedRail .fr-tick')].map(e=>e.dataset.entryId);
      return JSON.stringify(ticks)===JSON.stringify(names); })()`);
    check('unified chronology: scoped rail tick identities retain the chronological sequence', rail);
  } catch (error) { check('unified chronology actual consumer', false, error.message); }
  finally {
    await page.evaluate(`(async () => { const s=${KZ}, {api}=await import('/js/api.mjs');
      window.__chronologyRelease?.(); if(window.__chronologyWriter) api.setJudgment=window.__chronologyWriter;
      s.actions.ui.setFilter(''); s.actions.folders.select(''); s.actions.bulk.clear();
      await s.actions.hosts.patch('fake',{autoRefresh:false}); })()`);
    await control({reset:true});
  }

  check("no uncaught page errors", pageErrors.length === 0, pageErrors[0] ?? "");

  await page.close();
  console.log(failures ? `\n${failures} FAILURES` : "\nFEED E2E: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("E2E driver error:", e); process.exit(1); });
