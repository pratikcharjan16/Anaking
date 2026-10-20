/* jsdom check that the written-answer AI check covers every place a respondent can write,
   not just an open_text question: text-grid cells, comment boxes and a "please specify"
   field.  Each is scored live, carries its own telemetry and verdict, and is listed by name
   in the proofreading step before submit.
   Needs a running server on :8000 and jsdom (npm i jsdom in /tmp):
   node scripts/dom/survey_ai_textfields_test.js */
const path = require("path");
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch (e) { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
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
let fails = 0;
const check = (l, c, d = "") => { console.log((c ? "PASS  " : "FAIL  ") + l + (c ? "" : "  -> " + d)); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const AI = "Oncologists play a crucial role in navigating the complex landscape of treatment. " +
  "Moreover, the safety profile appears robust and manageable. Furthermore, once-weekly " +
  "dosing offers a compelling convenience advantage which could streamline clinic workflows. " +
  "In conclusion, uptake would be meaningful where capacity is constrained.";
const HUMAN = "honestly the once-a-week shot is the big one for us. chairs are full by 9am so " +
  "anything that frees a chair gets used. the AE rate worries me a bit though - 30% grade 3+ " +
  "is not nothing. probably 10-15% of my patients in year 1.";

async function openSurvey(slug) {
  const url = "/survey/" + slug + "/test";
  const dom = new JSDOM(await get(url), { url: BASE + url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {}; w.requestAnimationFrame = fn => setTimeout(fn, 0);
  w.Element.prototype.scrollIntoView = function () {};
  w.fetch = (u, o) => {
    const u2 = new URL(u, BASE);
    return req((o && o.method) || "GET", u2.pathname + u2.search, o && o.body)
      .then(x => ({ ok: x.status < 400, status: x.status, json: () => Promise.resolve(JSON.parse(x.body)) }));
  };
  w.STUDY = { slug: slug };
  const errs = []; w.addEventListener("error", e => errs.push(e.message));
  for (const f of ["qlogic.js", "explainer.js", "survey.js"]) w.eval(await get("/static/js/" + f));
  await sleep(900);
  const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
  $("#start-btn").click();
  await sleep(400);
  return { w, $, $$, errs, slug };
}

// paste into a box the way a respondent does: a paste event, then the input it causes
async function paste(S, ta, text) {
  ta.focus();
  const ev = new S.w.Event("paste", { bubbles: true });
  ev.clipboardData = { getData: () => text };
  ta.dispatchEvent(ev);
  ta.value = text;
  ta.dispatchEvent(new S.w.Event("input", { bubbles: true }));
  await sleep(1700);                        // paste is scored straight away
}

(async () => {
  const cfg = {
    sections: [{ id: "S1", title: "A" }],
    questions: [
      { id: "G1", section: "S1", type: "text_grid", stem: "How is it going?",
        rows: [{ code: "r1", label: "Speed" }, { code: "r2", label: "Price" }],
        cols: [{ code: "c1", label: "Now" }, { code: "c2", label: "Later" }] },
      { id: "C1", section: "S1", type: "rating_grid", stem: "Rate it",
        rows: [{ code: "r1", label: "Overall", comment: "optional" }],
        cols: [{ code: "c1", label: "Poor" }, { code: "c2", label: "Good" }],
        comments: { mode: "optional", label: "Anything else?" } },
      { id: "S1", section: "S1", type: "multi_select", stem: "Where do you work?",
        options: [{ code: 1, label: "Community" }, { code: 2, label: "Academic" },
                  { code: 3, label: "Other", other: true }] }
    ],
    qc: { min_seconds: 5, ai: { action: "warn", warn_at: 35, flag_at: 60 } }
  };
  const slug = JSON.parse((await req("POST", "/api/studio/save", JSON.stringify({ title: "Text fields", cfg }))).body).slug;
  await req("POST", "/api/studio/status", JSON.stringify({ slug, status: "live" }));
  await req("POST", "/admin/reset?study=" + slug + "&scope=all");

  const S = await openSurvey(slug);
  const { w, $, $$ } = S;
  const sid = JSON.parse(w.localStorage.getItem("study_" + slug + "_test_session_id"));
  // the server's view of the record, so this also covers _ai:<item> coming back as JSON
  const answers = async () => {
    await sleep(300);
    const p = JSON.parse((await req("GET", "/api/progress?sid=" + encodeURIComponent(sid))).body);
    return (p && p.answers) || {};
  };
  // Persist the answers to the session, which is how a record is read back.  Next validates,
  // and a text grid with empty cells will not let the respondent past it - so use the test-mode
  // jump box, which saves and moves on without validating.
  const step = async () => {
    const jump = $("select[aria-label='Jump to any survey question']");
    if (jump) {
      const i = Number(jump.value);
      if (i + 1 < jump.options.length) jump.value = String(i + 1);
      jump.dispatchEvent(new w.Event("change", { bubbles: true }));
    } else $(".nav .btn.primary").click();
    await sleep(1000);
  };
  const back = async () => { $(".nav .btn.ghost").click(); await sleep(600); };

  const cells = $$(".tg-input");
  check("the text grid renders one box per cell", cells.length === 4, cells.length);
  const cellIn = re => cells.find(t => t.closest(".tg-tr") && re.test(t.closest(".tg-tr").textContent));

  // ---- 1. a pasted grid cell is scored, and gets its own verdict ------------------------
  await paste(S, cellIn(/Speed/), AI);
  await step();                                            // onto the rating grid
  let a = await answers();
  check("a pasted text-grid cell is scored like an open-text answer",
    ((a["G1"] || {})["_ai:r1_c1"] || {}).verdict === "likely_ai", JSON.stringify(a["G1"]));
  check("the cell keeps its own telemetry",
    ((a["G1"] || {})["_meta:r1_c1"] || {}).pasted_chars === AI.length,
    JSON.stringify((a["G1"] || {})["_meta:r1_c1"]));

  // ---- 2. a second cell is scored independently -----------------------------------------
  await back();
  await paste(S, cellIn(/Price/), HUMAN);
  await step();
  a = await answers();
  check("a second cell has its own verdict and does not overwrite the first",
    (a["G1"] || {})["_ai:r1_c1"].verdict === "likely_ai" &&
    ((a["G1"] || {})["_ai:r2_c1"] || {}).verdict !== "likely_ai" &&
    (a["G1"] || {})["_ai:r2_c1"].score < (a["G1"] || {})["_ai:r1_c1"].score,
    JSON.stringify(a["G1"]));

  // ---- 3. a row comment box is scored --------------------------------------------------
  const cmt = $(".cmt-box");
  check("the rating grid offers its comment box", !!cmt);
  if (cmt) {
    await paste(S, cmt, AI);
    await step();                                          // onto the select question
    a = await answers();
    check("a pasted row comment box is scored",
      ((a["C1"] || {})["_ai:c_r1"] || {}).verdict === "likely_ai", JSON.stringify(a["C1"]));
  }

  // ---- 4. the question-level comment box is scored -------------------------------------
  await back();
  const qcmt = $$(".cmt-box").pop();
  if (qcmt) {
    await paste(S, qcmt, AI);
    await step();
    a = await answers();
    check("the question-level comment box is scored",
      ((a["C1"] || {})["_ai:_comment"] || {}).verdict === "likely_ai", JSON.stringify(a["C1"]));
  }

  // ---- 5. a "please specify" box is scored ---------------------------------------------
  // "Other" is the third option; ticking it reveals its specify box
  const boxes = $$(".opt input[type=checkbox], .opts input[type=checkbox], input[type=checkbox]");
  check("the select question offers an Other option", boxes.length >= 3, boxes.length);
  if (boxes.length >= 3) {
    boxes[2].click(); await sleep(500);
    const ob = $$("input[type=text]").pop();
    check("ticking Other reveals its specify box", !!ob);
    if (ob) {
      await paste(S, ob, AI);
      await step();
      a = await answers();
      check("a pasted \"please specify\" box is scored",
        ((a["S1"] || {})["_ai:other_text"] || {}).verdict === "likely_ai", JSON.stringify(a["S1"]));
    }
  }

  check("no JS errors on the way", !S.errs.length, S.errs.join(" | "));
  console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log(">>>---CRASH " + (e && e.stack || e)); process.exit(1); });
