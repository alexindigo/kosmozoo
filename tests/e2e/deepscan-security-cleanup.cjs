// Failure injection at resource acquisition/teardown, without a browser dependency.
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { test } = require("node:test");
const exec = promisify(execFile);

for (const failure of ["launch", "close", "existing"]) {
  const name = failure === "existing" ? "security fixture preserves a pre-existing read-only SVG before browser startup"
    : `security fixture releases listener and SVG after ${failure} failure`;
  test(name, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kz-security-cleanup-"));
    const fixture = path.join(directory, "deepscan.svg");
    const original = '<svg xmlns="http://www.w3.org/2000/svg"><!-- original read-only fixture --></svg>';
    const engine = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
    try {
      if (failure === "existing") {
        await fs.writeFile(fixture, original);
        await fs.chmod(fixture, 0o444);
      }
      await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
      const bootstrap = `
        const { CDP } = require(${JSON.stringify(require.resolve("./cdp.cjs"))});
        CDP.launch = async () => {
          ${failure === "existing" ? 'throw new Error("browser startup must not be reached");' : failure === "launch" ? 'throw new Error("injected launch failure");' : 'return { close: async () => { throw new Error("injected close failure"); } };'}
        };
        require(${JSON.stringify(require.resolve("./deepscan-security.cjs"))});
      `;
      let result;
      try {
        await exec(process.execPath, ["-e", bootstrap], {
          env: { ...process.env, E2E_ENGINE: `http://127.0.0.1:${engine.address().port}`, E2E_SECURITY_DIR: directory },
          timeout: 3000,
        });
        assert.fail("injected failure unexpectedly succeeded");
      } catch (error) { result = error; }
      const retained = await fs.readFile(fixture, "utf8").catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const probe = http.createServer();
      try {
        await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(19163, "127.0.0.1", resolve); });
      } finally { await new Promise(resolve => probe.close(resolve)); }
      assert.equal(result.killed, false, "fixture must exit on its own, without timeout termination");
      assert.equal(result.code, 1);
      if (failure === "existing") {
        assert.equal(retained, original, "pre-existing SVG bytes and file must survive failed acquisition");
        assert.equal((await fs.stat(fixture)).mode & 0o777, 0o444);
        assert.match(result.stderr, /EEXIST/);
        assert.doesNotMatch(result.stderr, /browser startup must not be reached/);
      } else {
        assert.match(result.stderr, new RegExp(`injected ${failure} failure`));
        assert.equal(retained, null, "owned SVG must be removed even when browser startup/close fails");
      }
    } finally {
      await new Promise(resolve => engine.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
