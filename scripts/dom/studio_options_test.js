/* jsdom check that bold / italic / underline / font colour / highlight are available when
   authoring answer option labels, and that they work for every question type that has an
   option, row or column list - single_select, multi_select, rating_grid, text_grid, rank,
   emoji_grid, numeric_matrix, semantic_diff, sum_to_100.
   Also pins the contract that makes this safe: the plain `label` is kept in step, so exports,
   TTS, piping, screening and the admin dashboard keep seeing exactly the text they saw before.
   Needs the server on :8000 and jsdom.
   node scripts/dom/studio_options_test.js */
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch (e) { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
const http = require("http"); const BASE = process.env.BASE || "http://127.0.0.1:8000";
function req(method, p, body) { return new Promise((res, rej) => {
    const u = new URL(BASE + p); const h = {}; if (body) h["Content-Type"] = "application/json";
    const r = http.request(u, { method, headers: h }, x => { let d = ""; x.on("data", c => d += c); x.on("end", () => res({ status: x.statusCode, body: d })); });
    r.on("error", rej); if (body) r.write(body); r.end(); }); }
const get = p => req("GET", p).then(r => r.body);
let fails = 0;
const check = (l, c, d = "") => { console.log((c ? "PASS  " : ">>>---FAIL  ") + l + (c ? "" : "  -> " + d)); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// question types that carry an option / row / column list in the editor, and which list each uses
const SURFACES = [
  ["single_select", ["opt"]], ["multi_select", ["opt"]],
  ["rating_grid", ["row", "col"]], ["text_grid", ["row", "col"]], ["rank", ["row"]],
  ["emoji_grid", ["row"]], ["numeric_matrix", ["row", "col"]], ["semantic_diff", ["row"]],
  ["sum_to_100", ["row"]], ["rating_scale", ["row"]],
];
const KIND_NAME = { opt: "answer option", row: "row", col: "column", pt: "scale point" };

(async () => {
  const questions = SURFACES.map(([type, kinds], i) => Object.assign({
    id: "Q" + (i + 1), section: "S1", type, stem: type + " stem",
    options: kinds.includes("opt") ? [{ code: "1", label: "Option A" }, { code: "2", label: "Option B" }] : undefined,
    rows: kinds.includes("row") ? [{ code: "r1", label: "Row one" }, { code: "r2", label: "Row two" }] : undefined,
    cols: kinds.includes("col") ? [{ code: "c1", label: "Col one" }, { code: "c2", label: "Col two" }] : undefined,
  }));
  questions.forEach(q => { ["options", "rows", "cols"].forEach(k => { if (q[k] === undefined) delete q[k]; }); });
  const cfg = { sections: [{ id: "S1", title: "Main" }], questions, tpp: {}, explainer_scenes: [] };
  const slug = JSON.parse((await req("POST", "/api/studio/save", JSON.stringify({ title: "Option formatting", cfg }))).body).slug;

  const dom = new JSDOM(await get("/studio/"), { url: BASE + "/studio/#" + slug, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window, doc = w.document;
  w.BEACON_PREVIEW_MODE = true; w.requestAnimationFrame = fn => setTimeout(fn, 0);
  w.scrollTo = () => {}; w.Element.prototype.scrollIntoView = function () {}; w.confirm = () => true;
  w.fetch = (u, o) => { const U = new URL(u, BASE); return req((o && o.method) || "GET", U.pathname + U.search, o && o.body)
      .then(x => ({ ok: x.status < 400, status: x.status, json: () => Promise.resolve(JSON.parse(x.body)) })); };
  w.document.execCommand = () => false;            // jsdom has no execCommand at all
  const errs = []; w.addEventListener("error", e => errs.push(e.message));
  for (const f of ["qlogic.js", "survey.js", "explainer.js", "studio.js"]) w.eval(await get("/static/js/" + f));
  await sleep(900);
  const $ = s => doc.querySelector(s), $$ = s => [...doc.querySelectorAll(s)];
  const click = el => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  const open = async id => { const qi = $$(".st-qi").find(n => { const t = n.querySelector(".st-qi-id"); return t && t.textContent === id; });
    if (!qi) throw new Error("no outline row " + id); qi.querySelector(".st-qi-id").click(); await sleep(280); };
  const saved = async () => JSON.parse(await get("/api/studio/study?slug=" + slug)).cfg;
  const rgb = h => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
    return m ? `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})` : h; };
  // the label of list entry `kind`/`i`
  const lab = (kind, i) => $(`[data-k=label_html][data-it="${kind}"][data-i="${i}"]`);
  // put the caret over a substring of a rich label, wherever the DOM has since re-wrapped it
  const pick = (host, sub) => { const walk = doc.createTreeWalker(host, 4), ns = [];
    while (walk.nextNode()) ns.push(walk.currentNode);
    for (const n of ns) { const i = n.nodeValue.indexOf(sub); if (i < 0) continue;
      const r = doc.createRange(); r.setStart(n, i); r.setEnd(n, i + sub.length);
      const s = w.getSelection(); s.removeAllRanges(); s.addRange(r); return true; }
    throw new Error("not found: " + sub); };
  const pickSwatch = title => { const c = $(".st-color-pop.open .st-color-cell[title='" + title + "']");
    if (!c) throw new Error("no swatch " + title); const hex = c.getAttribute("data-color"); click(c); return hex; };
  // the palette of this kind on this label, opened regardless of what is open already
  const openPalette = (kind, host, which) => {
    const want = `.st-color-pop[data-palette-for="${host.id}"][data-palette-kind="${kind}"]`;
    const cur = $(want + ".open");
    if (!cur) { click($(`.st-toolbar[data-for="${host.id}"] [data-color-trigger="${kind}"]`)); }
    const p = $(want + ".open");
    if (!p) throw new Error("palette " + which + " did not open");
    return p; };

  // ---------------- 1. the format strip exists on every option / row / column -------------
  let missing = [];
  for (const [type, kinds] of SURFACES) {
    await open("Q" + (SURFACES.findIndex(s => s[0] === type) + 1));
    for (const kind of kinds) for (const i of [0, 1]) {
      const host = lab(kind, i);
      if (!host) { missing.push(type + "/" + kind + "/" + i); continue; }
      const tb = $(`.st-toolbar[data-for="${host.id}"]`);
      if (!tb || !tb.classList.contains("st-toolbar-mini")) { missing.push(type + "/" + kind + "/" + i + " toolbar"); continue; }
      for (const cmd of ["bold", "italic", "underline", "removeFormat"])
        if (!$(`.st-toolbar[data-for="${host.id}"] .st-tb[data-cmd="${cmd}"]`)) missing.push(type + "/" + kind + "/" + i + "/" + cmd);
      for (const k of ["foreColor", "hiliteColor"])
        if (!$(`.st-toolbar[data-for="${host.id}"] [data-color-trigger="${k}"]`)) missing.push(type + "/" + kind + "/" + i + "/" + k);
    }
  }
  check("every answer option / row / column label has bold, italic, underline, font colour, highlight and clear",
    !missing.length, missing.join(", "));

  // ---------------- 2. each row has its OWN palette, keyed to its own label ----------------
  await open("Q1");
  const a0 = lab("opt", 0), a1 = lab("opt", 1);

  // ---------------- 1b. the palette's containing block is its own toolbar -----------------
  const cssText = await get("/static/css/studio.css");
  check("the toolbar is the palette's positioning context",
    /\.st-toolbar\{[^}]*position:\s*relative/.test(cssText.replace(/\n/g, " ")),
    "no position:relative on .st-toolbar");
  openPalette("foreColor", a0, "option 1");
  check("an option's palette lives inside that option's own toolbar",
    $('.st-toolbar[data-for="' + a0.id + '"]').contains($('.st-color-pop[data-palette-for="' + a0.id + '"]')),
    $('.st-color-pop[data-palette-for="' + a0.id + '"]').parentElement.className);

  openPalette("foreColor", a0, "option 1");
  check("the palette for option 1 is the only one open",
    $$(".st-color-pop.open").length === 1 &&
    $(".st-color-pop.open").getAttribute("data-palette-for") === a0.id &&
    $(".st-color-pop.open").getAttribute("data-palette-kind") === "foreColor");
  openPalette("foreColor", a1, "option 2");
  check("option 2 gets its own palette rather than reusing option 1's",
    $$(".st-color-pop.open").length === 1 && $(".st-color-pop.open").getAttribute("data-palette-for") === a1.id,
    $$(".st-color-pop.open").map(p => p.getAttribute("data-palette-for")).join(","));
  doc.body.click(); await sleep(60);

  // ---------------- 3. colouring two different options, each its own colour ----------------
  for (const [host, sub, name, hue] of [[a0, "Option", "Blue", 230], [a1, "Option", "Green", 120]]) {
    host.focus(); pick(host, sub);
    openPalette("foreColor", host, host.id);
    pickSwatch(hue === 230 ? "Blue" : "Green");
  }
  check("option 1 is blue and option 2 is green, independently",
    /color:\s*#(4472c4|0000ff)/i.test(a0.innerHTML) && /color:\s*#(70ad47|008000)/i.test(a1.innerHTML),
    a0.innerHTML + " | " + a1.innerHTML);
  await sleep(1400);                                   // autosave debounce is 1100ms
  let cfg2 = await saved();
  const s0 = cfg2.questions.find(q => q.id === "Q1").options;
  check("saving keeps label_html per option",
    !!s0[0].label_html && !!s0[1].label_html && s0[0].label_html !== s0[1].label_html,
    JSON.stringify(s0));
  check("the plain label is still there and still plain for every option",
    s0.every(o => typeof o.label === "string" && !/[<>]/.test(o.label) && o.label.trim().length),
    JSON.stringify(s0.map(o => o.label)));

  // ---------------- 4. bold / italic / underline on an option label ------------------------
  // jsdom has no execCommand at all, so record which commands the buttons issue rather than the
  // markup they would produce (the palette suite covers the colour path end to end).
  await open("Q1");
  const b0 = lab("opt", 0);
  const issued = [];
  w.document.execCommand = c => { if (c !== "styleWithCSS") issued.push(c); return false; };
  b0.focus(); pick(b0, "Option");
  for (const cmd of ["bold", "italic", "underline"]) click($(`.st-toolbar[data-for="${b0.id}"] .st-tb[data-cmd="${cmd}"]`));
  check("bold, italic and underline are issued against the option label's selection",
    issued.join(",") === "bold,italic,underline", issued.join(","));
  // ...and the model keeps the plain label when the author only pressed formatting
  b0.innerHTML = "<b>Option</b> A";
  b0.dispatchEvent(new w.Event("input", { bubbles: true }));
  await sleep(1400);
  cfg2 = await saved();
  const bolded = cfg2.questions.find(q => q.id === "Q1").options[0];
  check("a formatted option survives the round trip with both fields",
    !!bolded.label_html && /<b>/i.test(bolded.label_html) && bolded.label === "Option A",
    JSON.stringify(bolded));
  check("the stored label_html is sanitised - no script tag, no event handler",
    !/script|onclick/i.test(bolded.label_html), bolded.label_html);

  // ---------------- 5. highlight, then clear it without touching the colour ----------------
  await open("Q1");
  const h0 = lab("opt", 0);
  h0.focus(); pick(h0, "Option");
  openPalette("hiliteColor", h0, h0.id);
  const hl = $(".st-color-pop.open .st-color-cell").getAttribute("data-color");
  click($(".st-color-pop.open .st-color-cell"));
  check("the highlight palette paints the chosen background over the option label",
    new RegExp("background-color:\\s*" + hl, "i").test(h0.innerHTML), h0.innerHTML);
  check("the highlight leaves the author's own bold on the label alone",
    /<b>/.test(h0.innerHTML), h0.innerHTML);
  // "No colour" goes through the same strip path a real browser's removeFormat takes
  h0.focus(); pick(h0, "Option");
  openPalette("hiliteColor", h0, h0.id);
  click($(".st-color-pop.open .st-color-none"));
  await sleep(60);
  check("No colour takes the highlight off and leaves no empty span behind",
    !/background-color:\s*#/i.test(h0.innerHTML) && !/style=""/.test(h0.innerHTML) && /<b>/.test(h0.innerHTML),
    h0.innerHTML);

  // ---------------- 6. an empty label still empties the model ------------------------------
  await open("Q1");
  const e0 = lab("opt", 0);
  e0.innerHTML = "";
  e0.dispatchEvent(new w.Event("input", { bubbles: true }));
  await sleep(80);
  check("blanking a label empties the stored label, so the audit still fires",
    /blank/i.test(($(".st-check") || doc.body).textContent), "audit did not report a blank option");

  // ---------------- 6b. scale point labels (the columns of emoji_grid / semantic_diff) ---
  await open("Q8");                                   // emoji_grid - columns are scale points
  const pt0 = $('[data-pt="label"][data-i="0"]');
  check("an emoji grid's scale point label has the same format strip",
    !!pt0 && !!$('.st-toolbar[data-for="' + pt0.id + '"]') &&
    !!$('.st-toolbar[data-for="' + pt0.id + '"] .st-tb[data-cmd="bold"]') &&
    !!$('.st-toolbar[data-for="' + pt0.id + '"] [data-color-trigger="foreColor"]'), !!pt0);
  pt0.innerHTML = "Not at all"; pt0.dispatchEvent(new w.Event("input", { bubbles: true }));
  pt0.focus(); pick(pt0, "Not at all");
  openPalette("foreColor", pt0, "scale point 1");
  const ptHex = $(".st-color-pop.open .st-color-cell").getAttribute("data-color");
  click($(".st-color-pop.open .st-color-cell"));
  check("the scale point label is coloured",
    new RegExp("color:\\s*" + ptHex, "i").test(pt0.innerHTML), pt0.innerHTML);
  await sleep(1400);
  cfg2 = await saved();
  const sp = (cfg2.questions.find(q => q.id === "Q8").scale || {}).points || [];
  check("the formatted scale point round trips with label and label_html",
    sp.length && !/[<>]/.test(sp[0].label || "") && !!sp[0].label_html, JSON.stringify(sp));

  // ---------------- 7. the respondent sees the markup --------------------------------------
  await open("Q1");
  const r0 = lab("opt", 0);
  r0.innerHTML = "Plain A";
  r0.dispatchEvent(new w.Event("input", { bubbles: true }));
  await sleep(200);
  check("no error was thrown anywhere on the way", !errs.length, errs.join(" | "));
  check("all " + SURFACES.length + " question types opened without error", $$(".st-qi").length === SURFACES.length,
    $$(".st-qi").length + " outline rows");
  // the respondent side already prefers label_html - prove it reaches the preview
  await open("Q1");
  const r1 = lab("opt", 0);
  r1.innerHTML = "Coloured A";
  r1.dispatchEvent(new w.Event("input", { bubbles: true }));
  r1.focus(); pick(r1, "Coloured");
  openPalette("foreColor", r1, r1.id);
  const pvHex = $(".st-color-pop.open .st-color-cell").getAttribute("data-color");
  click($(".st-color-pop.open .st-color-cell"));
  await sleep(400);
  const prev = ($("#st-prev-body") || { innerHTML: "" }).innerHTML;
  check("the preview renders the option label with the author's colour",
    new RegExp("color:\\s*" + pvHex, "i").test(prev) && /Coloured/.test(prev), prev.slice(0, 300));
  console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log(">>>---CRASH " + (e && e.stack || e)); process.exit(1); });
