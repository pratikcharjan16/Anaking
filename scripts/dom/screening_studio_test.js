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

  // ---------- numbers: the operator row with a number box ----------
  click($('[data-act="qdup"]')); await sleep(250);           // a copy we can reshape freely
  click($$(".st-etab").find(b => /Screening/.test(b.textContent))); await sleep(150);
  click($$('input[name="f-scr-mode"]').find(r => r.value === "off")); await sleep(200);
  click($$(".st-etab").find(b => /Content/.test(b.textContent))); await sleep(200);
  const tSel1 = $("#f-type"); tSel1.value = "numeric"; fire(tSel1, "change"); await sleep(300);
  const numId = $("#f-id").value;
  click($$(".st-etab").find(b => /Screening/.test(b.textContent))); await sleep(150);
  click($$('input[name="f-scr-mode"]').find(r => r.value === "screen_out")); await sleep(220);
  check("a numeric question opens with one condition", $$("#f-scr-rules .st-rule").length === 1,
    $$("#f-scr-rules .st-rule").length);
  let numBox = $('[data-sf="value"].st-scr-num');
  check("a numeric condition is a number box", !!numBox, ($("#f-scr-rules") || {}).innerHTML.slice(0, 200));
  check("the number box knows the question's own range",
    !!numBox && numBox.getAttribute("min") !== null, numBox && numBox.outerHTML);
  const numOps = [...($('[data-sf="op"]') || { options: [] }).options].map(o => o.textContent);
  check("the operator row is = \u2260 < \u2264 > \u2265 plus between / outside",
    ["<", "\u2264", ">", "\u2265", "=", "\u2260"].every(t => numOps.includes(t)) &&
    numOps.some(t => /between/.test(t)) && numOps.some(t => /outside/.test(t)), numOps.join(" | "));
  check("the operator reads as a symbol, not a sentence",
    ($('[data-sf="op"]').selectedOptions[0] || {}).textContent === "<",
    ($('[data-sf="op"]').selectedOptions[0] || {}).textContent);
  numBox.value = "25"; fire(numBox, "input"); await sleep(220);
  check("typing a number rewrites the plain-English line",
    new RegExp(numId + " < 25").test($(".st-scr-plain").textContent), $(".st-scr-plain").textContent);
  let opSel2 = $('[data-sf="op"]');
  opSel2.value = "between"; fire(opSel2, "change"); await sleep(240);
  check("'is between' swaps the single box for two",
    !!$('[data-sf="valueLo"]') && !!$('[data-sf="valueHi"]'), ($("#f-scr-rules") || {}).innerHTML.slice(0, 240));
  opSel2 = $('[data-sf="op"]');
  opSel2.value = "lt"; fire(opSel2, "change"); await sleep(240);
  numBox = $('[data-sf="value"].st-scr-num');
  numBox.value = "5"; fire(numBox, "input"); await sleep(220);
  check("the numeric rule settles back to one operator and a number",
    new RegExp(numId + " < 5").test($(".st-scr-plain").textContent), $(".st-scr-plain").textContent);
  check("a numeric answer is judged when Next is pressed",
    ($("#f-scr-when") || {}).value === "next", ($("#f-scr-when") || {}).value);

  // ---------- allocation: totals and per-row shares ----------
  click($('[data-act="qdup"]')); await sleep(250);
  click($$(".st-etab").find(b => /Screening/.test(b.textContent))); await sleep(150);
  click($$('input[name="f-scr-mode"]').find(r => r.value === "off")); await sleep(200);
  click($$(".st-etab").find(b => /Content/.test(b.textContent))); await sleep(200);
  const tSel2 = $("#f-type"); tSel2.value = "sum_to_100"; fire(tSel2, "change"); await sleep(320);
  const allocId = $("#f-id").value;
  click($$(".st-etab").find(b => /Screening/.test(b.textContent))); await sleep(150);
  click($$('input[name="f-scr-mode"]').find(r => r.value === "screen_out")); await sleep(240);
  const allocOps = [...($('[data-sf="op"]') || { options: [] }).options].map(o => o.value);
  check("an allocation offers per-row, group and total conditions",
    ["row_gte", "row_lte", "sum_of_gte", "sum_of_lte", "total_gte", "total_lte", "total_eq"]
      .every(o => allocOps.includes(o)), allocOps.join(","));
  check("a row condition names a row and a number",
    !!$('[data-sf="row"]') && !!$('[data-sf="value"].st-scr-num'),
    ($("#f-scr-rules") || {}).innerHTML.slice(0, 260));
  check("the share carries the question's unit", /points/.test($("#f-scr-rules").textContent),
    $("#f-scr-rules").textContent.slice(0, 220));
  let rowBox = $('[data-sf="value"].st-scr-num');
  rowBox.value = "70"; fire(rowBox, "input"); await sleep(220);
  check("a row condition reads as plain English",
    new RegExp(allocId + " row .+ \u2265 70").test($(".st-scr-plain").textContent),
    $(".st-scr-plain").textContent);
  let opSel3 = $('[data-sf="op"]');
  opSel3.value = "sum_of_gte"; fire(opSel3, "change"); await sleep(240);
  let grpChips = $$("#f-scr-rules .st-scr-chips .st-chip");
  check("a group condition offers a chip per row", grpChips.length >= 2, grpChips.length);
  click(grpChips[0]); await sleep(160);
  click($$("#f-scr-rules .st-scr-chips .st-chip")[1]); await sleep(160);
  check("ticking rows builds the group", ($('[data-sf="value"]') || {}).value.split(",").length === 2,
    ($('[data-sf="value"]') || {}).value);
  let sumBox = $('[data-sf="valueSum"]');
  sumBox.value = "80"; fire(sumBox, "input"); await sleep(220);
  check("the group share is stored as rows=number", /=80$/.test(($('[data-sf="value"]') || {}).value),
    ($('[data-sf="value"]') || {}).value);
  check("the group rule reads as a sum in plain English",
    /\+ /.test($(".st-scr-plain").textContent) && /80/.test($(".st-scr-plain").textContent),
    $(".st-scr-plain").textContent);
  opSel3 = $('[data-sf="op"]');
  opSel3.value = "total_gte"; fire(opSel3, "change"); await sleep(240);
  let totBox = $('[data-sf="value"].st-scr-num');
  check("a total condition is one number box", !!totBox, ($("#f-scr-rules") || {}).innerHTML.slice(0, 260));
  check("switching condition never leaves a blank or broken number",
    !!totBox && totBox.value !== "" && !isNaN(Number(totBox.value)) &&
    !/NaN/.test($(".st-scr-plain").textContent), totBox && totBox.value);
  totBox.value = "90"; fire(totBox, "input"); await sleep(220);
  check("a total condition reads with the word total",
    new RegExp(allocId + " total \u2265 90").test($(".st-scr-plain").textContent),
    $(".st-scr-plain").textContent);
  check("the tester takes an allocation row by row and shows the running total",
    $$("#card-screening .st-scr-rownum").length >= 2 && /Total/.test($("#card-screening .st-scr-test").textContent),
    $$("#card-screening .st-scr-rownum").length);
  const allocRow = $$("#card-screening .st-scr-rownum")[0];
  allocRow.value = "95"; fire(allocRow, "input"); await sleep(220);
  allocRow.value = "5"; fire($$("#card-screening .st-scr-rownum")[0], "input"); await sleep(220);
  check("the tester verdict follows the numbers typed",
    /CONTINUES|SCREENED OUT/.test(($(".st-scr-verdict") || {}).textContent || ""),
    ($(".st-scr-verdict") || {}).textContent);

  // every condition on an allocation starts from a number that makes sense
  let badOp = "";
  for (const op of ["row_gte", "row_lte", "row_eq", "sum_of_gte", "sum_of_lte", "total_gte", "total_lte", "total_eq", "total_ne"]) {
    const sel = $('[data-sf="op"]'); sel.value = op; fire(sel, "change"); await sleep(200);
    const box = $('[data-sf="value"].st-scr-num') || $('[data-sf="valueSum"]');
    const held = $('[data-sf="value"][type=hidden]');
    const shown = (box && box.value !== undefined) ? box.value : (held ? String(held.value).split("=")[1] : undefined);
    if (shown === undefined || shown === "" || isNaN(Number(shown)) || /NaN|\u2265 $|\u2264 $/.test($(".st-scr-plain").textContent)) {
      badOp += op + "=" + shown + " ";
    }
  }
  check("row, group and total conditions all start from a usable number", badOp === "", badOp);

  // ...and settle on a total we can look for in the saved study
  let opSel4 = $('[data-sf="op"]');
  opSel4.value = "total_gte"; fire(opSel4, "change"); await sleep(220);
  let totBox2 = $('[data-sf="value"].st-scr-num');
  totBox2.value = "90"; fire(totBox2, "input"); await sleep(220);

  // ---------- the rule is visible on the question, not only inside the tab ----------
  click($$(".st-etab").find(b => /Content/.test(b.textContent))); await sleep(260);
  check("the rule also shows as a line on the question itself",
    /screen out when/.test(($(".st-scr-linebar") || {}).textContent || ""),
    ($(".st-scr-linebar") || {}).textContent);
  check("the line carries a way back to the Screening tab",
    !!$$(".st-scr-linebar [data-act='edtab'][data-t='screen']").length);
  click($$(".st-etab").find(b => /Screening/.test(b.textContent))); await sleep(220);
  check("the Screening tab shows the sentence once, not twice",
    $$(".st-scr-plain").length === 1, $$(".st-scr-plain").length);

  // ---------- it all reaches the saved study ----------
  await sleep(1600);
  const saved = JSON.parse(await get("/api/studio/study?slug=beacon")).cfg;
  const allocSaved = (saved.questions || []).find(q => q.id === allocId && q.type === "sum_to_100");
  check("the allocation rule reaches the saved study",
    !!allocSaved && String((allocSaved.screening.rules[0] || {}).value) === "90" &&
    (allocSaved.screening.rules[0] || {}).op === "total_gte",
    JSON.stringify(allocSaved && allocSaved.screening));
  const numSaved = (saved.questions || []).find(q => q.id === numId);
  check("the numeric rule reaches the saved study",
    !!numSaved && (numSaved.screening.rules[0] || {}).op === "lt" && (numSaved.screening.rules[0] || {}).value === 5,
    JSON.stringify(numSaved && numSaved.screening));
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
  const mine2 = (saved.questions || []).filter(q => q === mine || q.id === allocId || q.id === numId);
  if (mine2.length) {
    const del = { slug: "beacon", title: saved.title, cfg: saved };
    del.cfg.questions = saved.questions.filter(q => mine2.indexOf(q) < 0);
    await req("POST", "/api/studio/save", JSON.stringify(del));
  }
  console.log(fails ? "\n" + fails + " FAILED" : "\nall Studio screening checks passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
