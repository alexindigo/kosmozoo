import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireInstance, matchingInstance, RUNTIME_PROTOCOL, RUNTIME_VERSION } from "../src/instance.mjs";
import { resolveRuntime } from "../src/runtime-config.mjs";

const runtime = (lease, binding, changes = {}) => ({ protocol: RUNTIME_PROTOCOL, version: RUNTIME_VERSION, instance: lease.instance,
  sourceVersion: "test-input", mode: "serve", status: "ready", binding, configuredBind: "0.0.0.0", ...changes });

Deno.test("instance ownership: stable inode, one writer, matching nonce and real HTTP readiness across state-path aliases", async () => {
  const root = await Deno.makeTempDir({ dir: tmpdir(), prefix: "kz-instance-" });
  const state = join(root, "state"), alias = join(root, "container-state");
  let owner, second, server;
  try {
    owner = await acquireInstance(state); assert(owner.owner);
    await Deno.symlink(state, alias, { type: "dir" });
    second = await acquireInstance(alias); assert(!second.owner);
    const identity = await Deno.stat(join(state, "engine.lock"));
    let body;
    server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => Response.json(body));
    body = runtime(owner, { hostname: "127.0.0.1", port: server.addr.port });
    await owner.publish(body);
    const reused = await matchingInstance(second, resolveRuntime("app", {}));
    assertEquals(reused.runtime.instance, owner.instance);
    assertEquals(reused.browserURL, `http://localhost:${server.addr.port}/`);
    assertEquals(Object.hasOwn(reused.runtime, "state"), false);
    assertEquals(Object.hasOwn(reused.runtime, "lockIdentity"), false);
    assertEquals((await Deno.stat(join(state, "engine-instance.json"))).mode & 0o077, 0);
    await assertRejects(() => matchingInstance(second, resolveRuntime("app", { KOZMOZOO_BIND: "127.0.0.1" })), Error, "conflict");
    body = { ...body, instance: crypto.randomUUID() };
    await assertRejects(() => matchingInstance(second, resolveRuntime("app", {})), Error, "identity");
    await owner.release();
    const next = await acquireInstance(state); assert(next.owner);
    assertEquals((await Deno.stat(join(state, "engine.lock"))).ino, identity.ino);
    await next.release();
  } finally { await second?.release(); await owner?.release(); await server?.shutdown(); await Deno.remove(root, { recursive: true }); }
});

Deno.test("instance ownership: copied metadata cannot attach a different selected state to an existing listener", async () => {
  const root = await Deno.makeTempDir({ dir: tmpdir(), prefix: "kz-instance-copy-" });
  let first, other, contender;
  try {
    first = await acquireInstance(join(root, "first"));
    await first.publish(runtime(first, { hostname: "127.0.0.1", port: 2084 }));
    other = await acquireInstance(join(root, "other"));
    await Deno.copyFile(join(root, "first/engine-instance.json"), join(root, "other/engine-instance.json"));
    contender = await acquireInstance(join(root, "other")); assert(!contender.owner);
    await assertRejects(() => matchingInstance(contender, resolveRuntime("app", {})), Error, "another state lockfile");
    await Deno.remove(join(root, "other/engine-instance.json"));
  } finally { await contender?.release(); await other?.release(); await first?.release(); await Deno.remove(root, { recursive: true }); }
});
