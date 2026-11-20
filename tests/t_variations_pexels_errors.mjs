import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { pexelsProblemCases } from "./helpers/variation-pexels-problem-cases.mjs";
import { variationProblem } from "../src/features/variations/problems.mjs";
import { problemPresentation } from "../client-solid/features/variations/problem-presentation.js";
import { makePexelsClient, PexelsServices, registerPexels } from "../src/features/variations/pexels.mjs";
import { listImages, readImage } from "../src/features/variations/folder-images.mjs";
import { makePexelsBrowse } from "../client-solid/features/variations/pexels-browse.js";
import { makePexelsServices } from "../client-solid/features/variations/pexels-services.js";
import { editorRig } from "./helpers/variation-editor.mjs";

for (const test of pexelsProblemCases) Deno.test(`pexels/folder catalogue row ${test.row}: exact ${test.location} contract`, () => {
  const p = variationProblem(test.code, test.context), projection = problemPresentation([p]);
  assertEquals(p.message, test.message); assertEquals(projection.text, test.message + " " + p.action);
  assertEquals(projection.fields.get("n.steps")[0], p); assertEquals(projection.targets.get(0)[0], p);
});

const home = { id: "s", name: "Home", url: "http://h" };
const reply = (status, body = {}, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const client = route => makePexelsClient({ fetch: async href => route(new URL(href)) });
const rejects = async (run, code) => { const error = await assertRejects(run); assertEquals(error.problem?.code, code, error.message); return error.problem; };

Deno.test("pexels producers name the service, the request and the HTTP evidence (rows 232-236, 240, 241, 243, 245)", async () => {
  let p = await rejects(() => client(() => reply(401)).photos(home, { query: "cat" }), "pexels-auth");
  assertEquals(p.message, 'Home needs an API key (HTTP 401); cannot load search "cat", page 1.');
  p = await rejects(() => client(() => reply(429, {}, { "Retry-After": "30" })).photos(home, { query: "cat", page: 2 }), "pexels-rate");
  assertEquals(p.message, 'Home rate limit reached (HTTP 429) while loading search "cat", page 2; it asks to wait 30 seconds.');
  p = await rejects(() => client(() => reply(404)).photo(home, "999"), "pexels-missing");
  assertEquals([p.photo, p.numbers.status], ["999", 404]);
  p = await rejects(() => client(() => reply(500)).photos(home, { query: "cat" }), "pexels-http");
  assertEquals(p.message, 'Home failed while loading search "cat", page 1 (HTTP 500).');
  p = await rejects(() => client(url => reply(url.pathname === "/v1/curated" ? 500 : 502)).photos(home), "pexels-browse");
  assertEquals(p.message, "Could not browse Home: curated photos answered HTTP 500 and the catalogue listing answered HTTP 502.");
  p = await rejects(() => client(() => reply(200, "{not json")).photos(home, { query: "cat" }), "pexels-reply");
  assertEquals(p.message, 'Home returned an unreadable reply for search "cat", page 1: the reply is not valid JSON.');
  p = await rejects(() => client(() => reply(200, { photos: [{ id: 1, src: {} }, { src: { original: "http://a/x" } }] })).photos(home, { query: "cat" }), "pexels-records");
  assertEquals(p.numbers.received, 2);
  p = await rejects(() => client(() => reply(200, { id: 42, src: { original: "ftp://a/x" } })).photo(home, "42"), "pexels-photo");
  assertEquals(p.message, "Home, photo 42: the record has no usable http(s) image URL. It was not added.");
  p = await rejects(() => makePexelsClient({ fetch: () => Promise.reject(new TypeError("refused")) }).photos(home, { query: "cat" }), "pexels-unreachable");
  assertEquals(p.message, 'Home could not be reached while loading search "cat", page 1: refused.');
});

Deno.test("pexels bytes, redirects and reply size keep the photo identity and limits (rows 237-239, 246)", async () => {
  const photo = { id: 42, src: { original: "http://h/42.jpg" } };
  let p = await rejects(() => client(url => url.pathname === "/v1/photos/42" ? reply(200, photo) : new Response("<html></html>", { headers: { "Content-Type": "text/html" } })).bytes(home, "42", "image"), "pexels-mime");
  assertEquals(p.photo, "42"); assert(p.message.startsWith("Photo 42 from Home is not a supported image ("), p.message);
  p = await rejects(() => client(url => reply(302, {}, { Location: `http://h${url.pathname}` })).photos(home, { query: "cat" }), "pexels-redirect");
  assertEquals(p.message, 'Home cannot load search "cat", page 1: it redirected more than 5 times.');
  p = await rejects(() => client(() => reply(302, {}, { Location: "ftp://h/x" })).photos(home, { query: "cat" }), "pexels-redirect");
  assert(p.message.endsWith("it redirected to an unsupported ftp: address."), p.message);
  const small = makePexelsClient({ fetch: async () => reply(200, { photos: [] }, { "Content-Length": String(3 * 1024 * 1024) }), maxJsonBytes: 2 * 1024 * 1024 });
  p = await rejects(() => small.photos(home, { query: "cat" }), "pexels-size");
  assertEquals(p.message, 'Home, the reply for search "cat", page 1: reply size 3145728 bytes exceeds the 2 MiB limit.');
});

Deno.test("pexels registry and routes report fields, slots, storage and removed services (rows 218, 223, 224, 226-229, 247)", async () => {
  const path = `${Deno.env.get("TMPDIR") ?? "runtime/tmp"}/pexels-errors-${crypto.randomUUID()}.json`;
  let failing = false;
  const services = new PexelsServices(path, { write: async () => { if (failing) throw new Error("No space left on device"); } });
  let p = await rejects(() => services.create({ name: "x".repeat(61), url: "http://a" }), "pexels-name");
  assertEquals(p.numbers.length, 61); assertEquals(p.detail, "too long");
  const saved = await services.create({ name: "Home", url: "http://h" });
  p = await rejects(() => services.update(saved.id, { key: " " }), "pexels-key"); assert(!p.message.includes(" \n"));
  failing = true; p = await rejects(() => services.update(saved.id, { name: "Home 2" }), "pexels-storage");
  assertEquals(p.message, "Could not save Pexels service Home 2: No space left on device. Your draft remains; the saved list was not changed by this attempt.");
  assertEquals((await services.list()).map(item => item.name), ["Home"]); failing = false;
  for (let index = 1; index < 32; index++) await services.create({ name: `S${index}`, url: "http://a" });
  p = await rejects(() => services.create({ name: "S32", url: "http://a" }), "pexels-limit"); assertEquals(p.message, "32 of 32 Pexels service slots are used.");
  p = await rejects(() => services.get("gone"), "pexels-removed"); assertEquals(p.message, "This Pexels service was removed; its photos cannot be loaded from it. Images already added to your set are kept.");
  const routes = new Map(), app = { route: (method, route, handler) => routes.set(`${method} ${route}`, handler) };
  registerPexels(app, { services, client: makePexelsClient({ fetch: async () => reply(200, { photos: [] }) }) });
  const call = async (key, url, params) => { const response = await routes.get(key)(new Request(url), params); return [response.status, await response.json()]; };
  let [status, body] = await call("GET /pexels/services/<id>/photos", "http://e/?page=0", { id: saved.id });
  assertEquals([status, body.problem.code, body.problem.message], [400, "pexels-request", 'Cannot load photos from Home: invalid page "0" (Page must be a whole number from 1). Current settings and images are kept.']);
  [status, body] = await call("GET /pexels/services/<id>/photos/<photo>/image", "http://e/?service=http://old", { id: saved.id, photo: "42" });
  assertEquals([status, body.problem.code, body.problem.message], [409, "pexels-binding", "Photo 42 belongs to an older or missing Home configuration: Home's URL changed since this photo was listed."]);
  const bare = new Map(); registerPexels({ route: (method, route, handler) => bare.set(`${method} ${route}`, handler) });
  const response = await bare.get("GET /pexels/services")(new Request("http://e/"), {}), data = await response.json();
  assertEquals([response.status, data.problem.code], [503, "pexels-config"]);
});

Deno.test("pexels client owners keep retained results, reload and status causes visible (rows 217, 230, 231, 248, 265)", async () => {
  let fail = false;
  const api = { pexelsPhotos: async (_service, query, page) => {
    if (fail) throw Object.assign(new Error("x"), { detail: "HTTP 502" });
    return { curated: true, more: true, photos: Array.from({ length: 2 }, (_, index) => ({ id: `${query}-${page}-${index}` })) };
  } };
  const browse = makePexelsBrowse({ api, name: id => id === "s" ? "Home" : id });
  browse.request("s", ""); await new Promise(resolve => setTimeout(resolve, 0));
  fail = true; browse.more("s", ""); await new Promise(resolve => setTimeout(resolve, 0));
  assertEquals(browse.results("s", "").error, "Home: could not load page 2 for curated photos: HTTP 502. Showing 2 photos already loaded; more results are unavailable until Retry succeeds. Retry loading more results.");
  browse.dispose();
  let listing = true, list = [];
  const owner = makePexelsServices({ api: {
    pexelsServices: async () => { if (!listing) throw Object.assign(new Error("x"), { detail: "HTTP 503" }); return { services: list }; },
    createPexelsService: async details => { list = [{ id: "1", name: details.name, url: "http://h", hasKey: false }]; listing = false; return list[0]; },
    pexelsStatus: async () => ({ unreadable: true }),
  } });
  await owner.load();
  const created = await owner.create({ name: "Home", url: "http://h" });
  assertEquals(created.ok, true); assertEquals(created.reloadProblem.message, "Home was saved, but the current service list could not be reloaded: HTTP 503.");
  assertEquals(owner.state().problem.code, "pexels-list");
  listing = true; await owner.load(true); owner.recheck("1"); await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0));
  assertEquals(owner.status("1"), { phase: "error", message: "Could not check Home: the engine sent an unreadable status. Retry its connection check; verify its URL and key in Settings. Selected images are unaffected." });
  owner.dispose();
});

