import { assert, assertEquals } from "jsr:@std/assert";
import { Agent, get } from "node:http";
import process from "node:process";

Deno.test("browser runner confines every filesystem-capable engine to loopback", async () => {
  const runner = await Deno.readTextFile(new URL("./e2e/run.sh", import.meta.url));
  const launches = runner.split(/\n(?=(?:timeout \S+ )?docker run)/).filter(block => /src\/main\.mjs/.test(block));
  assert(launches.length >= 4);
  for (const launch of launches) assert(launch.includes("KOZMOZOO_BIND=127.0.0.1"), launch);
});

Deno.test("fake Comfy listener is loopback-only even without a caller bind override", async () => {
  // fake-comfy's node:util parser reads process.argv, which node:http may
  // initialize before this test. Own the actual parser input, not Deno.args.
  const previous = process.argv.slice(2);
  process.argv.splice(2, process.argv.length - 2, "--port", "0");
  let servers = [];
  const client = new Agent(); // node:http connects directly, independent of HTTP_PROXY.
  try {
    ({ servers } = await import("./fake-comfy.mjs"));
    assertEquals(servers.map(server => server.addr.hostname), ["127.0.0.1", "127.0.0.2", "127.0.0.3"]);
    for (const server of servers) {
      const status = await new Promise((resolve, reject) => {
        const request = get(`http://${server.addr.hostname}:${server.addr.port}/api/system_stats`, { agent: client }, response => {
          response.on("error", reject);
          response.on("end", () => resolve(response.statusCode));
          response.resume();
        });
        request.on("error", reject);
        request.setTimeout(2000, () => request.destroy(new Error("loopback probe timed out")));
      });
      assertEquals(status, 200, "each address-scoped fixture remains reachable on loopback");
    }
  } finally {
    client.destroy();
    try { await Promise.all(servers.map(server => server.shutdown())); }
    finally { process.argv.splice(2, process.argv.length - 2, ...previous); }
  }
});
