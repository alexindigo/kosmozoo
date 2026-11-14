import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { PexelsServices, makePexelsClient, registerPexels, serviceBase, normalizePhoto, PEXELS_PAGE_SIZE } from "../src/features/variations/pexels.mjs";
import { makePexelsBrowse } from "../client-solid/features/variations/pexels-browse.js";
import { makePexelsServices } from "../client-solid/features/variations/pexels-services.js";
import { editorRig as defaultRig, removeRecordedImages } from "./helpers/variation-editor.mjs";
import { fakePexels, JPEG } from "./helpers/fake-pexels.mjs";

const editorRig = overrides => removeRecordedImages(defaultRig(overrides));
const tempPath = async () => `${await Deno.makeTempDir({ prefix: "pexels-" })}/pexels-services.json`;

Deno.test("pexels: service URL accepts the API root with or without /v1 and refuses credentials", () => {
  assertEquals(serviceBase("https://api.pexels.com/v1/"), "https://api.pexels.com");
  assertEquals(serviceBase("http://pexels.home:8080/api/v1"), "http://pexels.home:8080/api");
  assertEquals(serviceBase(" http://pexels.home/ "), "http://pexels.home");
  for (const bad of ["", "ftp://x", "http://user:pw@x", "http://x/?q=1", "not a url"]) {
    let failed = false;
    try { serviceBase(bad); } catch (error) { failed = true; assertEquals(error.status, 400); }
    assert(failed, bad);
  }
});

Deno.test("pexels: services persist owner-only, list without keys, and keep/clear/replace the key explicitly", async () => {
  const path = await tempPath(), changed = [];
  try {
    const services = new PexelsServices(path, { changed: id => changed.push(id) });
    assertEquals(await services.list(), []);
    const home = await services.create({ name: "Home", url: "http://pexels.home/v1", key: "secret-1" });
    assertEquals(home, { id: home.id, name: "Home", url: "http://pexels.home", hasKey: true });
    await services.create({ name: "Public", url: "https://api.pexels.com" });
    await assertRejects(() => services.create({ name: "home", url: "http://other" }), Error, "already exists");
    assertEquals((await Deno.stat(path)).mode & 0o777, 0o600);
    assertEquals(JSON.stringify(await services.list()).includes("secret"), false);

    assertEquals((await services.update(home.id, { name: "Home photos" })).hasKey, true);
    assertEquals((await services.get(home.id)).key, "secret-1");
    await services.update(home.id, { key: "secret-2" });
    assertEquals((await services.get(home.id)).key, "secret-2");
    assertEquals((await services.update(home.id, { key: null })).hasKey, false);
    await assertRejects(() => services.update(home.id, { key: "" }), Error, "API key");
    assertEquals(changed, [home.id, home.id, home.id]);

    const reopened = new PexelsServices(path);
    assertEquals((await reopened.list()).map(item => [item.name, item.hasKey]), [["Home photos", false], ["Public", false]]);
    await reopened.remove(home.id);
    assertEquals((await reopened.list()).map(item => item.name), ["Public"]);
    await assertRejects(() => reopened.get(home.id), Error, "removed");
  } finally { await Deno.remove(path.replace(/\/[^/]+$/, ""), { recursive: true }); }
});

Deno.test("pexels: an unreadable services file is reported and never overwritten", async () => {
  const path = await tempPath();
  try {
    await Deno.writeTextFile(path, "{ broken");
    const services = new PexelsServices(path);
    await assertRejects(() => services.list(), Error, "unreadable");
    await assertRejects(() => services.create({ name: "A", url: "http://a" }), Error, "unreadable");
    assertEquals(await Deno.readTextFile(path), "{ broken");
  } finally { await Deno.remove(path.replace(/\/[^/]+$/, ""), { recursive: true }); }
});

