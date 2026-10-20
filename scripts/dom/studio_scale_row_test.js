/* jsdom check of the scale-point editor row - the densest row in the Studio question card.
   It is a six-column table (# | value | label | format | media | actions) inside a pane that
   can be under 500px wide, so every fixed track has to be sized for what actually sits in it.
   Also guards the glyph escapes: a doubled backslash in a JS string literal puts the literal
   text "\u25B2" into the DOM instead of the character, which is exactly the kind of thing that
   quietly turns an icon into twelve characters of escape text.
   Needs the server on :8000 and jsdom.
   node scripts/dom/studio_scale_row_test.js */
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch (e) { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
const http = require("http"); const BASE = process.env.BASE || "http://127.0.0.1:8000";
function req(method, p, body, ctype) {
  return new Promise((res, rej) => {
    const u = new URL(BASE + p); const h = {};
    if (body) h["Content-Type"] = ctype || "application/json";
    const r = http.request(u, { method, headers: h }, x => { let d = ""; x.on("data", c => d += c); x.on("end", () => res({ status: x.statusCode, body: d })); });
    r.on("error", rej); if (body) r.write(body); r.end();
  });
}
const get = p => req("GET", p).then(r => r.body);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (l, c, d = "") => { console.log((c ? "PASS  " : "FAIL  ") + l + (c ? "" : "  -> " + d)); if (!c) fails++; };

(async () => {
  const dom = new JSDOM(await get("/studio/"), { url: BASE + "/studio/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {}; w.requestAnimationFrame = f => setTimeout(f, 0);
  w.Element.prototype.scrollIntoView = function () {};
  w.confirm = () => true; w.BEACON_PREVIEW_MODE = true;
  w.fetch = (u, o) => { const U = new URL(u, BASE); const h = {}; if (o && o.body) h["Content-Type"] = "application/json";
    return req((o && o.method) || "GET", U.pathname + U.search, o && o.body, h["Content-Type"]).then(x => ({ ok: x.status < 400, status: x.status, json: () => Promise.resolve(JSON.parse(x.body)) })); };
  for (const f of ["qlogic.js", "survey.js", "explainer.js", "studio.js"]) w.eval(await get("/static/js/" + f));
  await sleep(900);
  const d = w.document, $ = s => d.querySelector(s), $$ = s => [...d.querySelectorAll(s)];
  const click = el => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));

  click($('[data-act="new"]')); await sleep(60);
  click($('[data-act="new-mode"][data-mode="scratch"]')); await sleep(60);
  click($('[data-act="new-create"]')); await sleep(1200);
  click($('[data-act="qadd"]')); await sleep(90);
  // the NPS (word-pairs) tile drives a scale, so it exercises the scale-point editor
  $$("#st-modal .st-type").find(b => b.getAttribute("data-type") === "semantic_diff").click(); await sleep(500);

  const rows = $$(".st-pts .st-item");
  const row = rows[1];
  check("the scale-point editor renders a header plus data rows", rows.length >= 3, "rows=" + rows.length);
  const cells = [...row.children];
  check("a scale-point row has six cells", cells.length === 6, "got " + cells.length);
  const [seq, val, label, fmt, media, tools] = cells;

  // ---------------------------------------------------------------- glyphs, not escape text
  const text = row.textContent;
  const leaks = [...text.matchAll(/\\u[0-9A-Fa-f]{4}/g)].map(m => m[0]);
  check("no literal \\uXXXX escape text is left in the row", leaks.length === 0, leaks.join(" "));
  check("the reorder buttons carry real glyphs",
    /\u25B2/.test(tools.textContent) && /\u25BC/.test(tools.textContent), JSON.stringify(tools.textContent));
  check("the delete button carries a real glyph", /\uD83D\uDDD1/.test(tools.textContent), JSON.stringify(tools.textContent));
  check("the duplicate button carries a real glyph", /\u2398/.test(tools.textContent));

  // and the same across the whole editor pane, since the escapes were spread over several cards
  const pane = $("#st-editor").textContent;
  const paneLeaks = [...pane.matchAll(/\\u[0-9A-Fa-f]{4}/g)].map(m => m[0]);
  check("no escape text anywhere in the question editor", paneLeaks.length === 0, [...new Set(paneLeaks)].join(" "));

  // ---------------------------------------------------------------- the attach control
  check("the media cell is itself the attach control", !!media.matches && media.matches("label.st-ibtn-media"),
    media.tagName + "." + media.className);
  check("the attach control is an SVG paperclip, not an emoji", !!media.querySelector("svg.st-ic-svg path"),
    (media.querySelector("svg") || { outerHTML: "" }).outerHTML.slice(0, 60));
  const file = media.querySelector('input[type=file]');
  check("the attach control still hides its file input", !!file && file.hidden);
  check("the attach control keeps its file input wired for this row",
    !!file && file.getAttribute("data-act") === "it-media" && file.getAttribute("data-i") === "0",
    file && file.outerHTML);

  // ---------------------------------------------------------------- the header
  const heads = [...$$(".st-pts .st-item-head")[0].children].map(c => c.textContent.trim());
  check("the header reads Media, not the word that could not fit in the track",
    heads.indexOf("Media") >= 0 && heads.indexOf("Attachment") < 0, heads.join(" | "));

  // ---------------------------------------------------------------- the layout contract
  const css = await get("/static/css/studio.css");
  const cdom = new JSDOM("<!doctype html><html><head><style>" + css + "</style></head><body></body></html>",
    { url: BASE, runScripts: "outside-only" });
  const sheet = cdom.window.document.styleSheets[0];
  const rule = sel => {
    for (const r of sheet.cssRules) {
      const st = r.selectorText || "";
      if (st.split(",").map(x => x.trim()).indexOf(sel) >= 0) return r;
    }
    return null;
  };
  const r = rule(".st-pts .st-item");
  const cols = (r.style.gridTemplateColumns || "").split(/\s+/);
  check("the row declares six tracks", cols.length === 6, JSON.stringify(cols));
  check("the label track is minmax(0,1fr), so the row always shrinks to the pane",
    /minmax\(0,1fr\)/.test(cols[2]), cols[2]);
  check("the media track is wide enough for a 30px thumbnail plus its remove button",
    parseFloat(cols[4]) >= 56, cols[4]);
  check("the actions track stays flexible, so it is never clipped off the edge", cols[5] === "auto", cols[5]);
  check("the media cell is centred in its own track",
    !!rule(".st-pts .st-item>.st-thumb") && rule(".st-pts .st-item>.st-thumb").style.justifySelf === "center");
  const toolsRule = rule(".st-item-tools");
  check("action buttons are no longer 1px apart", parseFloat(toolsRule.style.gap) >= 2, toolsRule.style.gap);
  check("a narrow-pane rule trims the fixed tracks so nothing is clipped",
    /\.st-pts \.st-item\{grid-template-columns:18px 28px/.test(css));

  // the thumbnail's remove button overhangs its box on purpose; the track has to absorb it
  const x = rule(".st-thumb .st-x");
  check("the remove button overhangs the thumbnail by less than the track can absorb",
    parseFloat(x.style.right) <= 8, x.style.right);

  // ---------------------------------------------------------------- the options / rows card
  // The same six-control problem lives on the options / rows / columns table, where the
  // attach button, the format select and the four row actions all shared one flex row.
  // the newly added question takes the slot after Q1, so find the Grid by its id
  const qi = $$(".st-qi").find(r => /Q2/.test(r.textContent));
  check("the starter study still has its Grid question", !!qi,
    $$(".st-qi").map(r => r.textContent.trim().slice(0, 6)).join(" | "));
  click(qi); await sleep(800);
  check("the Grid is the selected question", ($("#f-type") || {}).value === "rating_grid",
    ($("#f-type") || {}).value);
  const gridRow = $$(".st-items .st-item").find(r => !r.classList.contains("st-item-head"));
  check("a grid row renders", !!gridRow);
  if (gridRow) {
    const gTools = gridRow.querySelector(".st-item-tools");
    const kids = [...gTools.children];
    check("the row actions are grouped apart from the attach and format controls",
      kids.some(k => k.classList && k.classList.contains("st-item-acts")),
      kids.map(k => (k.className || k.tagName).toString().split(" ")[0]).join(" | "));
    check("the attach control inside the group still carries the SVG",
      !!gTools.querySelector("svg.st-ic-svg"), gTools.innerHTML.slice(0, 70));
    const del = gTools.querySelector("[data-act=it-del]");
    check("the delete button is still reachable by its data-act from inside the group", !!del);
    check("no escape text on the grid row either",
      !/\\u[0-9A-Fa-f]{4}/.test(gridRow.textContent), gridRow.textContent.slice(0, 60));
  }
  const acts = rule(".st-item-acts");
  check("the action group has its own spacing and a separator",
    !!acts && parseFloat(acts.style.marginLeft) >= 6 && !!acts.style.borderLeft,
    acts && (acts.style.marginLeft + " / " + acts.style.borderLeft));

  console.log(fails ? "\n" + fails + " FAILED" : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
