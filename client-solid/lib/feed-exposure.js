// Native observation only. Source identity and acknowledgment belong to Store.
export function intersection(a, b) {
  const left=Math.max(a.left,b.left), top=Math.max(a.top,b.top), right=Math.min(a.right,b.right), bottom=Math.min(a.bottom,b.bottom);
  return right>left && bottom>top ? {left,top,right,bottom} : null;
}
export function uncovered(rect, covers) {
  let pieces=[rect];
  for(const cover of covers) pieces=pieces.flatMap(piece=>{
    const overlap=intersection(piece,cover);if(!overlap)return [piece];
    const out=[];
    if(piece.top<overlap.top)out.push({...piece,bottom:overlap.top});
    if(overlap.bottom<piece.bottom)out.push({...piece,top:overlap.bottom});
    if(piece.left<overlap.left)out.push({left:piece.left,right:overlap.left,top:overlap.top,bottom:overlap.bottom});
    if(overlap.right<piece.right)out.push({left:overlap.right,right:piece.right,top:overlap.top,bottom:overlap.bottom});
    return out;
  });
  return pieces.length>0;
}
export function makeFeedExposure() {
  const surfaces = new Set(), occluders = new Set();
  let lifetime = null, root = null, stopped = false;
  const owns = life => !stopped && lifetime === life && life.active;
  const belongs = (life, element) => element?.ownerDocument === life.target.document;
  function rect(life, element) {
    if (!belongs(life, element) || !element.isConnected) return null;
    const style = life.target.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 ? bounds : null;
  }
  function sample(life) {
    const page = life.target;
    if (!owns(life) || life.suspended || page.document.visibilityState !== 'visible') return;
    const bounds = rect(life, root?.element);
    if (!bounds) return;
    const v = page.visualViewport;
    const viewport = { left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0,
      right: (v?.offsetLeft ?? 0) + (v?.width ?? page.innerWidth), bottom: (v?.offsetTop ?? 0) + (v?.height ?? page.innerHeight) };
    const feed = intersection(bounds, viewport);
    if (!feed) return;
    const covers = [...occluders].flatMap(owner => { const value = rect(life, owner.element); return value ? [value] : []; });
    for (const owner of [...surfaces]) {
      if (!owns(life) || !surfaces.has(owner) || !owner.valid() || !owner.ready()) continue;
      const surface = rect(life, owner.element), clip = rect(life, owner.clip);
      const clipped = surface && clip && intersection(surface, clip), shown = clipped && intersection(clipped, feed);
      if (shown && uncovered(shown, covers)) owner.expose();
    }
  }
  function invalidate() {
    const life = lifetime;
    if (!life || !owns(life) || life.suspended || life.frame !== null) return;
    const generation = life.observationGeneration;
    life.frame = life.target.requestAnimationFrame(() => {
      if (!owns(life) || generation !== life.observationGeneration) return;
      life.frame = null; sample(life);
    });
  }
  function reobserve() {
    const life = lifetime;
    if (!life || !owns(life) || life.suspended) return;
    life.resize?.disconnect(); life.intersection?.disconnect();
    const elements = new Set([root?.element]);
    for (const owner of surfaces) { elements.add(owner.element); elements.add(owner.clip); }
    for (const owner of occluders) elements.add(owner.element);
    for (const element of elements) if (belongs(life, element)) {
      life.resize?.observe(element); life.intersection?.observe(element);
    }
  }
  function register(set, input) {
    if (stopped) return () => {};
    const owner = { ...input }; set.add(owner); reobserve(); invalidate();
    return () => { if (set.delete(owner)) { reobserve(); invalidate(); } };
  }
  return {
    invalidate,
    surface: input => register(surfaces, input),
    occluder: element => register(occluders, { element }),
    root(element) {
      const registration = { element }; root = registration; reobserve(); invalidate();
      return () => { if (root === registration) { root = null; reobserve(); invalidate(); } };
    },
    page(target) {
      lifetime?.retire();
      if (stopped || !target.document || typeof target.requestAnimationFrame !== 'function') return () => {};
      const life = { target, active: true, suspended: false, frame: null, observationGeneration: 0 };
      lifetime = life;
      let events = [];
      const disconnect = () => {
        life.observationGeneration++; life.resize?.disconnect(); life.intersection?.disconnect();
        for (const [node, event, fn] of events) node?.removeEventListener(event, fn, event === 'scroll');
        events = [];
        if (life.frame !== null) target.cancelAnimationFrame(life.frame);
        life.frame = null;
      };
      const connect = () => {
        const generation = ++life.observationGeneration;
        const changed = () => { if (owns(life) && !life.suspended && generation === life.observationGeneration) invalidate(); };
        life.resize = target.ResizeObserver ? new target.ResizeObserver(changed) : null;
        life.intersection = target.IntersectionObserver ? new target.IntersectionObserver(changed) : null;
        events = [[target, 'resize', changed], [target, 'scroll', changed], [target.document, 'visibilitychange', changed],
          [target.visualViewport, 'resize', changed], [target.visualViewport, 'scroll', changed]];
        for (const [node, event, fn] of events) node?.addEventListener(event, fn, { passive: true, capture: event === 'scroll' });
        reobserve(); invalidate();
      };
      const hide = () => { if (owns(life)) { life.suspended = true; disconnect(); } };
      const show = () => { if (owns(life) && life.suspended) { life.suspended = false; connect(); } };
      target.addEventListener('pagehide', hide); target.addEventListener('pageshow', show);
      life.retire = () => {
        if (!life.active) return;
        life.active = false; disconnect();
        target.removeEventListener('pagehide', hide); target.removeEventListener('pageshow', show);
        if (lifetime === life) lifetime = null;
      };
      connect(); return life.retire;
    },
    dispose() { stopped = true; lifetime?.retire(); surfaces.clear(); occluders.clear(); root = null; },
  };
}
