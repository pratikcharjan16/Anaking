/* Comprehensive test for:
   1. Multi-perspective "Answer by voice" (numbers, words, ordinals, 1st/2nd/3rd, letters,
      homophones, conversational sentences, UK/US spelling, labels containing "and",
      scale anchor labels, space-separated ratings, "all 4" batch rating, choice-grid, ranking).
   2. On-screen Straight-Line Flag (.straightline-flag-banner + .coach.warn + .voice-bar)
      when filling a Rating Scale or Rating Grid by voice, and dynamic clearing when adjusted. */
let JSDOM;
try { ({ JSDOM } = require("jsdom")); } catch (e) { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
const http = require("http");
const BASE = process.env.BASE || "http://127.0.0.1:8013";

function req(method, p, body) {
  return new Promise((res, rej) => {
    const u = new URL(BASE + p);
    const h = {};
    if (body) h["Content-Type"] = "application/json";
    const r = http.request(u, { method, headers: h }, x => {
      let d = "";
      x.on("data", c => d += c);
      x.on("end", () => res({ status: x.statusCode, body: d }));
    });
    r.on("error", rej);
    if (body) r.write(body);
    r.end();
  });
}
const get = p => req("GET", p).then(r => r.body);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (l, c, d = "") => {
  console.log((c ? "PASS  " : "FAIL  ") + l + (c ? "" : "  -> " + d));
  if (!c) fails++;
};

/* ---------------- 1. Pure Parser Multi-Perspective Checks ---------------- */
function testMultiPerspectiveParser() {
  global.window = {};
  delete require.cache[require.resolve("../../static/js/voice.js")];
  require("../../static/js/voice.js");
  const B = global.window.BeaconVoice;

  const optsCtx = {
    options: [
      { code: "1", label: "Medical Oncology" },
      { code: "2", label: "Haematology" },
      { code: "3", label: "Safety and tolerability" },
      { code: "4", label: "Immunotherapy" },
      { code: "98", label: "None of these", exclusive: true }
    ],
    multi: false
  };
  const pickCode = txt => {
    const a = B.parseCommand(txt, optsCtx);
    return a.map(x => x.act === "pick" ? x.code : x.act).join(",");
  };

  check("word number: 'option two' -> 2", pickCode("option two") === "2", pickCode("option two"));
  check("compound prefix: 'option number 2' -> 2", pickCode("option number 2") === "2", pickCode("option number 2"));
  check("compound word prefix: 'option number two' -> 2", pickCode("option number two") === "2", pickCode("option number two"));
  check("conversational number: 'I choose option 2' -> 2", pickCode("I choose option 2") === "2", pickCode("I choose option 2"));
  check("conversational word: 'select the second option' -> 2", pickCode("select the second option") === "2", pickCode("select the second option"));
  check("digit ordinal: '2nd' -> 2", pickCode("2nd") === "2" && pickCode("the 2nd option") === "2", pickCode("2nd"));
  check("letter code: 'option B' and 'B' -> 2", pickCode("option B") === "2" && pickCode("B") === "2", pickCode("option B"));
  check("STT homophone: 'to' -> 2 and 'for' -> 4", pickCode("to") === "2" && pickCode("for") === "4", pickCode("to") + "/" + pickCode("for"));
  check("explicit option code: '98' and 'option 98' -> 98", pickCode("98") === "98" && pickCode("option 98") === "98", pickCode("98"));
  check("UK/US spelling: 'hematology' matches 'Haematology'", pickCode("hematology") === "2", pickCode("hematology"));
  check("suffix stemming: 'medical oncologist' matches 'Medical Oncology'", pickCode("medical oncologist") === "1", pickCode("medical oncologist"));
  check("conversational label: 'My specialty is Haematology' -> 2", pickCode("My specialty is Haematology") === "2", pickCode("My specialty is Haematology"));
  check("label containing 'and': 'Safety and tolerability' stays 1 pick (3)", pickCode("Safety and tolerability") === "3", pickCode("Safety and tolerability"));
  check("pick + next in one breath: 'option 2 and next' -> 2,next", pickCode("option 2 and next") === "2,next", pickCode("option 2 and next"));

  const multiCtx = Object.assign({}, optsCtx, { multi: true });
  const pickMulti = txt => B.parseCommand(txt, multiCtx).map(x => x.act === "pick" ? x.code : x.act).join(",");
  check("multi-select with label containing 'and' + another option",
    pickMulti("Safety and tolerability and Immunotherapy") === "3,4",
    pickMulti("Safety and tolerability and Immunotherapy"));
  check("multi-select 'select all' picks all non-exclusive options",
    pickMulti("select all") === "1,2,3,4", pickMulti("select all"));

  // Rating scale multi-perspective checks
  const ratingCtx = {
    type: "rating_scale",
    inputType: "number",
    activeFieldIndex: 0,
    fieldsCount: 3,
    rows: [
      { code: "r1", label: "Progression-free survival demonstrated in pivotal trial" },
      { code: "r2", label: "Ease of oral administration" },
      { code: "r3", label: "Manageable toxicity profile" }
    ],
    scale: { min: 1, max: 5, min_label: "Not at all important", mid_label: "Moderately important", max_label: "Critically important" }
  };
  check("scale anchor label: 'Critically important' -> 5",
    B.parseCommand("Critically important", ratingCtx)[0].value === 5);
  check("scale anchor label: 'Not at all important' -> 1",
    B.parseCommand("Not at all important", ratingCtx)[0].value === 1);
  check("partial row label match: 'progression free survival 5' -> row 0 = 5",
    JSON.stringify(B.parseCommand("progression free survival 5", ratingCtx)[0]) === JSON.stringify({ act: "fieldValue", index: 0, value: 5 }),
    JSON.stringify(B.parseCommand("progression free survival 5", ratingCtx)));
  check("conversational row label + scale label: 'for toxicity profile give Moderately important'",
    JSON.stringify(B.parseCommand("for toxicity profile give Moderately important", ratingCtx)[0]) === JSON.stringify({ act: "fieldValue", index: 2, value: 3 }),
    JSON.stringify(B.parseCommand("for toxicity profile give Moderately important", ratingCtx)));
  check("space-separated spoken numbers: 'four five three' -> [4, 5, 3]",
    JSON.stringify(B.parseCommand("four five three", ratingCtx).map(x => x.value)) === "[4,5,3]",
    JSON.stringify(B.parseCommand("four five three", ratingCtx)));
  check("batch rating command: 'all 4' -> rates all 3 rows as 4",
    JSON.stringify(B.parseCommand("all 4", ratingCtx)) === JSON.stringify([
      { act: "fieldValue", index: 0, value: 4 },
      { act: "fieldValue", index: 1, value: 4 },
      { act: "fieldValue", index: 2, value: 4 }
    ]),
    JSON.stringify(B.parseCommand("all 4", ratingCtx)));
}

/* ---------------- 2. Live DOM Test: Rating Scale Voice + Straight-Line Flag ---------------- */
function FakeSR() {
  FakeSR.last = this;
  this.onresult = null;
  this.onend = null;
  this.onerror = null;
  this.starts = 0;
}
FakeSR.prototype.start = function () { this.starts++; };
FakeSR.prototype.stop = function () { if (this.onend) this.onend(); };

function say(text) {
  const rec = FakeSR.last;
  if (!rec || !rec.onresult) throw new Error("recognition not started");
  rec.onresult({ resultIndex: 0, results: [{ isFinal: true, length: 1, 0: { transcript: text } }] });
}

(async () => {
  testMultiPerspectiveParser();

  const cfg = {
    sections: [{ id: "S1", title: "Voice & Straight-Line Check" }],
    questions: [
      {
        id: "Q1",
        section: "S1",
        type: "single_select",
        stem: "What is your primary specialty?",
        required: true,
        options: [
          { code: 1, label: "Medical Oncology" },
          { code: 2, label: "Haematology" },
          { code: 3, label: "Safety and tolerability" }
        ]
      },
      {
        id: "Q9",
        section: "S1",
        type: "rating_scale",
        stem: "Rate each clinical attribute from 1 to 5.",
        required: true,
        rows: [
          { code: "r1", label: "Progression-Free Survival" },
          { code: "r2", label: "Oral Dosing Convenience" },
          { code: "r3", label: "Grade 3+ Tolerability Profile" }
        ],
        scale: { min: 1, max: 5, min_label: "Poor", mid_label: "Neutral", max_label: "Excellent" }
      }
    ],
    qc: { min_seconds: 0, straightline_q: "Q9" }
  };

  const slug = JSON.parse((await req("POST", "/api/studio/save", JSON.stringify({ title: "Voice SL Test", cfg }))).body).slug;
  await req("POST", "/api/studio/status", JSON.stringify({ slug, status: "live" }));
  await req("POST", "/admin/reset?study=" + slug + "&scope=all");

  const url = "/survey/" + slug + "/test";
  const dom = new JSDOM(await get(url), { url: BASE + url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  w.requestAnimationFrame = fn => setTimeout(fn, 0);
  w.Element.prototype.scrollIntoView = function () {};
  w.fetch = (u, o) => {
    const U = new URL(u, BASE);
    return req((o && o.method) || "GET", U.pathname + U.search, o && o.body).then(x => ({
      ok: x.status < 400,
      status: x.status,
      json: () => Promise.resolve(JSON.parse(x.body))
    }));
  };
  w.STUDY = { slug };
  w.webkitSpeechRecognition = FakeSR;
  for (const f of ["qlogic.js", "voice.js", "explainer.js", "survey.js"]) {
    w.eval(await get("/static/js/" + f));
  }
  await sleep(600);

  const $ = s => w.document.querySelector(s);
  const $$ = s => [...w.document.querySelectorAll(s)];

  // Start in voice mode
  $('input[name="voice-pref"][value="voice"]').click();
  $("#start-btn").click();
  await sleep(500);

  // Answer Q1 using US spelling "hematology" + "and next"
  say("My specialty is hematology");
  await sleep(200);
  check("Q1 answered via conversational US-spelling 'My specialty is hematology'",
    $('#app .opt[data-code="2"] input').checked === true);
  say("next");
  await sleep(450);

  // Now on Q9 (Rating Scale with 3 rows)
  check("Now on Q9 rating scale", $$("#app .rating-scale [role=slider]").length === 3);
  check("No straight-line flag before rating", !$("#app .straightline-flag-banner"));

  // Fill all 3 rows with the same rating (4) by voice one by one
  say("four");
  await sleep(120);
  say("for"); // homophone for 4
  await sleep(120);
  say("4");
  await sleep(200);

  const sliders = $$("#app .rating-scale [role=slider]");
  check("All 3 rating scale rows set to 4 by voice",
    sliders.map(s => s.getAttribute("aria-valuenow")).join(",") === "4,4,4",
    sliders.map(s => s.getAttribute("aria-valuenow")).join(","));

  const banner = $("#app .straightline-flag-banner");
  check("Straight-Line Flag banner is visible on the screen inside the rating scale",
    !!banner && /STRAIGHT-LINE FLAG/i.test(banner.textContent) && /straightliner_Q9/.test(banner.textContent),
    banner ? banner.textContent : "missing");

  check("Coach message shows Straight-Line Flag warning (not overwritten by 'All rows completed')",
    !!$(".coach.warn") && /Straight-Line Flag/i.test($(".coach-msg").textContent) && /straightliner_Q9/.test($(".coach-msg").textContent),
    $(".coach-msg") ? $(".coach-msg").textContent : "missing");

  check("Voice bar also surfaces the Straight-Line Flag warning",
    /Straight-Line Flag/i.test($(".voice-bar .vb-live").textContent),
    $(".voice-bar .vb-live").textContent);

  // Now adjust Row 2 by voice ("row 2 is 2") -> flag should disappear
  say("row 2 is 2");
  await sleep(200);
  check("Row 2 updated to 2 by voice", sliders[1].getAttribute("aria-valuenow") === "2");
  check("Straight-Line Flag banner clears when ratings are differentiated",
    !$("#app .straightline-flag-banner"));

  // Now batch-rate all rows to "Excellent" (5) by voice ("all Excellent") -> flag should reappear!
  say("all Excellent");
  await sleep(200);
  check("'all Excellent' sets all 3 rows to 5",
    sliders.map(s => s.getAttribute("aria-valuenow")).join(",") === "5,5,5",
    sliders.map(s => s.getAttribute("aria-valuenow")).join(","));
  check("Straight-Line Flag banner reappears for all-5 ratings",
    !!$("#app .straightline-flag-banner") && /All 3 rows rated “5”/.test($("#app .straightline-flag-banner").textContent),
    $("#app .straightline-flag-banner") ? $("#app .straightline-flag-banner").textContent : "missing");

  await req("POST", "/api/studio/delete", JSON.stringify({ slug }));
  console.log(fails ? ("\n" + fails + " FAIL") : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error("CRASH", e);
  process.exit(2);
});
