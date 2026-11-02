import { assertEquals } from "jsr:@std/assert";
import { workbenchViews, defaultWorkbenchView } from "../client-solid/features/diff/views.mjs";
import { hitLayer } from "../client-solid/features/diff/hit.mjs";
import { makeAppStore } from "../client-solid/store/app-store.js";

Deno.test("workbench views: image IDs/keys unchanged; video full/split/overlay/slider; audio only full", () => {
  const contract = kind => workbenchViews(kind).map(({mode,key,label}) => [mode,key,label]);
  assertEquals(contract("image"), [["full","f","Full"],["two-up","1","Two-Up"],["one-up","2","One-Up"],["split","3","Split"],["difference","4","Difference"]]);
  assertEquals(contract("video"), [["full","f","Full"],["two-up","1","Split"],["one-up","2","Overlay"],["split","3","Slider"]]);
  assertEquals(contract("audio"), [["full","f","Full"]]);
  assertEquals(["image","video","audio"].map(defaultWorkbenchView), ["full","full","full"]);
});

Deno.test("workbench admission shares the kind catalogue; full gestures always target A", () => {
  const store = makeAppStore({subscribeSources:null});
  try {
    const current = file => store.actions.current.assign({remote:"fake",image:file},{persist:false});
    current("movie.webm");
    assertEquals(store.state.diffViews().map(v=>v.mode),["full","two-up","one-up","split"]);
    assertEquals(store.handles.invoke("workbench.mode",{mode:"difference"}),false);
    store.handles.invoke("workbench.mode",{mode:"full"});
    assertEquals(store.state.diff.mode,"full");
    assertEquals(store.handles.invoke("workbench.mode",{mode:"two-up"}),false,"video comparisons need a pair");
    current("sound.flac");
    for (const mode of ["two-up","one-up","split","difference"]) assertEquals(store.handles.invoke("workbench.mode",{mode}),false);
    current("still.png");
    store.handles.invoke("workbench.mode",{mode:"full"});
    assertEquals(store.state.diff.mode,"full","images admit the same Full view");
    store.handles.invoke("workbench.mode",{mode:"split"});
    assertEquals(store.state.diff.mode,"split","image programmatic setup stays permissive");
    assertEquals(hitLayer({mode:"full",col:"right",x:900,stageRect:{left:0,width:1400}}),"a");
  } finally {store.dispose();}
});

Deno.test("viewer crop ports have a distinct session owner and cannot overwrite persisted card crops", () => {
  const store = makeAppStore({ subscribeSources: null });
  try {
    const card = { s: 3, txf: .1, tyf: .5 };
    store.actions.views.set("fake:still.png", card, { persist: false });
    store.actions.diff.views.set("fake:still.png", { s: 2, txf: -.2, tyf: .3 });
    assertEquals(store.state.views["fake:still.png"], card);
    assertEquals(store.state.diff.views["fake:still.png"].s, 2);
    store.actions.diff.views.set("fake:still.png", null);
    assertEquals(store.actions.diff.views.get("fake:still.png"), null);
    assertEquals(store.state.views["fake:still.png"], card);
  } finally { store.dispose(); }
});
