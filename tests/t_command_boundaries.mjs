// Executable-source/import-edge checks using the existing locked Babel parser.
// API reference: babel-parser/src/index.ts parse(input, {sourceType, plugins}).
import { parse } from "https://esm.sh/@babel/parser@7.29.8/es2022/parser.mjs";
import { assert, assertEquals } from "jsr:@std/assert";

const mechanical = new Set([
  "actions.images.fillSize", "actions.diff.resolve", "actions.current.linkUrl",
  "actions.views.get", "actions.views.set", "actions.anchors.setPaneWidth",
  "actions.ui.setResizing", "actions.ui.info.split.set", "actions.status.dismiss",
  "actions.notes.setDraft", "actions.notes.flushDraft", "actions.menu.setFilter",
  "actions.keys.pushLayer", "actions.keys.setFilter", "actions.keys.startCapture",
  "actions.keys.resetOne", "actions.keys.resetAll", "actions.feed.register",
  "actions.feed.scrolled", "actions.feed.compensating",
  "actions.variations.registerOwner", "actions.variations.services.probe",
  "actions.variations.services.inputList", "actions.variations.services.uploadInput",
  "actions.variations.services.run",
]);
const nodes = (node, visit) => {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "comments", "tokens"].includes(key)) continue;
    if (Array.isArray(value)) for (const child of value) nodes(child, visit);
    else if (value && typeof value === "object") nodes(value, visit);
  }
};
function audit(source) {
  const ast = parse(source, { sourceType: "module", plugins: ["jsx"] });
  const aliases = new Map(), errors = [], imports = [];
  const path = (node) => {
    if (!node) return null;
    if (node.type === "Identifier") return aliases.get(node.name) ?? node.name;
    if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)) {
      const root = path(node.object);
      const property = node.computed ? node.property.type === "StringLiteral" ? node.property.value : "*" : node.property.name;
      return root ? `${root}.${property}` : null;
    }
    return null;
  };
  const bind = (pattern, value) => {
    if (!value) return;
    if (pattern.type === "Identifier") aliases.set(pattern.name, value);
    if (pattern.type === "ObjectPattern") for (const property of pattern.properties) {
      if (property.type === "ObjectProperty") bind(property.value, `${value}.${property.key.name ?? property.key.value}`);
      else errors.push("rest destructuring can expose operations");
    }
  };
  // Fixed point resolves chained aliases/destructuring independent of declaration order.
  for (let pass = 0; pass < 4; pass++) nodes(ast, (node) => {
    if (node.type === "VariableDeclarator") bind(node.id, path(node.init));
  });
  nodes(ast, (node) => {
    if (node.type === "ImportDeclaration") imports.push(node.source.value);
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = path(node.callee);
      if (callee?.includes(".actions.")) {
        const port = callee.slice(callee.indexOf(".actions.") + 1);
        if (!mechanical.has(port)) errors.push(`covered operation: ${port}`);
      }
      if (callee === "fetch" || callee?.endsWith(".fetch")) errors.push("input consumer calls transport");
      if (callee?.endsWith(".handles.register") || callee?.endsWith(".handles.registerOwned")) errors.push("input consumer defines an executor");
    }
    if (["AssignmentExpression", "UpdateExpression"].includes(node.type)) {
      const target = path(node.left ?? node.argument);
      if (target?.includes(".state.")) errors.push("input consumer writes model state");
    }
    if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      const value = path(node);
      if (value?.includes(".actions.")) {
        const port = value.slice(value.indexOf(".actions.") + 1);
        const prefix = [...mechanical].some((allowed) => allowed === port || allowed.startsWith(`${port}.`));
        if (!prefix) errors.push(`exposed operation reference: ${port}`);
      }
    }
    if (node.type === "JSXOpeningElement" && node.name.name === "a" && node.attributes.some((attribute) => attribute.name?.name === "download")) {
      if (!node.attributes.some((attribute) => attribute.name?.name === "onClick")) errors.push("native command resource bypasses handle");
    }
  });
  for (const name of imports) if (/\/(api|judgments|core-commands|command-handles|session)\.(?:js|mjs)$/.test(name)) errors.push(`input imports private layer: ${name}`);
  return { errors: [...new Set(errors)], imports, ast };
}

Deno.test("boundaries: parser recognizes aliases, destructuring, computed calls and native resource bypass", () => {
  assert(audit(`const a = store.actions; const { diff: d } = a; const { setMode: run } = d; run('split');`).errors.length);
  assert(audit(`const a = store.actions; a['judgments']['dispatch']('id', {});`).errors.length);
  assert(audit(`const { judgments } = store.actions; judgments[key]();`).errors.length);
  assert(audit(`const fn=store.actions.diff.close; fn();`).errors.length);
  assert(audit(`import { api } from '/js/api.mjs'; api.deleteEntry('h','file');`).errors.length);
  assert(audit(`const link=<a download href="/feedback.json">download</a>;`).errors.length);
  assertEquals(audit(`store.handles.invoke('workbench.mode',{mode:'split'}); store.actions.views.set('id', view);`).errors, []);
});

Deno.test("boundaries: all input consumers use handles or classified mechanical/editor ports", async () => {
  for await (const file of Deno.readDir("client-solid/components")) {
    if (!file.name.endsWith(".tsx")) continue;
    const source = await Deno.readTextFile(`client-solid/components/${file.name}`);
    assertEquals(audit(source).errors, [], file.name);
  }
  for (const file of ["VariationsModal.tsx", "SliderRow.tsx", "VariationDiscardConfirmation.tsx"]) {
    assertEquals(audit(await Deno.readTextFile(`client-solid/features/variations/${file}`)).errors, [], file);
  }
});

Deno.test("boundaries: command modules never import input/UI, registry never exposes executor", async () => {
  for (const name of ["command-handles.js", "core-commands.js"]) {
    const source = await Deno.readTextFile(`client-solid/store/${name}`);
    const ast = parse(source, { sourceType: "module" });
    nodes(ast, (node) => {
      if (node.type === "ImportDeclaration") assert(!/(components|main|key-bindings|input-policy|keys\.mjs|instance)/.test(node.source.value), name);
      if (node.type === "MemberExpression" && node.object.type === "MemberExpression" && node.object.property.name === "variations")
        assert(["open", "key", "images", "session"].includes(node.property.name), `${name}: modal private read`);
    });
  }
  for (const name of ["commands.js", "session.js", "draft.js"]) {
    const ast = parse(await Deno.readTextFile(`client-solid/features/variations/${name}`), { sourceType: "module" });
    nodes(ast, (node) => {
      if (node.type === "ImportDeclaration") assert(!/(components|Modal|SliderRow|index|api|key-bindings|keys\.mjs|instance)/.test(node.source.value), name);
    });
  }
  const source = await Deno.readTextFile("client/js/keys.mjs");
  const ast = parse(source, { sourceType: "module" });
  nodes(ast, (node) => {
    assert(node.type !== "ImportDeclaration", "key library imports application layer");
    if (node.type === "MemberExpression") assert(!["fn", "when", "execute"].includes(node.property.name), "binding execution escape hatch");
  });
  const defaults = parse(await Deno.readTextFile("client-solid/store/key-bindings.js"), { sourceType: "module" });
  nodes(defaults, (node) => {
    if (node.type === "ObjectProperty") assert(!["fn", "when", "execute"].includes(node.key.name), "default callback binding");
  });
});