Deno.test("pexels: photo records keep only usable http sizes", () => {
  const photo = normalizePhoto({ id: 7, alt: "a\nb", photographer: "P", width: 10, height: 0,
    src: { large2x: "/img/7-large2x.jpg", medium: "javascript:alert(1)", tiny: "https://x/7-tiny.jpg" } }, "http://pexels.home/api");
  assertEquals(photo, { id: "7", alt: "a b", photographer: "P", width: 10, height: null,
    src: { large2x: "http://pexels.home/img/7-large2x.jpg", tiny: "https://x/7-tiny.jpg" } });
  assertEquals(normalizePhoto({ id: "../x", src: { large2x: "http://a", medium: "http://a" } }, "http://a"), null);
  assertEquals(normalizePhoto({ id: 1, src: { medium: "http://a" } }, "http://a"), null);
});

Deno.test("pexels: search and curated pages, key only on the service origin, curated absence is not an error", async () => {
  const fake = fakePexels({ key: "secret", curated: true });
  const client = makePexelsClient({ fetch: fake.fetch });
  const service = { id: "s", name: "Home", url: "http://pexels.home", key: "secret" };
  const curated = await client.photos(service);
  assertEquals([curated.mode, curated.curated, curated.page, curated.more, curated.photos.length], ["curated", true, 1, true, PEXELS_PAGE_SIZE]);
  const search = await client.photos(service, { query: " cats ", page: 2 });
  assertEquals([search.mode, search.page, search.more], ["search", 2, false]);
  assert(search.photos.every(photo => photo.alt.includes("cats")));
  assertEquals(fake.requests.at(-1).url, `http://pexels.home/v1/search?query=cats&page=2&per_page=${PEXELS_PAGE_SIZE}`);

  const image = await client.bytes(service, search.photos[0].id, "image");
  assertEquals([image.mime, image.extension, image.bytes.length], ["image/jpeg", "jpg", JPEG.length]);
  const thumbnail = await client.bytes(service, search.photos[0].id, "thumbnail");
  assertEquals(thumbnail.mime, "image/jpeg");
  const imageRequests = fake.requests.filter(request => request.url.includes("/img/"));
  assertEquals(imageRequests.map(request => [new URL(request.url).host, request.authorization]),
    [["cdn.example", null], ["pexels.home", "secret"]]);

  await assertRejects(() => client.photos({ ...service, key: "wrong" }), Error, "rejected the API key");
  const bare = fakePexels({ curated: false }), plain = makePexelsClient({ fetch: bare.fetch });
  assertEquals(await plain.photos({ id: "b", name: "Bare", url: "http://pexels.home" }), { mode: "curated", curated: false, page: 1, more: false, photos: [] });
  assertEquals((await plain.photos({ id: "b", name: "Bare", url: "http://pexels.home" }, { query: "dogs" })).photos.length, 3);
});

Deno.test("pexels: bytes resolve only engine-fetched photos, refuse non-images and drop the key on cross-origin redirects", async () => {
  const fake = fakePexels({ key: "secret", curated: true });
  const client = makePexelsClient({ fetch: fake.fetch });
  const service = { id: "s", name: "Home", url: "http://pexels.home", key: "secret" };
  // Unknown to the listing cache: resolved through /v1/photos/<id>.
  const direct = await client.bytes(service, "5", "image");
  assertEquals(direct.mime, "image/jpeg");
  assert(fake.requests.some(request => request.url === "http://pexels.home/v1/photos/5"));
  await assertRejects(() => client.bytes(service, "../etc", "image"), Error, "Unknown photo");
  await assertRejects(() => client.bytes(service, "999", "image"), Error, "doesn't have this photo");
  await assertRejects(() => client.bytes(service, "13", "image"), Error, "isn't a supported image");
  await client.bytes(service, "21", "image");
  const hops = fake.requests.filter(request => request.url.includes("redirect") || request.url.includes("moved"));
  assertEquals(hops.map(request => [new URL(request.url).host, request.authorization]), [["pexels.home", "secret"], ["cdn.example", null]]);
});

