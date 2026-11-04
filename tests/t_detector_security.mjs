import { assertEquals } from "jsr:@std/assert";
import { fileURLToPath } from "node:url";

let python = false;
try { python = new Deno.Command("python3", { args: ["--version"], stdout: "null", stderr: "null" }).outputSync().success; } catch { /* optional plugin runtime */ }
Deno.test({
  name: "detector security: absolute upload deadline, bounded threads and decoder budget",
  ignore: !python,
  fn: async () => {
    const result = await new Deno.Command("python3", {
      args: [fileURLToPath(new URL("../plugins/detector/test_security.py", import.meta.url))], stdout: "piped", stderr: "piped",
      env: { PYTHONDONTWRITEBYTECODE: "1" },
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  },
});
