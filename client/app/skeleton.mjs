// client/app/skeleton.mjs — the not-yet-componentized surfaces, verbatim.
//
// Migration scaffolding for the single-growing-<App>-tree approach: each
// constant is the exact inner HTML of a surface that legacy code still owns
// (fills via getElementById). <App> renders them through a constant
// dangerouslySetInnerHTML so Preact diffs them vdom-to-vdom as "unchanged"
// and never touches what legacy writes inside. Each constant is deleted the
// phase its surface becomes a real component.

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