Deno.test("pexels: routes redact keys, validate input and proxy bytes", async () => {
  const path = await tempPath(), routes = new Map(), fake = fakePexels({ key: "secret", curated: true });
  try {
    registerPexels({ paths: { state: path.replace(/\/[^/]+$/, "") }, route: (method, route, handler) => routes.set(`${method} ${route}`, handler) },
      { client: makePexelsClient({ fetch: fake.fetch }) });
    const call = async (method, route, url, params = {}, body) => {
      const response = await routes.get(`${method} ${route}`)(new Request(`http://engine${url}`, { method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) }), params);
      return response;
    };
    const created = await (await call("POST", "/pexels/services", "/x", {}, { name: "Home", url: "http://pexels.home", key: "secret" })).json();
    assertEquals(created.hasKey, true);
    assertEquals((await call("POST", "/pexels/services", "/x", {}, { name: "", url: "http://a" })).status, 400);
    const listed = await (await call("GET", "/pexels/services", "/x")).text();
    assert(!listed.includes("secret"));
    const photos = await (await call("GET", "/pexels/services/<id>/photos", "/x?query=&page=1", { id: created.id })).json();
    assertEquals(photos.photos.length, PEXELS_PAGE_SIZE);
    assertEquals((await call("GET", "/pexels/services/<id>/photos", "/x?page=0", { id: created.id })).status, 400);
    const image = await call("GET", "/pexels/services/<id>/photos/<photo>/image", "/x", { id: created.id, photo: photos.photos[0].id });
    assertEquals([image.status, image.headers.get("content-type"), image.headers.get("x-content-type-options")], [200, "image/jpeg", "nosniff"]);
    assertEquals((await image.arrayBuffer()).byteLength, JPEG.length);
    assertEquals((await call("GET", "/pexels/services/<id>/photos", "/x", { id: "missing" })).status, 404);
    assertEquals((await (await call("DELETE", "/pexels/services/<id>", "/x", { id: created.id })).json()).removed, true);
    assertEquals((await (await call("GET", "/pexels/services", "/x")).json()).services, []);
  } finally { await Deno.remove(path.replace(/\/[^/]+$/, ""), { recursive: true }); }
});

const manualTimers = () => {
  const pending = [];
  return { setTimeout: (callback, ms) => { const timer = { callback, ms }; pending.push(timer); return timer; },
    clearTimeout: timer => { const index = pending.indexOf(timer); if (index >= 0) pending.splice(index, 1); },
    flush: () => { for (const timer of pending.splice(0)) timer.callback(); }, pending };
};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

Deno.test("pexels browse: curated loads at once, typing waits for a pause, superseded searches are aborted, pages append", async () => {
  const calls = [], timers = manualTimers();
  const api = { pexelsPhotos: (service, query, page, signal) => {
    calls.push({ service, query, page, signal });
    return Promise.resolve({ curated: true, more: page < 2, photos: [1, 2].map(n => ({ id: `${query || "c"}-${page}-${n}` })) });
  } };
  const browse = makePexelsBrowse({ api, timers });
  browse.request("s", ""); await settle();
  assertEquals(browse.results("s", "").files, ["c-1-1", "c-1-2"]);
  assertEquals(browse.results("s", "").more, true);
  browse.request("s", "ca");
  assertEquals(calls.length, 1);
  assertEquals(browse.results("s", "ca"), { files: ["c-1-1", "c-1-2"], pending: true, more: false, error: "", searchOnly: false });
  browse.request("s", "cat");
  assertEquals(timers.pending.length, 1);
  timers.flush(); await settle();
  assertEquals(calls.map(call => call.query), ["", "cat"]);
  browse.more("s", "cat"); await settle();
  assertEquals(browse.results("s", "cat").files, ["cat-1-1", "cat-1-2", "cat-2-1", "cat-2-2"]);
  assertEquals(browse.results("s", "cat").more, false);
  browse.more("s", "cat"); await settle();
  assertEquals(calls.length, 3);
  browse.dispose();
});

Deno.test("pexels browse: a service without curated asks for a search; failures keep their message until Retry", async () => {
  let fail = true;
  const api = { pexelsPhotos: (_service, query) => query ? fail ? Promise.reject(Object.assign(new Error("x"), { detail: "Home answered HTTP 500" }))
    : Promise.resolve({ curated: true, more: false, photos: [{ id: "1" }] }) : Promise.resolve({ curated: false, more: false, photos: [] }) };
  const timers = manualTimers(), browse = makePexelsBrowse({ api, timers });
  browse.request("s", ""); await settle();
  assertEquals(browse.results("s", ""), { files: [], pending: false, more: false, error: "", searchOnly: true });
  browse.request("s", "dog"); timers.flush(); await settle();
  assertEquals(browse.results("s", "dog").error, "Home answered HTTP 500");
  fail = false; browse.retry("s", "dog"); await settle();
  assertEquals(browse.results("s", "dog"), { files: ["1"], pending: false, more: false, error: "", searchOnly: false });
  browse.dispose();
});

