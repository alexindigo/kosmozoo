// tests/e2e/metadata-scale-sources.mjs — four synthetic ComfyUI sources at the
// scale of a real installation: 4,572 / 5,944 / 199 / 10,944 outputs, long
// names, nested folders and about 3 KB of graph metadata per output. One
// deterministic model serves both roles:
//
//   seed <stateDir> <cacheDir> <name=port>...
//       ingests every output through the engine's own Ingest path, then marks
//       the CHURN contents as extracted by an older extractor, so the running
//       engine's prefetch keeps re-extracting thousands (metadata version
//       advancing continuously, as on a busy installation)
//   serve <name=port[=failing]>...
//       the ComfyUI API the engine reads; a failing source answers every byte
//       read with a body that breaks mid-transfer. POST /__test/arrive
//       publishes a new newest output and returns its name.
import { testPng } from "../helpers/png.mjs";
import { splitEntryPath } from "../../src/entry-path.mjs";

export const SCALE = { comfyui: 4572, anton: 5944, acropolis: 199, ark: 10944 };
const CHURN = { comfyui: 4000, anton: 4000, ark: 200 };
const WORDS = ("amber basalt cinder delta ember fjord glacier harbor indigo juniper kelp lumen meadow nebula orchid " +
  "prairie quartz river sable tundra umber velvet willow xenon yarrow zephyr portrait cinematic lighting volumetric " +
  "haze detailed texture soft focus golden hour").split(" ");
const text = (seed, length) => {
  let out = "", x = seed * 2654435761 >>> 0;
  while (out.length < length) { x = (x * 1103515245 + 12345) >>> 0; out += WORDS[x % WORDS.length] + (x % 7 ? " " : ", "); }
  return out.slice(0, length);
};
const PREFIX = { comfyui: "Qwen_image_2.1", anton: "Flux2-Klein", acropolis: "MiniMax_H3", ark: "Qwen_image_2.1" };
const BASE_MTIME = 1_790_000_000;

export function output(source, i) {
  const tail = text(i + source.length, 20 + i % 60).replace(/[^a-z]+/g, "_");
  const file = `${PREFIX[source]}_${String(i).padStart(5, "0")}_${tail}.png`;
  const name = i % 12 === 5 ? `batch_${i % 31}/${file}` : file;
  const token = `${source}-scale-${i}`;
  return { name, token, mtime: BASE_MTIME - i, index: i, graph: graph(source, i, token) };
}

export function graph(source, i, token) {
  return {
    "3": { class_type: "KSampler", inputs: { seed: i * 7919 % 1_000_000_007, steps: 20 + i % 10, cfg: 3.5 + i % 5 / 2,
      sampler_name: ["euler", "dpmpp_2m", "uni_pc"][i % 3], scheduler: "simple", denoise: 1 } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-dev-fp8.safetensors" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 768 + 256 * (i % 2), batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: text(i, 1400) } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: text(i + 1, 300) } },
    "10": { class_type: "LoraLoader", inputs: { lora_name: `style_${i % 9}.safetensors`, strength_model: 0.8, strength_clip: 1 } },
    "11": { class_type: "LoraLoader", inputs: { lora_name: `detail_${i % 4}.safetensors`, strength_model: 0.5, strength_clip: 0.5 } },
    "12": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: `${source}/${PREFIX[source]}` } },
    "20": { class_type: "ScaleToken", inputs: { token } },
  };
}

export const bytesOf = (row) => testPng(48, row.index % 2 ? 36 : 48, [row.index & 255, row.index * 7 & 255, 96, 255], row.graph);

async function seed([stateDir, cacheDir, ...specs]) {
  const { Settings } = await import("../../src/settings.mjs");
  const { Store } = await import("../../src/store.mjs");
  const { Cache } = await import("../../src/cache.mjs");
  const { Ingest } = await import("../../src/ingest.mjs");
  const hosts = Object.fromEntries(specs.map((spec) => { const [name, port] = spec.split("="); return [name, `127.0.0.1:${port}`]; }));
  const settings = await Settings.open(stateDir);
  const store = await Store.open(stateDir, { settings });
  const cache = new Cache(cacheDir);
  const ingest = new Ingest(store, hosts, { cache });
  for (const [source, address] of Object.entries(hosts)) {
    store.collectionAdd(source, address);
    const started = Date.now();
    for (let i = 0; i < SCALE[source]; i++) {
      const row = output(source, i);
      await ingest.ensureBytes(source, row.name, bytesOf(row));
      // Churn: older-extractor content whose bytes are no longer cached, so the
      // engine's prefetch re-reads and re-extracts it (cached stale content is
      // returned by Ingest.ensure as it is).
      if (i < (CHURN[source] ?? 0)) {
        await store.metaPut(source, row.name, store.metaState(source, row.name).meta, { ext: 4 });
        await Deno.remove(cache.path(store.hashFor(source, row.name)));
      }
    }
    console.log(`seeded ${source}: ${SCALE[source]} outputs (${CHURN[source] ?? 0} stale) in ${Date.now() - started}ms`);
  }
  store.close();
}

