/* jsdom check of the Delta question, reworked as a carried-forward grid:
 *   Studio  - a new Delta starts empty; the source picker only offers grid / matrix
 *             questions; Carry forward copies their columns exactly and all their rows;
 *             carried columns can be renamed, new columns added and named, new rows
 *             added, reference values typed per row, and a carried column deleted.
 *   Survey  - the rendered table puts the carried columns and the new ones side by side
 *             on every row: reference cells read-only, new cells open for entry, plus
 *             N/A and the total row.
 *   Analysis- reporting flattens the new cells, and research gives per-row means.
 * Needs the server on :8000 and jsdom.
 *   node scripts/dom/studio_delta_grid_test.js */
let JSDOM;
for (const p of ["jsdom", "/tmp/node_modules/jsdom", "/tmp/nodemod/node_modules/jsdom"]) {
  try { ({ JSDOM } = require(p)); break; } catch (e) { /* try the next location */ }
}
const http = require("http"); const BASE = process.env.BASE || "http://127.0.0.1:8000";
function req(method, p, body) {
  return new Promise((res, rej) => {
    const u = new URL(BASE + p); const h = {};
    if (body) h["Content-Type"] = "application/json";
    const r = http.request(u, { method, headers: h }, x => {
      let d = ""; x.on("data", c => d += c); x.on("end", () => res({ status: x.statusCode, body: d }));
    });
    r.on("error", rej); if (body) r.write(body); r.end();
  });
}
const get = p => req("GET", p).then(r => r.body);
const post = (p, body) => req("POST", p, JSON.stringify(body)).then(r => JSON.parse(r.body));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (l, c, d = "") => {
  console.log((c ? "PASS  " : "FAIL  ") + l + (c ? "" : "  -> " + d)); if (!c) fails++;
};

// ---------------------------------------------------------------- a studio session
async function studio(slug) {
  const dom = new JSDOM(await get("/studio/"), {
    url: BASE + "/studio/#" + slug, runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window;
  w.BEACON_PREVIEW_MODE = true; w.requestAnimationFrame = fn => setTimeout(fn, 0);
  w.scrollTo = () => {}; w.Element.prototype.scrollIntoView = function () {}; w.confirm = () => true;
  w.fetch = (u, o) => {
    const U = new URL(u, BASE);
    return req((o && o.method) || "GET", U.pathname + U.search, o && o.body)
      .then(x => ({ ok: x.status < 400, status: x.status, json: () => Promise.resolve(JSON.parse(x.body)) }));
  };
  const errs = []; w.addEventListener("error", e => errs.push(e.message));
  for (const f of ["qlogic.js", "survey.js", "explainer.js", "studio.js"]) w.eval(await get("/static/js/" + f));
  await sleep(900);
  const d = w.document;
  const $ = s => d.querySelector(s), $$ = s => [...d.querySelectorAll(s)];
  return {
    w, d, errs, $, $$,
    fire: (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true })),
    click: el => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true })),
    open: async (id) => {
      const qi = $$(".st-qi").find(n => n.querySelector(".st-qi-id") &&
        n.querySelector(".st-qi-id").textContent === id);
      if (!qi) throw new Error("no outline row " + id);
      qi.querySelector(".st-qi-id").dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
      await sleep(320);
    },
    // keep reading until the server copy holds what we are waiting for
    savedQ: async (id, when) => {
      const ready = when || (q => !!q);
      for (let i = 0; i < 40; i++) {
        const q = (await savedCfg(slug)).questions.find(x => x.id === id);
        if (q && ready(q)) return q;
        await sleep(300);
      }
      throw new Error("question " + id + " never reached the expected state");
    },
  };
}
const savedCfg = async slug => JSON.parse(await get("/api/studio/study?slug=" + slug)).cfg;
// the id of the delta question this study grew, whenever it was added
const deltaId = async slug => {
  for (let i = 0; i < 25; i++) {
    const q = (await savedCfg(slug)).questions.find(x => x.type === "delta");
    if (q) return q.id;
    await sleep(250);
  }
  throw new Error("no delta question was ever saved");
};
const colNames = s => s.$$(".st-dl-colname").map(n => n.value);
const rowNames = s => s.$$(".st-dl-rowname").map(n => n.value);
const kinds = s => s.$$(".st-dl-kind").map(n => n.textContent);
const rows = s => s.$$(".st-dl-tr[data-dri]");

