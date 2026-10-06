/* jsdom check of the Studio screening UI:
 *   the Screening tab on every question, the three modes, building a rule over a group of
 *   options, the hand-picked "Try it" tester, the per-option Screen out switch, the outline
 *   badge, the design check, and that it all lands in the saved study.
 * Needs the server on :8000 and jsdom.
 *   node scripts/dom/screening_studio_test.js */
let JSDOM;
for (const p of ["jsdom", "/tmp/node_modules/jsdom", "/tmp/domtest/node_modules/jsdom"]) {
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (l, c, d = "") => { console.log((c ? "PASS  " : "FAIL  ") + l + (c ? "" : "  -> " + d)); if (!c) fails++; };

(async () => {
  const dom = new JSDOM(await get("/studio/"), { url: BASE + "/studio/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {}; w.requestAnimationFrame = f => setTimeout(f, 0);
  w.Element.prototype.scrollIntoView = function () {};
  w.confirm = () => true;
  w.BEACON_PREVIEW_MODE = true;                       // survey.js renders, never boots
  w.fetch = (u, o) => {
    const U = new URL(u, BASE);
    return req((o && o.method) || "GET", U.pathname + U.search, o && o.body)
      .then(x => ({ ok: x.status < 400, status: x.status, json: () => Promise.resolve(JSON.parse(x.body)) }));
  };
  const errs = []; w.addEventListener("error", e => errs.push(e.message));
  for (const f of ["qlogic.js", "survey.js", "explainer.js", "studio.js"]) w.eval(await get("/static/js/" + f));
  await sleep(800);
  const d = w.document, $ = s => d.querySelector(s), $$ = s => [...d.querySelectorAll(s)];
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const click = el => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));

  // ---------- open the seeded BEACON study (it ships with screening on Q1 / Q3) ----------
  w.location.hash = "beacon";
  fire(w, "hashchange");
  await sleep(1200);
  check("the editor is open on BEACON", $$(".st-qi").length > 5, $$(".st-qi").length);

  const tabs = $$(".st-etab").map(b => b.textContent.replace(/\d+$/, "").trim());
  check("every question offers a Screening tab", tabs.includes("Screening"), JSON.stringify(tabs));

  // ---------- Q1: options marked Screen out ----------
  click($$(".st-etab").find(b => /Screening/.test(b.textContent))); await sleep(120);
  check("the Screening tab opens its card", !!$("#card-screening"), !!$("#card-screening"));
  check("Q1 starts with no authored rule block (it uses the option switches)",
    ($('input[name="f-scr-mode"]:checked') || {}).value === "off",
    ($('input[name="f-scr-mode"]:checked') || {}).value);
  check("...but the option switches are shown here",
    /Radiation oncology/.test($("#card-screening").textContent), $("#card-screening").textContent.slice(0, 120));
  const badges = $$(".st-qi .st-badge.screen").length;
  check("the outline marks screening questions with a badge", badges >= 2, badges);

  // ---------- the tester: pick an answer by hand ----------
  const pickChip = label => $$("#card-screening .st-scr-test .st-chip").find(c => new RegExp(label).test(c.textContent));
  click(pickChip("Radiation oncology")); await sleep(120);
  check("picking a terminating option reads SCREENED OUT",
    /SCREENED OUT/.test(($(".st-scr-verdict") || {}).textContent || ""),
    ($(".st-scr-verdict") || {}).textContent);
  click(pickChip("Medical oncology")); await sleep(120);
  check("picking an eligible option reads CONTINUES",
    /CONTINUES/.test(($(".st-scr-verdict") || {}).textContent || ""),
    ($(".st-scr-verdict") || {}).textContent);

  // ---------- build a group rule on a multi-select ----------
  // add a question we can shape freely: duplicate Q1 then make it multi select
  click($('[data-act="qdup"]')); await sleep(200);
  check("the duplicate opens in the editor", !!$("#f-id"), !!$("#f-id"));
  const typeSel = $("#f-type");
  typeSel.value = "multi_select"; fire(typeSel, "change"); await sleep(250);
  check("the question is now a multi select", $("#f-type").value === "multi_select", $("#f-type").value);

  const mode = $$('input[name="f-scr-mode"]').find(r => r.value === "screen_out");
  click(mode); await sleep(200);
  check("choosing 'Screen out when…' seeds one condition", $$("#f-scr-rules .st-rule").length === 1,
    $$("#f-scr-rules .st-rule").length);
  check("the condition defaults to the current question",
    ($('[data-sf="q"]') || {}).value === $("#f-id").value, ($('[data-sf="q"]') || {}).value);

  const opSel = $('[data-sf="op"]');
  opSel.value = "any_of"; fire(opSel, "change"); await sleep(200);
  check("'is any of' offers a chip per option", $$("#f-scr-rules .st-scr-chips .st-chip").length >= 3,
    $$("#f-scr-rules .st-scr-chips .st-chip").length);
  const chips = $$("#f-scr-rules .st-scr-chips .st-chip");
  check("the condition keeps the option it already had", chips[0].classList.contains("on"), chips.map(c => c.textContent).join(" | "));
  click(chips[1]); await sleep(150);
  click($$("#f-scr-rules .st-scr-chips .st-chip")[2]); await sleep(150);
  const hidden = $('[data-sf="value"]');
  check("ticking chips builds the option group", hidden.value.split(",").length === 3, hidden.value);

  click($('[data-act="scr-add"]')); await sleep(200);
  check("a second condition can be added", $$("#f-scr-rules .st-rule").length === 2,
    $$("#f-scr-rules .st-rule").length);
  check("the connector reads 'and' for match=all",
    /and/.test($$("#f-scr-rules .st-rule-no")[1].textContent), $$("#f-scr-rules .st-rule-no")[1].textContent);

  const matchSel = $("#f-scr-match");
  matchSel.value = "any"; fire(matchSel, "change"); await sleep(200);
  check("switching to 'any' changes the connector",
    /or/.test($$("#f-scr-rules .st-rule-no")[1].textContent), $$("#f-scr-rules .st-rule-no")[1].textContent);

  check("the rule is written out in plain English",
    /screen out when/.test($(".st-scr-plain").textContent), $(".st-scr-plain").textContent.slice(0, 120));
  check("the tester reports what the rule does", !!$(".st-scr-verdict"), !!$(".st-scr-verdict"));

  // ---------- qualify mode + custom closing text ----------
  const qual = $$('input[name="f-scr-mode"]').find(r => r.value === "qualify");
  click(qual); await sleep(200);
  check("qualify mode rewords the lead-in", /Carry on only when/.test($("#card-screening").textContent),
    $("#card-screening").textContent.slice(0, 200));
  const msg = $("#f-scr-msg");
  msg.value = "Thank you - this study is for oncologists only.";
  fire(msg, "input"); await sleep(150);
  check("a closing message can be typed", ($("#f-scr-msg") || {}).value.length > 10);

  // ---------- the per-option switch ----------
  click($$(".st-etab").find(b => /Content/.test(b.textContent))); await sleep(200);
  const termFlag = $$('#card-answers .st-flag').find(l => /Screen out/.test(l.textContent));
  check("each answer option offers a Screen out switch", !!termFlag, !!termFlag);
  const box = termFlag.querySelector("input");
  box.checked = true; fire(box, "change"); await sleep(200);
  check("ticking it marks the option", !!$("#card-answers .st-flag.on"));

  // ---------- it all reaches the saved study ----------
  await sleep(1600);
  const saved = JSON.parse(await get("/api/studio/study?slug=beacon")).cfg;
  const mine = saved.questions.find(q => q.type === "multi_select" && q.screening);
  check("the screening block is saved with the question", !!mine, JSON.stringify((saved.questions || []).map(q => !!q.screening)));
  if (mine) {
    check("mode, match and message are stored",
      mine.screening.mode === "qualify" && mine.screening.match === "any" &&
      /Thank you/.test(mine.screening.message || ""), JSON.stringify(mine.screening));
    check("the option group is stored as codes",
      (mine.screening.rules[0].op === "any_of") && String(mine.screening.rules[0].value).split(",").length === 3,
      JSON.stringify(mine.screening.rules[0]));
    check("the option switch is stored on the option",
      (mine.options || []).some(o => o.terminate), JSON.stringify(mine.options));
  }
  check("no script errors", errs.length === 0, errs.join(" | "));

  // leave the study as we found it: drop the question we added
  if (mine) {
    const del = { slug: "beacon", title: saved.title, cfg: saved };
    del.cfg.questions = saved.questions.filter(q => q !== mine);
    await req("POST", "/api/studio/save", JSON.stringify(del));
  }
  console.log(fails ? "\n" + fails + " FAILED" : "\nall Studio screening checks passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
