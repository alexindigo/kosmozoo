import { assert, assertEquals } from "jsr:@std/assert";

Deno.test("browser runner confines every filesystem-capable engine to loopback", async () => {
  const runner = await Deno.readTextFile(new URL("./e2e/run.sh", import.meta.url));
  const launches = runner.split(/\n(?=(?:timeout \S+ )?docker run)/).filter(block => /src\/main\.mjs/.test(block));
  assert(launches.length >= 4);
  for (const launch of launches) assert(launch.includes("KOZMOZOO_BIND=127.0.0.1"), launch);
});

Deno.test("fake Comfy listener is loopback-only even without a caller bind override", async () => {
  const previous = [...Deno.args];
  Deno.args.splice(0, Deno.args.length, "--port", "0");
  let servers = [];
  try {
    ({ servers } = await import("./fake-comfy.mjs"));
    assertEquals(servers.map(server => server.addr.hostname), ["127.0.0.1", "127.0.0.2", "127.0.0.3"]);
    for (const server of servers) {
      const response = await fetch(`http://${server.addr.hostname}:${server.addr.port}/api/system_stats`);
      assert(response.ok, "each address-scoped fixture remains reachable on loopback");
      await response.body.cancel();
    }
  } finally {
    await Promise.all(servers.map(server => server.shutdown()));
    Deno.args.splice(0, Deno.args.length, ...previous);
  }
});
