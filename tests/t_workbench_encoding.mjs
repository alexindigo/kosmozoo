import { assertEquals } from "jsr:@std/assert";
import { createRequire } from "node:module";
const { cardExpression } = createRequire(import.meta.url)("./e2e/workbench.e2e.cjs");

Deno.test("workbench browser probes preserve arbitrary filenames as data", () => {
  const names = ["ordinary.png", "a'b.png", 'a"b.png', "folder/[odd]\\file.png", "');globalThis.probeInjected=true;//.png"];
  try {
    for (const name of names) {
      const card = { dataset: { name } };
      const document = {
        querySelectorAll: selector => { assertEquals(selector, ".card"); return [{ dataset: { name: "other.png" } }, card]; },
        querySelector: selector => { assertEquals(selector, `.card[data-name="${name}"]`); return card; },
      };
      assertEquals(new Function("document", `return ${cardExpression(name)}`)(document), card);
      assertEquals(globalThis.probeInjected, undefined);
    }
  } finally { delete globalThis.probeInjected; }
});
