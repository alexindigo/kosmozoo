// Run in the identified release VM with the pinned Deno/native selection.
import { Database } from "@db/sqlite";

// Extract only the pinned binding's literal ForeignLibraryInterface. This
// observes every declared symbol without bypassing the project import lock or
// importing a non-exported package URL as a new unpinned dependency.
const sourceFile = Deno.args[1];
if (!sourceFile) throw new Error("Supply the exact pinned ffi.ts source witness");
const source = (await Deno.readTextFile(sourceFile)).split("\n// denoCacheMetadata=")[0];
const sourceHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))), value => value.toString(16).padStart(2, "0")).join("");
if (sourceHash !== "27fbb2d6975bb9bd15742d48d8a6500ad57d8dda12e2e1538a452090358a6a0a") throw new Error("Binding interface source is not the locked0.13.0 input");
const begin = source.indexOf("const symbols = ") + "const symbols = ".length;
const end = source.indexOf(" as const satisfies Deno.ForeignLibraryInterface;");
if (begin < "const symbols = ".length || end < begin) throw new Error("Pinned interface boundary missing");
const symbols = Function("return (" + source.slice(begin, end) + ");")();
const library = Deno.dlopen(Deno.env.get("DENO_SQLITE_PATH"), symbols);
const ffi = library.symbols;
const names = Object.keys(ffi).sort();
if (!names.length || names.some(name => !name.startsWith("sqlite3_"))) throw new Error("Unknown binding interface");
for (const name of names) {
  if (ffi[name] !== null && typeof ffi[name] !== "function") throw new Error(`Invalid native symbol: ${name}`);
}
const version = new Deno.UnsafePointerView(ffi.sqlite3_libversion()).getCString();
const sourceId = new Deno.UnsafePointerView(ffi.sqlite3_sourceid()).getCString();
if (version !== "3.40.1") throw new Error("Pinned library version mismatch: " + version);
const path = Deno.args[0];
if (!path) throw new Error("Supply a private disposable database path");
const db = new Database(path);
try {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE child(id INTEGER REFERENCES parent(id));");
  db.prepare("INSERT INTO parent(value) VALUES(?)").run("actual pinned FFI consumer");
  db.exec("INSERT INTO child VALUES(1)");
  const row = db.prepare("SELECT value FROM parent JOIN child USING(id)").get();
  if (row.value !== "actual pinned FFI consumer") throw new Error("Pinned FFI read/write result missing");
  if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") throw new Error("Actual WAL mode absent");
} finally { db.close(); }
const reopened = new Database(path);
try {
  if (reopened.prepare("SELECT value FROM parent JOIN child USING(id)").get().value !== "actual pinned FFI consumer") throw new Error("Native reopen did not retain data");
  if (reopened.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" || reopened.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Native storage integrity failed");
} finally { reopened.close(); }
console.log(JSON.stringify({ version, sourceId, symbols: names, optionalMissing: names.filter(name => ffi[name] === null), wal: true, reopened: true, integrity: "ok" }, null, 2));
library.close();
