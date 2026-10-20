/* jsdom check of the question-type and card-spacing pass: the Net Promoter type is gone
   from Studio and from the analysis code paths, the Word Pairs tile is the NPS tile, and
   every question card gets a real vertical rhythm instead of fields touching each other.
   Needs the server on :8000 and jsdom.
   node scripts/dom/studio_nps_and_spacing_test.js */
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
  const fire = (el, t) => el.dispatchEvent(new w.Event(t, { bubbles: true }));

  click($('[data-act="new"]')); await sleep(60);
  click($('[data-act="new-mode"][data-mode="scratch"]')); await sleep(60);
  click($('[data-act="new-create"]')); await sleep(1200);

  // ============================================================ 1. NPS is gone
  click($('[data-act="qadd"]')); await sleep(90);
  const tiles = $$("#st-modal .st-type").map(b => b.getAttribute("data-type"));
  const names = $$("#st-modal .st-type b").map(b => b.textContent.trim());
  check("the library no longer offers a Net Promoter tile", tiles.indexOf("nps") < 0, "tiles=" + tiles.join(","));
  check("no tile is labelled Net Promoter anywhere in the library", names.every(n => !/net promoter/i.test(n)), names.join(" | "));

  // open a question and read its Type dropdown: the type must be un-offerable there too
  click($$("#st-modal .st-type")[0]); await sleep(250);
  const sel = $("#f-type");
  const opts = [...sel.options].map(o => o.textContent.trim());
  const vals = [...sel.options].map(o => o.value);
  check("the Type dropdown has no Net Promoter option", vals.indexOf("nps") < 0, "values=" + vals.join(","));
  check("no dropdown option is labelled Net Promoter", opts.every(o => !/net promoter/i.test(o)), opts.join(" | "));

  // ============================================================ 2. Word Pairs is now NPS
  click($('[data-act="qadd"]')); await sleep(90);
  const wp = $$("#st-modal .st-type").find(b => b.getAttribute("data-type") === "semantic_diff");
  check("the semantic-differential tile is still there", !!wp);
  check("that tile is now labelled NPS", wp && /^NPS$/i.test(wp.querySelector("b").textContent.trim()),
    wp && wp.querySelector("b").textContent.trim());
  wp.click(); await sleep(350);
  const sdSel = $("#f-type");
  check("its Type dropdown entry reads NPS",
    [...sdSel.options].some(o => o.value === "semantic_diff" && /^NPS$/i.test(o.textContent.trim())),
    [...sdSel.options].filter(o => o.value === "semantic_diff").map(o => o.textContent).join("|"));

  // the engine is untouched, so a word-pair row still carries its two anchors
  check("the NPS tile keeps its row/anchor editing",
    $$('[data-wt="label"]').length >= 0 && !!$("#f-smin") && !!$("#f-smax"),
    "smin=" + !!$("#f-smin") + " smax=" + !!$("#f-smax"));
  const rowInputs = $$(".st-item input");
  check("rows are still editable, with left and right anchor fields",
    rowInputs.length >= 3, "inputs=" + rowInputs.length);

  // ============================================================ 3. the starter study is sound
  const cfg = JSON.parse(await get("/api/studio/study?slug=" + (w.location.hash || "").slice(1))).cfg;
  const types = (cfg.questions || []).map(q => q.type);
  check("a new study contains no nps question", types.indexOf("nps") < 0, types.join(","));
  check("the starter study still has four questions", types.length === 4, types.join(","));
  check("the third starter question is a Scale question, not a Net Promoter", types[2] === "slider", types[2]);

  // ============================================================ 4. the cards breathe
  // Read the served stylesheet and assert the spacing contract itself, so a future tidy-up
  // cannot quietly put the fields back on top of each other.
  const css = await get("/static/css/studio.css");
  const cdom = new JSDOM("<!doctype html><html><head><style>" + css + "</style></head><body></body></html>",
    { url: BASE + "/studio/", runScripts: "outside-only" });
  const sheet = cdom.window.document.styleSheets[0];
  // selectors can be authored as a group, so match against every part
  const rule = sel => {
    for (const r of sheet.cssRules) {
      const st = r.selectorText || "";
      if (st.split(",").map(x => x.trim()).indexOf(sel) >= 0) return r;
    }
    return null;
  };
  // this CSSOM keeps `gap` as the shorthand, so read the row value out of it
  const rowGap = sel => {
    const r = rule(sel); if (!r) return null;
    const g = r.style.gap || r.style.rowGap || r.style.getPropertyValue("row-gap") || "";
    return g.split(/\s+/)[0];
  };

  check(".st-grid2 has a real row gap (was 0)", parseFloat(rowGap(".st-grid2")) >= 14, rowGap(".st-grid2"));
  check(".st-grid3 has a real row gap (was 0)", parseFloat(rowGap(".st-grid3")) >= 14, rowGap(".st-grid3"));
  check(".st-grid4 has a real row gap (was 0)", parseFloat(rowGap(".st-grid4")) >= 14, rowGap(".st-grid4"));

  const fm = rule(".st-field");
  check(".st-field has room between stacked fields", parseFloat(fm.style.marginBottom) >= 14, fm.style.marginBottom);
  check("a field inside a grid does not add its own margin on top of the row gap",
    !!rule(".st-grid2>.st-field") && rule(".st-grid2>.st-field").style.marginBottom === "0px",
    rule(".st-grid2>.st-field") && rule(".st-grid2>.st-field").style.marginBottom);

  const items = rule(".st-items");
  check("answer-area rows are spaced apart (was 4px)", parseFloat(items.style.gap) >= 6, items.style.gap);

  const item = rule(".st-item");
  check("an answer row has padding on every side", parseFloat(item.style.paddingTop) >= 7 &&
    parseFloat(item.style.paddingLeft) >= 7, item.style.padding);

  const h4 = rule(".st-h4");
  check("section headers sit clear of what follows", parseFloat(h4.style.marginBottom) >= 10, h4.style.marginBottom);

  const idcol = rule(".st-ehead-idcol");
  check("ID and Title are no longer stacked 6px apart", parseFloat(idcol.style.gap) >= 8, idcol.style.gap);

  const body = rule(".st-ecard-body");
  check("a card body has room below its own divider", parseFloat(body.style.paddingBottom) >= 18, body.style.padding);

  check("the narrow-window breakpoint drops the wide grids to two-up",
    /\.st-grid3,\s*\.st-grid4\{grid-template-columns:1fr 1fr\}/.test(css) &&
    /@media \(max-width:1180px\)/.test(css));

  // and the card actually still renders with those rules in place
  const cards = $$(".st-ecard");
  check("the question still renders its editor cards", cards.length >= 4, "cards=" + cards.length);
  check("every card has a header and a body", cards.every(c => c.querySelector("summary") && c.querySelector(".st-ecard-body")));
  check("the answer card still shows the scale fields",
    !!cards.find(c => /Scale|Rows/.test(c.querySelector("summary").textContent)));

  console.log(fails ? "\n" + fails + " FAILED" : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
