// client/app/skeleton.mjs — the not-yet-componentized surfaces, verbatim.
//
// Migration scaffolding for the single-growing-<App>-tree approach: each
// constant is the exact inner HTML of a surface that legacy code still owns
// (fills via getElementById). <App> renders them through a constant
// dangerouslySetInnerHTML so Preact diffs them vdom-to-vdom as "unchanged"
// and never touches what legacy writes inside. Each constant is deleted the
// phase its surface becomes a real component.

export const MAIN_INNER = `
  <section id="candidatesCol"><div id="grid"></div></section>
  <div id="divider" title="drag to resize the split"></div>
  <aside id="workspace">
    <div id="wsDetails" class="ws-space">
      <div id="wsDetailsBody" class="metabody"></div>
    </div>
    <div id="wsAnchors" class="ws-space" hidden>
      <div id="anchorList"></div>
      <div id="dropzone">Drop images here<br>(or click to browse)</div>
      <input type="file" id="fileInput" accept="image/*" multiple hidden>
    </div>
  </aside>
  <nav id="wsBar">
    <button id="wsBtnDetails" data-space="details" title="image details"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/>
  <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
  <path d="M12 9h.01" />
  <path d="M11 12h1v4h1" /></svg></button>
    <button id="wsBtnAnchors" data-space="anchors" title="anchors"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3" />
  <line x1="12" y1="22" x2="12" y2="8" />
  <path d="M5 12H2a10 10 0 0 0 20 0h-3" /></svg></button>
  </nav>
`;

export const FIELDS_INNER = `
  <div id="fieldsPanel">
    <button id="fieldsClose" title="close (Esc)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6l-12 12" /><path d="M6 6l12 12" /></svg></button>
    <div id="fieldsTitle">Metadata fields</div>
    <div id="fieldsSub"><b>under image</b> — the card's metadata panel ·
      <b>strip</b> — a semi-transparent strip over the image bottom
      (cards) / screen bottom (lightbox)</div>
    <div id="fieldsTable"></div>
  </div>
`;

export const INFO_INNER = `
  <div id="infoPanel">
    <button id="infoClose" title="close (Esc)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6l-12 12" /><path d="M6 6l12 12" /></svg></button>
    <div id="infoTitle"></div>
    <div id="infoBody" class="metabody"></div>
  </div>
`;

export const KEYS_INNER = `
  <div id="keysPanelInner">
    <div id="keysPanelHead">
      <h2>Actions & keys</h2>
      <input id="keysSearch" type="search" placeholder="filter actions…" spellcheck="false">
      <button id="keysReset" title="restore all default bindings">reset all</button>
    </div>
    <div id="keysList"></div>
    <div id="keysFoot">click a binding to change it · right-click resets one · Esc cancels capture</div>
  </div>
`;

export const LIGHTBOX_INNER = `
  <img id="lbCandidate" alt="">
  <img id="lbAnchor" alt="">
  <div id="lbSplitLine" hidden></div>
  <div id="lbGuides"></div>
  <div id="lbRoi"></div>
  <div id="lbChrome">
    <input id="lbBlend" type="range" min="0" max="1" step="0.01" value="0.5"
           title="blend opacity (candidate over anchor)" hidden>
  </div>
  <button id="lbKeysBtn" title="actions & keys (?)">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6">
      <rect x="2" y="6" width="20" height="12" rx="2"/>
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>
    </svg>
  </button>
`;

export const DIFF_INNER = `
  <button id="diffClose" title="close (Esc)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/>
  <path d="M18 6l-12 12" />
  <path d="M6 6l12 12" /></svg></button>
  <div id="diffBar">
    <span id="diffMode" title="composition mode (c)"></span>
    <input id="diffBlend" type="range" min="0" max="1" step="0.01" value="0.5"
           title="top-side opacity" hidden>
    <span id="diffAlign" title="zoom/pan linkage (a)"></span>
    <button id="diffSave" title="download both images"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/>
  <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" />
  <path d="M7 11l5 5l5 -5" />
  <path d="M12 4l0 12" /></svg> save both</button>
    <span id="diffHint">←→ blink · ↑↓ left · shift+↑↓ right · c mode · a link · x swap · wheel zoom · drag pan · dblclick reset · esc close</span>
  </div>
  <div id="diffStage" data-mode="flicker">
    <!-- right first in DOM: in overlay modes left paints on top (blend/
         difference need one shared stacking context, so no z-index on
         the figures); side mode reorders left-first via \`order\` -->
    <figure id="diffFR" class="diffside">
      <img id="diffR" alt="">
      <figcaption id="diffLblR" class="difflabel"></figcaption>
    </figure>
    <figure id="diffFL" class="diffside">
      <img id="diffL" alt="">
      <figcaption id="diffLblL" class="difflabel"></figcaption>
    </figure>
    <div id="diffSplitLine" hidden></div>
  </div>
`;
