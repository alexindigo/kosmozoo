import { assert, assertEquals } from "jsr:@std/assert";

const script = new URL("../dev/check-release-version.sh", import.meta.url);

async function check(version, tag) {
  const root = await Deno.makeTempDir({ prefix: "kz-release-version-" });
  try {
    await Deno.mkdir(`${root}/dev`);
    await Deno.copyFile(script, `${root}/dev/check-release-version.sh`);
    await Deno.writeTextFile(`${root}/VERSION`, version);
    const result = await new Deno.Command("bash", {
      args: [`${root}/dev/check-release-version.sh`, tag], stdout: "piped", stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    return { code: result.code, output: decoder.decode(result.stdout) + decoder.decode(result.stderr) };
  } finally { await Deno.remove(root, { recursive: true }); }
}

Deno.test("release version: a tag equal to v + VERSION passes", async () => {
  assertEquals((await check("0.2.0\n", "v0.2.0")).code, 0);
});

Deno.test("release version: mismatch fails and names both versions", async () => {
  const result = await check("0.2.0\n", "v0.2.1");
  assertEquals(result.code, 1);
  assert(result.output.includes("v0.2.1") && result.output.includes("0.2.0"), result.output);
});

Deno.test("release version: a tag without the v prefix fails", async () => {
  assertEquals((await check("0.2.0\n", "0.2.0")).code, 1);
});
