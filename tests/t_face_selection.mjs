import { assert, assertEquals } from "jsr:@std/assert";
import { makeFaceModel } from "../client-solid/features/face-alignment/model.mjs";
import { face, resource, result, turn } from "./helpers/face-fixtures.mjs";

Deno.test("faces: every face selected; explicit per-record anchor does not remove peers", async () => {
  const a = resource(), b = resource("b.png");
  const model = makeFaceModel({ detect: async () => result([face(100, 100, 40, .01), face(300, 200, 20, 200)]) });
  try {
    model.update("session/config", [a, b]); await turn(); await turn();
    for (const r of [a, b]) {
      const initial = model.record(r);
      assertEquals(initial.faces.map(f => f.selected), [true, true]);
      assertEquals(initial.anchor, null, "score never chooses a multi-face anchor");
      assertEquals(model.state(r).phase, "choice");
      assert(model.choose(r, initial.id, initial.faces[0].id));
      assertEquals(model.record(r).faces, initial.faces);
      assert(model.choose(r, initial.id, initial.faces[1].id));
      assertEquals(model.record(r).anchor, initial.faces[1].id);
      assertEquals(initial.anchor, null, "published record is immutable");
    }
    model.update("session/config", []);
    model.update("session/config", [a, b]);
    assert(model.record(a).anchor, "composition transition retains choice");
    const retired = model.record(a);
    model.update("session/new-config", [a]); await turn();
    assert(!model.choose(a, retired.id, retired.faces[0].id));
  } finally { model.dispose(); }
});

Deno.test("faces: errors, no-face, invalid eyes and sole anchors remain distinct", async () => {
  let response = () => { throw new Error("service offline"); };
  const r = resource(), model = makeFaceModel({ detect: () => response() });
  try {
    model.update("1", [r]); await turn();
    assertEquals(model.state(r).phase, "error"); assertEquals(model.record(r), null);
    response = () => result([]); model.retry(); await turn();
    assertEquals(model.state(r).phase, "empty");
    response = () => result([{ ...face(), kps: [] }]); model.update("2", [r]); await turn();
    assertEquals(model.state(r).phase, "unusable");
    response = () => result(); model.update("3", [r]); await turn();
    assertEquals(model.state(r).phase, "ready");
  } finally { model.dispose(); }
});

Deno.test("faces: canceled, source-retired and disposed completions cannot publish", async () => {
  const jobs = [], a = resource(), b = resource("a.png", "input:fake");
  const model = makeFaceModel({ detect: (r, signal) => new Promise(resolve => jobs.push({ r, signal, resolve })) });
  model.update("1", [a]); await turn();
  model.update("1", [b]); await turn();
  assert(jobs[0].signal.aborted);
  jobs[0].resolve(result()); await turn();
  assertEquals(model.record(a), null);
  jobs[1].resolve(result([], "b".repeat(64))); await turn();
  assertEquals(model.record(b).faces, []);
  model.update("2", [a]); await turn(); model.dispose();
  assert(jobs[2].signal.aborted); jobs[2].resolve(result()); await turn();
  assertEquals(model.record(a), null);
});

Deno.test("faces: bounded cache pins the accepted old frame while its replacement is displayed", async () => {
  const a = resource(), b = resource("b.png"), c = resource("c.png");
  const model = makeFaceModel({ limit: 1, detect: async () => result() });
  try {
    model.update("session", [a]); await turn();
    const old = model.record(a);
    model.update("session", [b], [a]); await turn();
    model.update("session", [c], [a]); await turn();
    assertEquals(model.record(a), old, "accepted feedback survives replacement cache pressure");
    assertEquals(model.record(b), null);
    model.update("session", [c]);
    assertEquals(model.record(a), null, "released display no longer pins its result");
  } finally { model.dispose(); }
});

Deno.test("faces: failures share the cache budget and reads preserve actual recency", async () => {
  const a = resource(), b = resource("b.png"), c = resource("c.png");
  const failed = makeFaceModel({ limit: 1, detect: () => { throw new Error("offline"); } });
  try {
    failed.update("session", [a]); await turn();
    assertEquals(failed.state(a).phase, "error");
    failed.update("session", [b]); await turn();
    assertEquals(failed.state(b).phase, "error");
    assertEquals(failed.state(a).phase, "pending", "unshown failures cannot grow outside the result budget");
  } finally { failed.dispose(); }
  const model = makeFaceModel({ limit: 2, detect: async () => result() });
  try {
    model.update("session", [a]); await turn();
    model.update("session", [b]); await turn();
    const recent = model.record(a);
    model.update("session", [c]); await turn();
    assertEquals(model.record(a), recent, "recently used record survives");
    assertEquals(model.record(b), null, "least recently used unshown record retires");
  } finally { model.dispose(); }
});