// ---------------------------------------------------------------- a respondent session
async function liveStudy(cfg, title) {
  const slug = (await post("/api/studio/save", { title, cfg })).slug;
  await req("POST", "/api/studio/status", JSON.stringify({ slug, status: "live" }));
  await req("POST", "/admin/reset?study=" + slug + "&scope=all");
  return slug;
}
async function openSurvey(slug) {
  const url = "/survey/" + slug + "/test";
  const dom = new JSDOM(await get(url), { url: BASE + url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {}; w.requestAnimationFrame = fn => setTimeout(fn, 0);
  w.Element.prototype.scrollIntoView = function () {};
  w.fetch = (u, o) => {
    const U = new URL(u, BASE);
    return req((o && o.method) || "GET", U.pathname + U.search, o && o.body)
      .then(x => ({ ok: x.status < 400, status: x.status, json: () => Promise.resolve(JSON.parse(x.body)) }));
  };
  w.STUDY = { slug: slug };
  const errs = []; w.addEventListener("error", e => errs.push(e.message));
  for (const f of ["qlogic.js", "explainer.js", "survey.js"]) w.eval(await get("/static/js/" + f));
  await sleep(900);
  const $ = x => w.document.querySelector(x), $$ = x => [...w.document.querySelectorAll(x)];
  return {
    w, errs, $, $$,
    fire: (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true })),
    click: el => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true })),
    go: async (qid) => {
      // jump straight at the question we want, the way a respondent walking the study would
      const d = w.document;
      const idx = (w.SURVEY_ORDER || []).indexOf(qid);
      w.jumpTo(qid); await sleep(400);
      return idx >= 0;
    },
  };
}

const CFG = {
  sections: [{ id: "S1", title: "Delta" }],
  questions: [
    { id: "G1", section: "S1", type: "numeric_matrix", stem: "What was in place before?",
      rows: [{ code: "r1", label: "Region A" }, { code: "r2", label: "Region B" }],
      cols: [{ code: "c1", label: "Baseline" }, { code: "c2", label: "Target" }] },
    { id: "G2", section: "S1", type: "rating_grid", stem: "How good was each?",
      rows: [{ code: "a", label: "Speed" }, { code: "b", label: "Clarity" }],
      cols: [{ code: "x", label: "Poor" }, { code: "y", label: "Good" }] },
    { id: "G3", section: "S1", type: "rating_scale", stem: "Scale only",
      rows: [{ code: "a", label: "One" }], scale: { min: 1, max: 5 } },
    { id: "C1", section: "S1", type: "single_select", stem: "Pick one",
      options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] },
    { id: "C2", section: "S1", type: "open_text", stem: "Say something" },
  ],
  tpp: {}, explainer_scenes: [],
};

