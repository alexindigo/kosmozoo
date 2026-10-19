// Build-time global resources only. Never invokes the self-installer.
import { writePackageResources } from "../../src/desktop/package-resources.mjs";
import { resolve } from "node:path";

const [output] = Deno.args;
if (!output || Deno.args.length !== 1) throw new Error("Supply one fresh global resource output directory");
await Deno.mkdir(output, { mode: 0o700 });
await writePackageResources({ prefix: "/usr", destdir: resolve(output) });