Deno.test("folder producers name the folder, the failing path and the refused file (rows 181, 184, 186, 189)", async () => {
  const dir = await Deno.makeTempDir({ dir: Deno.env.get("TMPDIR") ?? undefined });
  let p;
  try {
    await Deno.writeTextFile(`${dir}/notes.txt`, "x"); await Deno.mkdir(`${dir}/folder.png`);
    p = await rejects(() => listImages(`${dir}/notes.txt`), "folder-not-directory"); assertEquals(p.path, `${dir}/notes.txt`);
    p = await rejects(() => listImages(`${dir}/missing`), "folder-read");
    assertEquals(p.message, `Could not import "${dir}/missing": cannot read "${dir}/missing" (not found). Nothing from this import was added.`);
    p = await rejects(() => readImage(`${dir}/notes.txt`), "folder-image"); assert(p.message.includes("not a supported image type"));
    p = await rejects(() => readImage(`${dir}/folder.png`), "folder-image"); assert(p.message.includes("regular file"));
    const empty = await listImages(dir); assertEquals([empty.items.length, empty.skipped], [0, { links: 0, other: 1 }]);
  } finally { await Deno.remove(dir, { recursive: true }); }
  const rig = editorRig({ listFolder: async () => ({ items: "bad" }) });
  p = await rejects(() => rig.editor.addFolder("image.image", "/images"), "folder-not-added");
  assertEquals(p.message, '"/images" was not added: Invalid folder image listing returned by the engine. Your current image set is unchanged.');
  rig.editor.dispose();
  const refused = editorRig({ listFolder: async () => { throw Object.assign(new Error("x"), { problem: variationProblem("folder-not-directory", { path: "/images" }) }); } });
  p = await rejects(() => refused.editor.addFolder("image.image", "/images"), "folder-not-directory");
  assertEquals(p.parameter.id, "image.image"); refused.editor.dispose();
});