Deno.test("faces: first-hash enrichment preserves chosen content and exact retained records without merging addresses", async () => {
  const a = resource(), h1 = "a".repeat(64), h2 = "b".repeat(64);
  let calls = 0;
  const model = makeFaceModel({ limit: 2, detect: async r => { calls++; return result([face(), face(300, 200)], r.hash ?? h1); } });
  try {
    model.update("session", [a]); await turn();
    const initial = model.record(a);
    assert(model.choose(a, initial.id, initial.faces[1].id));
    const chosen = model.record(a), enriched = { ...a, hash: h1 };
    model.update("session", [enriched], [{ resource: a, recordId: chosen.id }]); await turn();
    assertEquals(model.record(enriched), chosen, "same content keeps the actual record and anchor");
    assertEquals(calls, 1, "metadata enrichment is not another inference");
    const changed = { ...a, hash: h2 };
    model.update("session", [changed], [{ resource: a, recordId: chosen.id }]); await turn();
    const replacement = model.record(changed);
    assert(replacement.id !== chosen.id); assertEquals(replacement.anchor, null);
    assertEquals(model.record(a, chosen.id), chosen, "old unhashed accepted descriptor remains exact, never newest-by-address");
    assert(!model.choose(a, chosen.id, chosen.faces[0].id), "retained old display cannot choose into a replacement request");
    const input = { ...resource(a.name, "input:fake"), hash: h2 };
    model.update("session", [changed, input], [{ resource: a, recordId: chosen.id }]); await turn();
    const peer = model.record(input);
    assert(peer.id !== replacement.id, "same bytes at different resource kinds are distinct choices");
    assert(model.choose(input, peer.id, peer.faces[0].id));
    assertEquals(model.record(changed).anchor, null);
    assertEquals(model.record(input, chosen.id), null, "foreign record IDs never alias by hash");
    model.update("session", [changed, input]);
    assertEquals(model.record(a, chosen.id), null, "released old record leaves the one bounded budget");
  } finally { model.dispose(); }
});

Deno.test("faces: in-flight first-hash enrichment does not abort or infer twice", async () => {
  const jobs = [], a = resource(), hash = "a".repeat(64);
  const model = makeFaceModel({ detect: (r, signal) => new Promise(resolve => jobs.push({ r, signal, resolve })) });
  try {
    model.update("session", [a]); await turn();
    const enriched = { ...a, hash };
    model.update("session", [enriched]); await turn();
    assertEquals(jobs.length, 1); assert(!jobs[0].signal.aborted);
    jobs[0].resolve(result([face(), face(300, 200)], hash)); await turn();
    const record = model.record(enriched);
    assert(record); assertEquals(model.record(a, record.id), record);
    assertEquals(jobs.length, 1);
  } finally { model.dispose(); }
});

Deno.test("faces: unusable current choices explain the result without losing an anchor or leaking stale feedback", async () => {
  const a = resource(), model = makeFaceModel({ detect: async () => result([face(), { ...face(300, 200), kps: [] }]) });
  try {
    model.update("session", [a]); await turn();
    const record = model.record(a);
    assert(model.choose(a, record.id, record.faces[0].id));
    assert(!model.choose(a, record.id, record.faces[1].id));
    assertEquals(model.state(a).phase, "choice-error");
    assert(model.state(a).message.includes("eye landmarks"));
    assertEquals(model.record(a).anchor, record.faces[0].id);
    assertEquals(model.record(a).faces.map(f => f.selected), [true, true]);
    model.update("new-session", [a]); await turn();
    assert(!model.choose(a, record.id, record.faces[1].id));
    assertEquals(model.state(a).phase, "choice", "stale commands do not publish a reason into the new image");
  } finally { model.dispose(); }
});

Deno.test("faces: unknown metadata and retry cannot fall back to an older pinned content version", async () => {
  const a = resource(), h1 = "a".repeat(64), h2 = "b".repeat(64), calls = [];
  const model = makeFaceModel({ detect: async r => {
    calls.push(r.hash);
    if (calls.length === 2) throw new Error("temporary inference failure");
    return result([face(), face(300, 200)], r.hash ?? h1);
  } });
  try {
    model.update("session", [a]); await turn(); const old = model.record(a);
    const pins = [{ resource: a, recordId: old.id }];
    model.update("session", [{ ...a, hash: h2 }], pins); await turn();
    model.update("session", [a], pins);
    assertEquals(model.state(a).phase, "error");
    model.retry(); await turn();
    assertEquals(calls, [undefined, h2, h2], "retry retains the known current acquisition instead of exposing an old pinned record");
    const current = model.record(a);
    assertEquals(current.image.hash, h2); assertEquals(model.record(a, old.id), old);
    model.update("session", [a], pins, false); model.update("session", [a], pins, true); await turn();
    assertEquals(model.record(a), current); assertEquals(calls.length, 3, "composition suspension retains current content ownership");
  } finally { model.dispose(); }
});

Deno.test("faces: an ambiguous unknown address keeps its explicit failure instead of silently retrying", async () => {
  const a = resource(), h1 = "a".repeat(64), h2 = "b".repeat(64), calls = [], waiting = [];
  const model = makeFaceModel({ detect: r => {
    calls.push(r.hash);
    if (calls.length === 3) return Promise.reject(new Error("unknown acquisition failed"));
    if (calls.length >= 4) return new Promise(resolve => waiting.push(resolve));
    return Promise.resolve(result([face(), face(300, 200)], r.hash));
  } });
  try {
    model.update("session", [{ ...a, hash: h1 }]); await turn();
    model.update("session", [{ ...a, hash: h2 }]); await turn();
    const second = model.record({ ...a, hash: h2 });
    model.update("session", []); model.update("session", [a]); await turn();
    assertEquals(model.state(a).phase, "error", "the unbound acquisition has its own failure identity");
    assertEquals(calls.length, 3, "failure is not an automatic new inference");
    model.retry(); await turn(); waiting.shift()(result([face(), face(300, 200)], h2)); await turn();
    assertEquals(model.record(a), second, "successful identity acquisition reuses the exact known content record");
  } finally { model.dispose(); for (const resolve of waiting) resolve(result([], h2)); await turn(); }
});
