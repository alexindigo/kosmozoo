import { assertEquals } from "jsr:@std/assert";

let python = false;
try { python = new Deno.Command("python3", { args: ["--version"], stdout: "null", stderr: "null" }).outputSync().success; } catch { /* optional plugin runtime */ }
Deno.test({
  name: "detector security: absolute upload deadline, bounded threads and decoder budget",
  ignore: !python,
  fn: async () => {
    const result = await new Deno.Command("python3", {
      args: [new URL("../plugins/detector/test_security.py", import.meta.url).pathname], stdout: "piped", stderr: "piped",
      env: { PYTHONDONTWRITEBYTECODE: "1" },
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  },
});