function serve(specs) {
  for (const spec of specs) {
    const [source, port, flag] = spec.split("=");
    const rows = Array.from({ length: SCALE[source] }, (_, i) => output(source, i));
    let arrivals = 0;
    const byName = new Map(rows.map((row) => [row.name, row]));
    const sizes = new Map(), history = {};
    const size = (row) => sizes.get(row.name) ?? sizes.set(row.name, bytesOf(row).length).get(row.name);
    const sorted = () => [...byName.values()].sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : 1));
    const headers = (row) => {
      const n = size(row), ns = BigInt(row.mtime) * 1_000_000_000n;
      return { "Content-Type": "image/png", "Content-Length": String(n), "Last-Modified": new Date(row.mtime * 1000).toUTCString(), ETag: `"${ns.toString(16)}-${n.toString(16)}"` };
    };
    Deno.serve({ port: Number(port), hostname: "127.0.0.1", onListen: () => console.log(`scale source ${source} on :${port} — ${rows.length} outputs${flag === "failing" ? ", failing reads" : ""}`) }, async (req) => {
      const url = new URL(req.url), p = url.pathname;
      if (p === "/__test/arrive" && req.method === "POST") {
        const i = 900_000 + ++arrivals, token = `${source}-arrival-${arrivals}`;
        const row = { name: `${PREFIX[source]}_arrival_${String(arrivals).padStart(5, "0")}_.png`, token, index: i,
          mtime: Math.floor(Date.now() / 1000), graph: graph(source, i, token) };
        byName.set(row.name, row);
        history[`arrival-${arrivals}`] = { prompt: [arrivals, `arrival-${arrivals}`, {}, { client_id: "external-fixture-client" }],
          outputs: { "9": { images: [{ ...splitEntryPath(row.name), type: "output" }] } },
          status: { completed: true, status_str: "success", messages: [["execution_success", {}]] } };
        return Response.json({ name: row.name, token });
      }
      if (p === "/ws") { const { socket, response } = Deno.upgradeWebSocket(req); socket.onopen = () => socket.send(JSON.stringify({ type: "status", data: { sid: "scale" } })); return response; }
      if (p === "/api/system_stats") return Response.json({ system: { os: "scale" }, devices: [] });
      if (p === "/api/queue") return Response.json({ queue_running: [], queue_pending: [] });
      if (p === "/internal/logs/raw") return Response.json({ entries: [], size: { cols: 80, rows: 24 } });
      if (p.startsWith("/api/history/")) { const id = decodeURIComponent(p.slice(13)); return Response.json(history[id] ? { [id]: history[id] } : {}); }
      if (p === "/api/history") return Response.json(history);
      if (p === "/api/object_info") return Response.json({});
      if (p === "/internal/files/input") return Response.json([]);
      if (p === "/internal/files/output") return Response.json(sorted().filter((row) => !row.name.includes("/")).map((row) => `${row.name} [${size(row)}]`));
      if (p === "/api/assets_plus/config") return Response.json({ allowed_extensions: [".png"], recursive: true, scan_depth: null, list_limit: 200 });
      if (p === "/api/assets_plus/output/list") {
        let items = sorted().map((row) => ({ relpath: row.name, filename: row.name.split("/").at(-1), size: size(row), mtime: row.mtime, type: "image", has_workflow: true }));
        const query = url.searchParams.get("query") ?? url.searchParams.get("q");
        if (query) items = items.filter((item) => item.relpath.toLowerCase().includes(query.toLowerCase()));
        const latest_mtime = items[0]?.mtime ?? 0, cursor = url.searchParams.get("cursor"), since = url.searchParams.get("since");
        if (since !== null) items = items.filter((item) => item.mtime > Number(since));
        else if (cursor) {
          const split = cursor.indexOf(":"), time = Number(split < 0 ? cursor : cursor.slice(0, split)), after = split < 0 ? null : cursor.slice(split + 1);
          items = items.filter((item) => item.mtime < time || after !== null && item.mtime === time && item.relpath > after);
        }
        const limit = Number(url.searchParams.get("limit") ?? 200), has_more = limit !== 0 && items.length > limit;
        if (limit) items = items.slice(0, limit);
        return Response.json({ items, has_more, latest_mtime, cursor: items.length ? `${items.at(-1).mtime}:${items.at(-1).relpath}` : cursor ?? "" });
      }
      if (p === "/api/view") {
        const filename = url.searchParams.get("filename") ?? "", subfolder = url.searchParams.get("subfolder") ?? "";
        const row = url.searchParams.get("type") === "input" ? null : byName.get(subfolder ? `${subfolder}/${filename}` : filename);
        if (!row) return new Response("not found", { status: 404 });
        if (req.method === "HEAD") return new Response(null, { headers: headers(row) });
        if (flag === "failing") return new Response(new ReadableStream({ start(c) { c.error(new Error("failing source")); } }), { headers: { "Content-Type": "image/png" } });
        const bytes = bytesOf(row), range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
        if (!range) return new Response(bytes, { headers: headers(row) });
        const start = Number(range[1]), end = Math.min(Number(range[2]) + 1, bytes.length), h = new Headers(headers(row));
        h.set("Content-Range", `bytes ${start}-${end - 1}/${bytes.length}`); h.set("Content-Length", String(end - start));
        return new Response(bytes.subarray(start, end), { status: 206, headers: h });
      }
      return new Response("not found", { status: 404 });
    });
  }
}

if (import.meta.main) {
  const [mode, ...rest] = Deno.args;
  if (mode === "seed") await seed(rest);
  else if (mode === "serve") serve(rest);
  else throw new Error("usage: metadata-scale-sources.mjs seed|serve …");
}
