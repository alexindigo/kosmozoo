// Fake Pexels-compatible service for browser tests:
//   deno run --allow-net --allow-read tests/fake-pexels.mjs --port 18270 [--key secret] [--no-curated]
// The image origin listens on port+1, so key scoping is exercised for real.
import { parseArgs } from "node:util";
import { pexelsHandler } from "./helpers/fake-pexels.mjs";
import { testPng } from "./helpers/png.mjs";

const { values: args } = parseArgs({ args: Deno.args, options: { port: { type: "string" }, key: { type: "string" }, "no-curated": { type: "boolean" } } });
const port = Number(args.port ?? 18270), images = new Map();
// Distinct, decodable pictures per photo: a diagonal two-colour gradient whose
// hue follows the photo ID, alternating landscape and portrait.
const picture = id => {
  if (!images.has(id)) {
    const n = Number(id), hue = (n * 47) % 360, [width, height] = n % 3 ? [320, 220] : [220, 300];
    const rgb = h => { const k = m => (m + h / 30) % 12, f = m => 0.5 - 0.4 * Math.max(-1, Math.min(k(m) - 3, 9 - k(m), 1)); return [f(0), f(8), f(4)].map(v => Math.round(v * 255)); };
    const a = rgb(hue), b = rgb((hue + 120) % 360);
    images.set(id, testPng(width, height, (x, y) => { const t = (x / width + y / height) / 2; return [...a.map((v, i) => Math.round(v + (b[i] - v) * t)), 255]; }));
  }
  return images.get(id);
};
const handler = pexelsHandler({ api: `http://127.0.0.1:${port}`, cdn: `http://127.0.0.1:${port + 1}`, key: args.key ?? null,
  curated: !args["no-curated"], image: picture });
Deno.serve({ port, hostname: "127.0.0.1", onListen() {} }, handler);
Deno.serve({ port: port + 1, hostname: "127.0.0.1", onListen() {} }, handler);
console.log(`fake pexels on ${port} (images ${port + 1})`);
