// ui-audit.cjs — read-only audit of the outgoing Python UI (port 2084).
// Screenshots + a structured inventory of every interactive element, so the
// rewrite keeps the iterated functionality instead of rediscovering it.

const { CDP, sleep } = require("/work/tests/e2e/cdp.cjs");
const { writeFileSync } = require("node:fs");

const OUT = "/audit";
const BASE = "http://127.0.0.1:2084";

async function shot(page, name) {
  const r = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
  console.log("shot:", name);
}

const INVENTORY_JS = `(() => {
  const seen = new Set();
  const items = [];
  const add = (where, el) => {
    const key = where + "|" + (el.id || el.textContent.trim().slice(0, 30));
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      where,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      text: el.textContent.trim().replace(/\\s+/g, " ").slice(0, 60),
      title: el.getAttribute("title") || null,
      type: el.getAttribute("type") || null,
      hidden: el.hidden || el.offsetParent === null,
      cls: (el.className || "").toString().slice(0, 60) || null,
    });
  };
  document.querySelectorAll("header button, header input, header select, header a, header [id]")
    .forEach((el) => add("header", el));
  document.querySelectorAll("#menu *, #hostDrop *")
    .forEach((el) => { if (/^(button|input|select|a|label)$/.test(el.tagName.toLowerCase())) add("menu", el); });
  document.querySelectorAll("#lightbox button, #lightbox input, #lightbox select, #lightbox [id]")
    .forEach((el) => add("lightbox", el));
  return items;
})()`;

(async () => {
  const page = await CDP.launch(9334);
  await page.send("Emulation.setDeviceMetricsOverride",
    { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
  await page.goto(BASE + "/");
  await page.poll("document.querySelectorAll('.card').length > 10", 30000);
  await sleep(1500);
  await shot(page, "01-grid");

  // header inventory (collapsed state)
  const invHeader = await page.evaluate(INVENTORY_JS);
  require("node:fs").writeFileSync(`${OUT}/inventory-header.json`, JSON.stringify(invHeader, null, 2));

  // host dropdown open
  await page.evaluate("document.getElementById('hostBtn').click(), true");
  await sleep(300);
  await shot(page, "02-host-dropdown");

  // close it, open the ☰ menu
  await page.evaluate("document.body.click(), true");
  await sleep(200);
  await page.evaluate("document.getElementById('menuBtn').click(), true");
  await sleep(300);
  await shot(page, "03-menu");

  const invMenu = await page.evaluate(INVENTORY_JS);
  require("node:fs").writeFileSync(`${OUT}/inventory-menu.json`, JSON.stringify(invMenu, null, 2));

  // close menu, open the lightbox on the first card
  await page.evaluate("document.body.click(), true");
  await sleep(200);
  await page.evaluate("document.querySelector('.card').click(), true");
  await sleep(1200);
  await shot(page, "04-lightbox");

  const invLb = await page.evaluate(INVENTORY_JS);
  require("node:fs").writeFileSync(`${OUT}/inventory-lightbox.json`, JSON.stringify(invLb, null, 2));

  await page.close();
  console.log("audit done");
})().catch((e) => { console.error("audit fail:", e); process.exit(1); });