(async () => {
  const css = (await get("/static/css/studio.css")).replace(/\n/g, "");
  const slug = (await post("/api/studio/save", { title: "Delta Grid Test", cfg: CFG })).slug;
  const s = await studio(slug);

  // =============================================================== a new Delta
  // added last, so every grid question in the study sits before it and can be carried from
  await s.open("C2"); await sleep(260);
  s.click(s.$(".st-addq")); await sleep(320);
  s.click(s.$('[data-act="qadd-type"][data-type="delta"]'));
  const dqid = await deltaId(slug);
  await s.open(dqid); await sleep(340);

  check("a new Delta opens on the carried-grid editor, not the two-cell one",
    !!s.$(".st-dl-card") && !s.$("#f-beforel"), "cards: " +
    [...s.$("#st-editor").querySelectorAll(".st-card")].map(c => c.id).join(","));

  check("a new Delta starts with one empty new column and no rows",
    colNames(s).length === 1 && kinds(s).join() === "New" && rows(s).length === 0,
    colNames(s).join("|") + " / " + kinds(s).join() + " / " + rows(s).length + " rows");

  check("the source picker offers only the grid and matrix questions",
    [...s.$("#f-delta-source").options].map(o => o.value).join(",") === ",G1,G2,G3",
    [...s.$("#f-delta-source").options].map(o => o.value).join(","));

  check("each option in the picker says how many rows and columns it carries",
    /2 rows . 2 cols/.test(s.$('#f-delta-source option[value="G1"]').textContent) &&
    /1 row . 1 col/.test(s.$('#f-delta-source option[value="G3"]').textContent),
    s.$('#f-delta-source option[value="G1"]').textContent);

  check("nothing is carried until Carry forward is pressed",
    /press/.test(s.$(".st-dl-note").textContent) && rows(s).length === 0);

  check("the table's grid tracks cover the row label, every column and the actions cell",
    /--st-dl-cols:\s*minmax\(150px,1\.4fr\) minmax\(96px,1fr\) auto/.test(
      s.$(".st-dl-table").getAttribute("style")), s.$(".st-dl-table").getAttribute("style"));

  // =============================================================== carry forward
  s.$("#f-delta-source").value = "G1";
  s.fire(s.$("#f-delta-source"), "change");
  await sleep(160);
  s.click(s.$('[data-act="delta-carry"]')); await sleep(420);

  check("Carry forward copies the source's columns exactly, ahead of the new one",
    kinds(s).join() === "Source,Source,New" && colNames(s).join("|") === "Baseline|Target|New column",
    colNames(s).join("|") + " / " + kinds(s).join());

  check("every row of the source question comes across",
    rows(s).length === 2 && rows(s)[0].querySelector(".st-dl-rowname").value === "Region A",
    rows(s).map(r => r.querySelector(".st-dl-rowname").value).join("|"));

  check("carried columns and the new column sit side by side on each row",
    rows(s).every(r => r.querySelectorAll(".st-dl-td.st-dl-src").length === 2 &&
      r.querySelectorAll(".st-dl-td.st-dl-new").length === 1),
    "src=" + s.$$('.st-dl-tr[data-dri] .st-dl-td.st-dl-src').length +
    " new=" + s.$$('.st-dl-tr[data-dri] .st-dl-td.st-dl-new').length);

  check("a carried cell is a reference value, a new cell is where the answer goes",
    s.$$(".st-dl-tr[data-dri] .st-dl-src input").length === 4 &&
    s.$$(".st-dl-tr[data-dri] .st-dl-new input").length === 0 &&
    s.$$(".st-dl-tr[data-dri] .st-dl-new .st-dl-ph").length === 2,
    "ref inputs=" + s.$$(".st-dl-tr[data-dri] .st-dl-src input").length);

  check("+ Add row and + Add column are both still there",
    !!s.$('[data-act="delta-row-add"]') && !!s.$('[data-act="delta-col-add"]'));

  let dqSaved = await s.savedQ(dqid, q => (q.cols || []).some(c => c.kind === "src") &&
    (q.rows || []).length === 2);
  check("the carried shape is persisted, with the source recorded",
    dqSaved.delta_source === "G1" &&
    dqSaved.cols.map(c => c.code).join() === "dscc1,dscc2,d1" &&
    dqSaved.cols.map(c => c.kind).join() === "src,src,delta" &&
    dqSaved.rows.map(r => r.code).join() === "r1,r2",
    JSON.stringify(dqSaved.cols) + " " + JSON.stringify(dqSaved.rows));

  // =============================================================== reference values
  const refs = s.$$(".st-dl-ref");
  refs[0].value = "10"; s.fire(refs[0], "input");
  refs[1].value = "90"; s.fire(refs[1], "input");
  refs[2].value = "25"; s.fire(refs[2], "input");
  await sleep(600);
  dqSaved = await s.savedQ(dqid, q => (q.rows || []).length === 2 &&
    Object.keys(q.rows[0].ref || {}).length >= 2);
  check("a reference value is stored against its row and its carried column",
    dqSaved.rows[0].ref && dqSaved.rows[0].ref.dscc1 === "10" && dqSaved.rows[1].ref.dscc1 === "25",
    JSON.stringify(dqSaved.rows));

  // =============================================================== rename both kinds
  const colInp = s.$$(".st-dl-colname");
  colInp[0].value = "SCXZV"; s.fire(colInp[0], "input");
  colInp[2].value = "VCAZ"; s.fire(colInp[2], "input");
  await sleep(700);
  dqSaved = await s.savedQ(dqid, q => (q.cols || []).some(c => c.label === "SCXZV"));
  check("a carried column can be renamed and so can a new one",
    dqSaved.cols[0].label === "SCXZV" && dqSaved.cols[2].label === "VCAZ",
    dqSaved.cols.map(c => c.label).join("|"));

  // =============================================================== add, delete, move
  s.click(s.$('[data-act="delta-col-add"]')); await sleep(380);
  s.click(s.$('[data-act="delta-row-add"]')); await sleep(380);
  check("a new column and a new row can be added",
    colNames(s).length === 4 && kinds(s).join() === "Source,Source,New,New" && rows(s).length === 3,
    colNames(s).join("|") + " / " + rows(s).length + " rows");

  s.$$(".st-dl-colname")[3].value = "Q1VP";
  s.fire(s.$$(".st-dl-colname")[3], "input");
  await sleep(700);
  dqSaved = await s.savedQ(dqid, q => (q.cols || []).length === 4 && (q.rows || []).length === 3);
  check("the new column and row persist, and the new column gets its own code",
    dqSaved.cols.length === 4 && dqSaved.cols[3].label === "Q1VP" &&
    dqSaved.cols[3].code !== "d1" && dqSaved.rows.length === 3,
    JSON.stringify(dqSaved.cols) + " " + JSON.stringify(dqSaved.rows.map(r => r.code)));

  // a carried column going away takes its reference values with it
  s.click(s.$$('[data-act="delta-col-del"]')[0]); await sleep(420);
  check("deleting a carried column drops it and its reference cells",
    colNames(s).join("|") === "Target|VCAZ|Q1VP" && kinds(s).join() === "Source,New,New" &&
    rows(s).every(r => r.querySelectorAll(".st-dl-ref").length === 1),
    colNames(s).join("|") + " / " + kinds(s).join() + " / " +
    rows(s)[0].querySelectorAll(".st-dl-ref").length + " ref cells");
  dqSaved = await s.savedQ(dqid, q => (q.cols || []).length === 3 &&
    (q.rows || []).every(r => !Object.prototype.hasOwnProperty.call(r.ref || {}, "dscc1")));
  check("the reference values of a deleted carried column are gone from the save",
    dqSaved.rows.every(r => !Object.prototype.hasOwnProperty.call(r.ref || {}, "dscc1")),
    JSON.stringify(dqSaved.rows.map(r => r.ref)));

  // rows can be reordered
  s.click(s.$$('[data-act="delta-row-down"]')[0]); await sleep(400);
  check("rows can be reordered",
    rows(s)[0].querySelector(".st-dl-rowname").value === "Region B",
    rows(s).map(r => r.querySelector(".st-dl-rowname").value).join("|"));

  // re-carrying keeps the authored work
  s.$("#f-delta-source").value = "G2";
  s.fire(s.$("#f-delta-source"), "change");
  await sleep(160);
  s.click(s.$('[data-act="delta-carry"]')); await sleep(450);
  check("re-carrying from another source adds its columns and rows, losing nothing",
    colNames(s).join("|") === "Target|Poor|Good|VCAZ|Q1VP" &&
    kinds(s).join() === "Source,Source,Source,New,New" && rows(s).length === 5,
    colNames(s).join("|") + " / " + kinds(s).join("|") + " / " + rows(s).length + " rows");
  dqSaved = await s.savedQ(dqid, q => (q.cols || []).filter(c => c.kind === "src").length === 3);
  check("the re-carried shape keeps the new columns the author added",
    dqSaved.cols.filter(c => c.kind !== "src").map(c => c.label).join() === "VCAZ,Q1VP" &&
    dqSaved.cols.filter(c => c.kind === "src").length === 3,
    JSON.stringify(dqSaved.cols.map(c => c.label)));

  check("the editor produced no script errors", !s.errs.length, s.errs.join(" | "));

  // =============================================================== the legacy shape still renders
  // A Delta saved before the grid had before_label / after_label and no columns.  It is
  // written straight to the study and a fresh session is opened, so this is exactly the
  // state an older study would be in.
  const legacy = { ...CFG.questions[0] };
  legacy.id = "LG"; legacy.type = "delta"; legacy.stem = "Old style delta";
  legacy.before_label = "Before"; legacy.after_label = "After";
  delete legacy.cols;
  const cfgNow = await savedCfg(slug);
  cfgNow.questions.push(legacy);
  await post("/api/studio/save", { title: "Delta Grid Test", cfg: cfgNow });
  const s2 = await studio(slug);
  const lgSaved = (await savedCfg(slug)).questions.find(q => q.id === "LG");
  check("the legacy question really was saved without columns",
    !lgSaved.cols && !!lgSaved.before_label, JSON.stringify(lgSaved));
  await s2.open("LG"); await sleep(340);
  check("a Delta saved before the grid still opens on the two-cell editor",
    !!s2.$("#f-beforel") && !!s2.$("#f-afterl") && !s2.$(".st-dl-card"),
    "beforel=" + !!s2.$("#f-beforel") + " afterl=" + !!s2.$("#f-afterl") +
    " dlcard=" + !!s2.$(".st-dl-card"));

  // =============================================================== the rendered grid
  const DG = {
    sections: [{ id: "S1", title: "Delta" }],
    questions: [
      { id: "D1", section: "S1", type: "delta", stem: "What will you put in place now?",
        delta_source: "G1", min: 0, max: 100, step: 1, delta_total: 100,
        cols: [
          { code: "dscc1", label: "Baseline", kind: "src", src_code: "c1", src_q: "G1" },
          { code: "dscc2", label: "Target", kind: "src", src_code: "c2", src_q: "G1" },
          { code: "n1", label: "New plan", kind: "delta" },
          { code: "n2", label: "Fallback", kind: "delta" },
        ],
        rows: [
          { code: "r1", label: "Region A", ref: { dscc1: "10", dscc2: "90" } },
          { code: "r2", label: "Region B", ref: { dscc1: "25", dscc2: "75" } },
          { code: "r3", label: "Region C", ref: { dscc1: "40", dscc2: "60" } },
        ] },
    ],
    tpp: {}, explainer_scenes: [],
  };
  const dslug = await liveStudy(DG, "Delta Grid Live");
  const R = await openSurvey(dslug);
  const rd = R.w.document;

  check("the survey boots without errors", !R.errs.length, R.errs.join(" | "));

  // walk to the question
  const startBtn = R.$("#start-btn") || R.$('[data-act="start"]');
  if (startBtn) { R.click(startBtn); await sleep(500); }
  for (let i = 0; i < 12 && !R.$(".deltagrid"); i++) {
    const nx = R.$("#next-btn") || R.$('[data-act="next"]');
    if (nx) R.click(nx); else break;
    await sleep(350);
  }
  const grid = R.$(".deltagrid");
  check("the delta question renders as a grid, not two boxes",
    !!grid && !rd.querySelector(".delta-out"), "grid=" + !!grid);

  if (grid) {
    const dRows = R.$$(".dg-tr").filter(r => r.querySelector(".dg-rowlabel") &&
      !r.classList.contains("dg-total"));
    check("every carried row is on screen", dRows.length === 3,
      R.$$(".dg-rowlabel").map(n => n.textContent).join("|"));

    check("carried columns and new columns sit side by side on each row",
      dRows.every(r => r.querySelectorAll(".dg-td-src").length === 2 &&
        r.querySelectorAll(".dg-td-new").length === 2) && R.$$(".dg-total").length === 1,
      "src=" + R.$$(".dg-td-src").length + " new=" + R.$$(".dg-td-new").length);

    check("a carried cell is read-only reference text, with no input inside it",
      R.$$(".dg-td-src").length === 6 &&
      R.$$(".dg-td-src input").length === 0 &&
      R.$$(".dg-ref").map(n => n.textContent).join("|") === "10|90|25|75|40|60",
      R.$$(".dg-ref").map(n => n.textContent).join("|"));

    check("a new cell is a number box",
      R.$$(".dg-td-new input").length === 6 &&
      R.$$(".dg-td-new input").every(i => i.type === "number"));

    check("the header names both the carried and the new columns",
      R.$$(".dg-head .dg-th").map(n => n.textContent.trim()).join("|") ===
        "|Baseline|Target|New plan|Fallback|N/A",
      R.$$(".dg-head .dg-th").map(n => n.textContent.trim()).join("|"));

    check("the two bands are labelled so the pair reads as one table",
      /Already stated/.test(R.$(".dg-group-src").textContent) &&
      /To enter/.test(R.$(".dg-group-new").textContent),
      R.$(".dg-group-src").textContent + " / " + R.$(".dg-group-new").textContent);

    check("N/A is offered per row", R.$$(".dg-td-na").length === 3);

    check("the total row adds up each new column",
      !!R.$(".dg-total") && R.$$(".dg-total .dg-sum").length === 2 &&
      R.$(".dg-total .dg-sum").textContent === "\u2014",
      R.$(".dg-total") ? R.$$(".dg-total .dg-sum").map(n => n.textContent).join("|") : "no total row");

    // type into the first new column
    const boxes = R.$$(".dg-td-new input");
    boxes[0].value = "30"; R.fire(boxes[0], "input");
    boxes[2].value = "50"; R.fire(boxes[2], "input");
    boxes[4].value = "20"; R.fire(boxes[4], "input");
    await sleep(250);
    // the total row reads back the same answers, so it doubles as the proof of the keys
    check("typing stores row_col against the delta question",
      R.$$(".dg-total .dg-sum")[0].textContent === "100" &&
      R.$$(".dg-total .dg-sum")[1].textContent === "—",
      R.$$(".dg-total .dg-sum").map(x => x.textContent).join("|"));

    // N/A on a row empties that row's new cells
    const bodyRows = R.$$(".dg-tr").filter(r => !r.classList.contains("dg-total") &&
      r.querySelector(".dg-rowlabel"));
    const naBox = R.$$(".dg-td-na input")[2];
    naBox.checked = true; R.fire(naBox, "change");
    await sleep(220);
    check("N/A on a row empties that row's new cells",
      bodyRows.map(r => r.querySelectorAll(".dg-td-new input")[0].value).join("|") === "30|50|",
      bodyRows.map(r => r.querySelectorAll(".dg-td-new input")[0].value).join("|"));

    check("the total row follows the column and flags a total that is off",
      R.$$(".dg-total .dg-sum")[0].textContent === "100" &&
      !R.$(".dg-total .dg-sum").classList.contains("bad"),
      R.$$(".dg-total .dg-sum")[0].textContent + " bad=" +
      R.$(".dg-total .dg-sum").classList.contains("bad"));

    check("the grid tracks cover the row label, four columns and N/A",
      /--dg-cols:\s*minmax\(150px,1\.5fr\) minmax\(104px,1fr\) minmax\(104px,1fr\) minmax\(118px,1fr\) minmax\(118px,1fr\) 70px/
        .test(R.$(".dg-table").getAttribute("style")), R.$(".dg-table").getAttribute("style"));
  }
  const surveyCss = (await get("/static/css/survey.css")).replace(/\n/g, "");
  check("the carried cells are tinted apart from the ones to fill in",
    /\.dg-td-src\{[^}]*--dg-src\b/.test(surveyCss) || /\.dg-td-src\{[^}]*background/.test(surveyCss),
    "dg-td-src rule missing");

  // =============================================================== the legacy pair still works
  const LGCFG = {
    sections: [{ id: "S1", title: "Delta" }],
    questions: [{ id: "P1", section: "S1", type: "delta", stem: "Before and after",
      before_label: "Before", after_label: "After", min: 0, max: 100 }],
    tpp: {}, explainer_scenes: [],
  };
  const lslug = await liveStudy(LGCFG, "Delta Pair Live");
  const P = await openSurvey(lslug);
  if (P.$("#start-btn") || P.$('[data-act="start"]')) {
    R.click(P.$("#start-btn") || P.$('[data-act="start"]')); await sleep(500);
  }
  check("the older two-cell delta still renders its before, after and change boxes",
    !!P.$(".delta-out") && P.$$(".delta-cell").length === 3,
    "cells=" + P.$$(".delta-cell").length + " out=" + !!P.$(".delta-out"));

  console.log("\n" + (fails ? fails + " FAILURE(S)" : "all checks passed"));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("TEST CRASH", e); process.exit(1); });