Deno.test("pexels services owner: one redacted list confirmed after each mutation", async () => {
  let list = [];
  const api = {
    pexelsServices: async () => ({ services: list }),
    createPexelsService: async details => { if (!details.name) throw Object.assign(new Error("400"), { detail: "Enter a name" });
      const saved = { id: "1", name: details.name, url: details.url, hasKey: !!details.key }; list = [saved]; return saved; },
    updatePexelsService: async (id, details) => { list = list.map(item => item.id === id ? { ...item, ...details, hasKey: details.key === null ? false : item.hasKey } : item); return list[0]; },
    removePexelsService: async id => { list = list.filter(item => item.id !== id); return { removed: true }; },
  };
  let changes = 0;
  const owner = makePexelsServices({ api, changed: () => changes++ });
  await owner.load();
  assertEquals(owner.state().services, []);
  assertEquals(await owner.create({ name: "" }), { ok: false, error: "Enter a name" });
  assertEquals((await owner.create({ name: "Home", url: "http://h", key: "k" })).ok, true);
  assertEquals(owner.state().services.map(item => [item.name, item.hasKey]), [["Home", true]]);
  await owner.update("1", { key: null });
  assertEquals(owner.state().services[0].hasKey, false);
  await owner.remove("1");
  assertEquals(owner.state().services, []);
  assert(changes > 4);
  owner.dispose();
});

Deno.test("pexels editor: a chosen photo joins the set as an uploaded File through the shared membership lane", async () => {
  const reads = [];
  let release;
  const rig = editorRig({ readPexelsPhoto: (service, photo) => { reads.push([service, photo]);
    return new Promise(resolve => { release = () => resolve(new File([JPEG], `pexels-${photo}.jpg`, { type: "image/jpeg" })); }); } });
  const { editor } = rig, id = "image.image";
  editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", id, "enabled", true);
  const pending = editor.togglePexels(id, "svc", "42");
  assertEquals(editor.pexelsState(id, "svc", "42"), { selected: false, pending: true, error: "" });
  release(); await pending;
  assertEquals(editor.pexelsState(id, "svc", "42"), { selected: true, pending: false, error: "" });
  assertEquals(editor.rows("images")[id].items.map(item => [item.kind, item.name]), [["upload", "pexels-42.jpg"]]);
  await editor.togglePexels(id, "svc", "42");
  assertEquals(editor.rows("images")[id].items, []);
  await editor.togglePexels(id, "svc", "42");
  assertEquals(reads, [["svc", "42"]]);
  await editor.inspectImages();
  assertEquals((await editor.run()).submitted, 1);
  assertEquals(rig.uploads.map(upload => upload.file.name), ["pexels-42.jpg"]);
  assertEquals(rig.requests[0].imageParams[id].values, ["pexels-42.jpg"]);
  editor.dispose();
});

Deno.test("pexels editor: a toggle withdrawn while reading adds nothing, and a failed read reports on the photo", async () => {
  let release, fail = false;
  const rig = editorRig({ readPexelsPhoto: (_service, photo) => fail ? Promise.reject(new Error("Home answered HTTP 502"))
    : new Promise(resolve => { release = () => resolve(new File([JPEG], `pexels-${photo}.jpg`, { type: "image/jpeg" })); }) });
  const { editor } = rig, id = "image.image";
  editor.edit("images", id, "enabled", true);
  const first = editor.togglePexels(id, "svc", "1");
  editor.togglePexels(id, "svc", "1");
  release(); await first;
  assertEquals(editor.rows("images")[id].items, []);
  fail = true;
  await editor.togglePexels(id, "svc", "2");
  assertEquals(editor.pexelsState(id, "svc", "2"), { selected: false, pending: false, error: "Photo 2: Home answered HTTP 502" });
  editor.dispose();
});
