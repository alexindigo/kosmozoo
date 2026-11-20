import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { createRequire } from "node:module";
const { CDP } = createRequire(import.meta.url)("./e2e/cdp.cjs");

Deno.test("browser navigation waits for the requested document loader before reading readiness", async () => {
  const page = Object.create(CDP.prototype);
  let frameReads = 0, evaluations = 0;
  page.send = async method => {
    if (method === "Page.navigate") return { frameId: "main", loaderId: "new" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: ++frameReads < 2 ? "old" : "new" } } };
    return {};
  };
  page.evaluate = () => {
    assert(frameReads >= 2, "the old document can already report complete while navigation is pending");
    if (++evaluations === 1) throw new Error("Execution context was destroyed.");
    return Promise.resolve(true);
  };
  await page.goto("http://fixture/new");
  assertEquals(evaluations, 2);
});

Deno.test("browser navigation keeps same-document readiness and reports actual navigation errors", async () => {
  const page = Object.create(CDP.prototype), calls = [];
  page.send = async method => { calls.push(method); return {}; };
  page.evaluate = () => Promise.resolve(true);
  await page.goto("http://fixture/#next");
  assertEquals(calls, ["Page.enable", "Page.navigate"]);
  page.send = async method => method === "Page.navigate" ? { errorText: "net::ERR_CONNECTION_REFUSED" } : {};
  await assertRejects(() => page.goto("http://fixture/offline"), Error, "net::ERR_CONNECTION_REFUSED");
});
