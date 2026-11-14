import { assertEquals, assertRejects } from "jsr:@std/assert";
import { createRequire } from "node:module";
const { ownedFixtures } = createRequire(import.meta.url)("./e2e/owned-fixtures.cjs");

for (const phase of ["publish", "start", "finish"]) Deno.test(`scenario fixtures: ${phase} lost reply/early failure cleans only owned resources`, async () => {
  const outputs = new Set(), running = new Set(["unrelated"]), history = {}; let finishes = 0;
  const success = { status: { completed: true }, outputs: { image: "mine.png" } };
  const owner = ownedFixtures({
    read: route => Promise.resolve(route === "/api/queue" ? { queue_running: [...running].map(id => [0, id]), queue_pending: [] } : history),
    control: body => {
      for (const item of body.publish ?? []) outputs.add(item.name);
      if (body.running) { running.clear(); body.running.forEach(id => running.add(id)); }
      for (const item of body.finish ?? []) { finishes++; running.delete(item.id); if (item.output) outputs.add(item.output); history[item.id] = item.output ? success : { status: { completed: false } }; }
      for (const name of body.remove ?? []) outputs.delete(name);
      if (body[phase === "publish" ? "publish" : phase === "start" ? "running" : "finish"] && (phase !== "finish" || body.finish[0].output)) throw new Error("lost reply");
      return Promise.resolve();
    },
  });
  await assertRejects(() => owner.run(async () => {
    if (phase === "publish") await owner.publish([{ name: "mine.png" }]);
    else { await owner.start("mine"); if (phase === "finish") await owner.finish("mine", [{ output: "mine.png" }]); }
  }), Error, "lost reply");
  assertEquals([...outputs], []); assertEquals([...running], ["unrelated"]);
  if (phase === "finish") { assertEquals(history.mine, success); assertEquals(finishes, 1); }
});
Deno.test("scenario fixtures: successful terminal history survives normal cleanup and page cleanup cannot mask failure", async () => {
  const history = { mine: { status: { completed: true }, outputs: { original: true } } }; let finishes = 0;
  const owner = ownedFixtures({ read: route => Promise.resolve(route === "/api/queue" ? { queue_running: [], queue_pending: [] } : history), control: () => { finishes++; } });
  await owner.run(() => owner.finish("mine", [])); assertEquals(finishes, 1);
  assertEquals(history.mine.outputs, { original: true });
  await assertRejects(() => owner.run(() => { throw new Error("original failure"); }, () => { throw new Error("page closed"); }), Error, "original failure");
});
