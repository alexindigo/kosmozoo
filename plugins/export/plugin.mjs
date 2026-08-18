// plugins/export/plugin.mjs — training export, the server+client plugin
// shape (the reason Deno is the foundation).
//
// Routes bucket-tagged images to per-bucket folders as PNG + sidecar .txt
// caption pairs (ai-toolkit dataset format), and produces a reject-set that
// excludes tag == 'scene' (staging failures must not pollute the character
// reject-set). Buckets are namespaced plugin fields on the judgment record:
// plugins.export.bucket / plugins.export.tag.

import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BUCKETS = ["alisa_good", "alisa_almost", "alisa_almost_almost", "not_alisa", "other_alisa", "alisa_broken"];
const TAGS = ["character", "scene", "style"]; // character is default, stored absent

export function register(kz) {
  kz.exporter({
    id: "ai-toolkit",
    label: "ai-toolkit dataset export",
    buckets: BUCKETS,
    tags: TAGS,
  });

  // assign a bucket/tag to an image (client drives this)
  kz.route("PUT", "/assign", async (req) => {
    const { host, filename, bucket, tag } = await req.json();
    if (bucket !== undefined) {
      if (bucket !== null && !BUCKETS.includes(bucket)) {
        return Response.json({ error: "unknown bucket" }, { status: 400 });
      }
      await kz.store.setField(host, filename, "bucket", bucket);
    }
    if (tag !== undefined) {
      const t = tag === "character" ? null : tag; // default stored absent
      if (t !== null && !TAGS.includes(t)) {
        return Response.json({ error: "unknown tag" }, { status: 400 });
      }
      await kz.store.setField(host, filename, "tag", t);
    }
    return Response.json(kz.judgments.get(host, filename) ?? {});
  });

  // run the export: route bucketed images to ~/Downloads/<bucket>/ as
  // image.png + image.txt, build the reject-set excluding tag=='scene',
  // and a digest for dataset decisions.
  kz.route("POST", "/run", async (req) => {
    const { host, downloads } = await req.json().catch(() => ({}));
    const dlBase = downloads ?? join(Deno.env.get("HOME") ?? ".", "Downloads");
    const summary = { routed: {}, rejectSet: [], digest: [] };

    // The store exposes judgments; iterate all entries with an export bucket.
    for (const bucket of BUCKETS) summary.routed[bucket] = 0;
    // The engine hands judgments via kz.judgments; enumerate via the store's
    // feedback document is plugin-private — here we pull from the client
    // which drives export per selection. For the server-side batch path we
    // read the store through a small accessor the host exposes.
    const all = kz.judgments._all ? kz.judgments._all() : {};
    for (const [key, entry] of Object.entries(all)) {
      const bucket = entry?.plugins?.export?.bucket;
      if (!bucket || !BUCKETS.includes(bucket)) continue;
      const tag = entry?.plugins?.export?.tag ?? "character";
      const i = key.indexOf(":");
      const filename = key.slice(i + 1);
      const dir = join(dlBase, bucket);
      await mkdir(dir, { recursive: true });
      // PNG bytes come from the host proxy — fetch via the engine's own route
      const bytes = await kz._fetchImageBytes?.(key);
      if (bytes) {
        await writeFile(join(dir, filename), bytes);
      }
      // sidecar caption
      const caption = entry?.notes?.pos ?? "";
      await writeFile(join(dir, filename.replace(/\.png$/, ".txt")), caption);
      summary.routed[bucket]++;
      summary.digest.push({ filename, bucket, tag, captionLen: caption.length });
      if (entry?.vote === "down" && tag !== "scene") summary.rejectSet.push(filename);
    }
    return Response.json(summary);
  });

  // current assignments, for the client's bucket strip
  kz.route("GET", "/assignments", () => {
    const all = kz.judgments._all ? kz.judgments._all() : {};
    const out = {};
    for (const [key, entry] of Object.entries(all)) {
      const bucket = entry?.plugins?.export?.bucket;
      if (bucket) out[key] = { bucket, tag: entry?.plugins?.export?.tag ?? "character" };
    }
    return Response.json(out);
  });
}
