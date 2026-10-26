/* jsdom check that translations work on a LIVE (hosted) survey, not just in the Studio test
   link.  Two production bugs are pinned here:

   1. A published study served the snapshot of its language tables at publish time, so a
      translation saved afterwards never reached respondents.
   2. /api/spec ignored ?lang= whenever the browser already had a session, so the in-survey
      language switch (and any ?lang= link) reloaded the survey in the default language.

   Needs the server on :8000 and jsdom:  node scripts/dom/live_language_test.js */
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch (e) { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
const http = require("http"); const BASE = process.env.BASE || "http://127.0.0.1:8000";
const SLUG = "live-lang";

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
const json = p => get(p).then(JSON.parse);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (l, c, d = "") => { console.log((c ? "PASS  " : "FAIL  ") + l + (c ? "" : "  -> " + d)); if (!c) fails++; };

async function open(path, store) {
  const dom = new JSDOM(await get(path), { url: BASE + path, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {}; w.requestAnimationFrame = fn => setTimeout(fn, 0);
  w.Element.prototype.scrollIntoView = function () {};
  w.fetch = (u, o) => {
    const U = new URL(u, BASE);
    return req((o && o.method) || "GET", U.pathname + U.search, o && o.body)
      .then(x => ({ ok: x.status < 400, status: x.status, json: () => Promise.resolve(JSON.parse(x.body)) }));
  };
  Object.keys(store || {}).forEach(k => w.localStorage.setItem(k, JSON.stringify(store[k])));
  const errs = []; w.addEventListener("error", e => errs.push(e.message || String(e)));
  w.STUDY = { slug: SLUG };
  w.eval("window.STUDY = { slug: '" + SLUG + "' };");
  for (const f of ["qlogic.js", "explainer.js", "survey.js"]) w.eval(await get("/static/js/" + f));
  await sleep(900);
  return { w, errs };
}

(async () => {
  const cfg = {
    language: "en-US", gamify: false,
    welcome_title: "Welcome", welcome_text: "Ten minutes of your time.",
    sections: [{ id: "S1", title: "Intro" }],
    questions: [{ id: "Q1", section: "S1", type: "single_select", stem: "Pick one",
      options: [{ code: 1, label: "Option A" }, { code: 2, label: "Option B" }] }],
  };
  await req("POST", "/api/studio/delete", JSON.stringify({ slug: SLUG }));
  await req("POST", "/api/studio/delete", JSON.stringify({ slug: SLUG + "--es" }));
  await req("POST", "/api/studio/save", JSON.stringify({ slug: SLUG, title: "Live language", cfg }));
  await req("POST", "/api/studio/status", JSON.stringify({ slug: SLUG, status: "live" }));

  // Freeze the design before any translation exists (what "Publish" does in Workspace).
  await req("POST", "/api/workspace/publish", "{}");
  await req("POST", "/api/studio/globalize", JSON.stringify({ slug: SLUG, lang: "es" }));
  await req("POST", "/api/studio/translate", JSON.stringify({ slug: SLUG + "--es", lang: "es",
    strings: { "study:welcome_text": "Diez minutos de su tiempo.", "q:Q1:stem": "Elige uno",
               "ui:begin": "Comenzar la encuesta", "ui:next": "Siguiente" } }));

  // ---- 1. the published study serves the translation saved after publishing
  const spec = await json("/api/spec/" + SLUG + "?lang=es");
  check("live spec serves a post-publish translation", spec.welcome_text === "Diez minutos de su tiempo.",
    spec.welcome_text);
  check("live spec translates the question stem", spec.questions[0].stem === "Elige uno", spec.questions[0].stem);
  check("language picker lists the child survey",
    (spec.languages || []).some(l => l.code === "es" && l.child === SLUG + "--es"), JSON.stringify(spec.languages));

  // ---- 2. a respondent with an existing session can still switch language
  const started = JSON.parse((await req("POST", "/api/start",
    JSON.stringify({ study: SLUG, is_test: false }))).body);
  const sid = started.session_id;
  const NS = "study_" + SLUG + "_";
  const S = await open("/survey/" + SLUG + "?lang=es", { [NS + "session_id"]: sid });
  const welcomeText = (S.w.document.querySelector("#welcome p") || {}).textContent || "";
  check("welcome page is in Spanish for a resuming session", /Diez minutos/.test(welcomeText), welcomeText);
  check("in-survey language picker is offered", !!S.w.document.querySelector("#lang-pick"));
  const startBtn = S.w.document.querySelector("#start-btn");
  // Buttons are product chrome and stay in English in every language; only the
  // questionnaire wording follows the child survey's language.
  check("the begin button stays English", /Begin survey/.test(startBtn.textContent),
    startBtn.textContent);
  const factLabels = [...S.w.document.querySelectorAll("#welcome .facts div span")]
    .map(n => n.textContent.trim());
  check("welcome fact labels keep their English defaults when untranslated",
    factLabels[0] === "Questions", factLabels.join(" | "));
  S.w.document.querySelector("#start-btn").click();
  await sleep(700);
  const stem = (S.w.document.querySelector("#app .qstem, #app .card") || {}).textContent || "";
  check("resumed question is in Spanish", /Elige uno/.test(stem), stem.slice(0, 120));
  const nextBtn = [...S.w.document.querySelectorAll("#app .nav .btn.primary")]
    .map(b => b.textContent.trim())[0] || "";
  check("the forward button stays English", /Next|Submit survey/.test(nextBtn) &&
    !/Siguiente|Enviar/.test(nextBtn), nextBtn);
  check("no page errors", S.errs.length === 0, S.errs.join(" | "));

  // ---- 3. switching back to English on the same live session
  check("session language is remembered", (await json("/api/spec/" + SLUG + "?sid=" + encodeURIComponent(sid))).render_language === "es",
    (await json("/api/spec/" + SLUG + "?sid=" + encodeURIComponent(sid))).render_language);
  const back = await json("/api/spec/" + SLUG + "?sid=" + encodeURIComponent(sid) + "&lang=en-US");
  check("?lang=en-US returns to the original wording", back.render_language === "en-US" &&
    back.questions[0].stem === "Pick one", back.questions[0].stem);

  await req("POST", "/api/studio/delete", JSON.stringify({ slug: SLUG }));
  console.log(fails ? fails + " FAILED" : "PASS Live translation: post-publish tables, session language switch, picker.");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
