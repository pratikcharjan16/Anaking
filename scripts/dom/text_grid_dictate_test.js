/* End-to-end JSDOM test for continuous voice dictation ("Dictate") on text_grid cells.
   Verifies that speaking multiple words, phrases, and sentences in continuation builds
   a live transcript and full paragraph without replacing prior words with only the latest word. */
let JSDOM;
try { ({ JSDOM } = require("jsdom")); } catch (e) { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
const http = require("http");
const BASE = process.env.BASE || "http://127.0.0.1:8011";

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

function FakeSR() {
  FakeSR.last = this;
  FakeSR.instances.push(this);
  this.onresult = null;
  this.onend = null;
  this.onerror = null;
  this.starts = 0;
  this.stops = 0;
}
FakeSR.instances = [];
FakeSR.prototype.start = function () { this.starts++; };
FakeSR.prototype.stop = function () { this.stops++; if (this.onend) this.onend(); };

function makeResults(arr) {
  const out = arr.map(item => ({
    isFinal: !!item.isFinal,
    length: 1,
    0: { transcript: item.text }
  }));
  return out;
}

(async () => {
  const cfg = {
    sections: [{ id: "S1", title: "Clinical Grid Feedback" }],
    questions: [
      {
        id: "TG1",
        section: "S1",
        type: "text_grid",
        stem: "Provide detailed clinical observations across lines of therapy.",
        required: true,
        rows: [
          { code: "r1", label: "First-line setting" },
          { code: "r2", label: "Second-line setting" }
        ],
        cols: [
          { code: "c1", label: "Efficacy observations" },
          { code: "c2", label: "Safety & tolerability" }
        ]
      }
    ],
    qc: { min_seconds: 0 }
  };

  const slug = JSON.parse((await req("POST", "/api/studio/save", JSON.stringify({ title: "Text Grid Dictate Test", cfg }))).body).slug;
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

  // Start survey in manual mode so per-cell Dictate buttons are tested directly
  $("#start-btn").click();
  await sleep(500);

  const cells = $$("#app textarea.tg-input");
  const btns = $$("#app button.tg-voice-btn");
  check("4 text_grid cells rendered", cells.length === 4, "got " + cells.length);
  check("4 Dictate buttons rendered", btns.length === 4, "got " + btns.length);

  // ---------------- Scenario A: Multi-segment continuous speech where resultIndex advances ----------------
  btns[0].click();
  check("Cell 1 Dictate button enters recording state", btns[0].classList.contains("recording"));
  let sr = FakeSR.last;
  check("Cell 1 SpeechRecognition uses continuous=true and interimResults=true",
    sr && sr.continuous === true && sr.interimResults === true);

  // User speaks segment 0 (interim), then segment 1 (resultIndex=1 while segment 0 is still interim), then segment 2 (resultIndex=2)
  sr.onresult({
    resultIndex: 0,
    results: makeResults([
      { text: "The patient", isFinal: false }
    ])
  });
  check("Cell 1 interim word 1", cells[0].value === "The patient", cells[0].value);

  sr.onresult({
    resultIndex: 1,
    results: makeResults([
      { text: "The patient", isFinal: false },
      { text: "showed strong", isFinal: false }
    ])
  });
  check("Cell 1 interim phrase 2 appends instead of replacing",
    cells[0].value === "The patient showed strong", cells[0].value);

  sr.onresult({
    resultIndex: 2,
    results: makeResults([
      { text: "The patient", isFinal: true },
      { text: "showed strong", isFinal: false },
      { text: "response in cycle one.", isFinal: false }
    ])
  });
  check("Cell 1 interim phrase 3 builds full sentence",
    cells[0].value === "The patient showed strong response in cycle one.", cells[0].value);

  sr.onresult({
    resultIndex: 3,
    results: makeResults([
      { text: "The patient", isFinal: true },
      { text: "showed strong", isFinal: true },
      { text: "response in cycle one.", isFinal: true },
      { text: "Biomarker levels dropped rapidly across follow-up visits.", isFinal: true }
    ])
  });
  check("Cell 1 second sentence continues into a paragraph",
    cells[0].value === "The patient showed strong response in cycle one. Biomarker levels dropped rapidly across follow-up visits.",
    cells[0].value);
  btns[0].click(); // Stop
  check("Cell 1 Dictate stops cleanly and keeps full paragraph",
    !btns[0].classList.contains("recording") &&
    cells[0].value === "The patient showed strong response in cycle one. Biomarker levels dropped rapidly across follow-up visits.",
    cells[0].value);

  // ---------------- Scenario B: Engine overwrites slot 0 with each new word ----------------
  btns[1].click();
  sr = FakeSR.last;
  const wordStream = ["First", "sentence", "is", "complete.", "Second", "sentence", "forms", "a", "paragraph."];
  for (let i = 0; i < wordStream.length; i++) {
    sr.onresult({
      resultIndex: 0,
      results: makeResults([{ text: wordStream[i], isFinal: i === 3 || i === wordStream.length - 1 }])
    });
  }
  check("Cell 2 word-by-word slot-0 overwrite accumulates every word into a paragraph",
    cells[1].value === "First sentence is complete. Second sentence forms a paragraph.",
    cells[1].value);
  btns[1].click();

  // ---------------- Scenario C: Pauses between sentences firing onend + auto-restart ----------------
  btns[2].click();
  sr = FakeSR.last;
  sr.onresult({
    resultIndex: 0,
    results: makeResults([{ text: "Clinical efficacy remains durable across subgroups.", isFinal: false }])
  });
  // Browser ends session on pause without even sending isFinal=true
  sr.onend();
  await sleep(90); // auto-restart fires
  sr.onresult({
    resultIndex: 0,
    results: makeResults([{ text: "Tolerability was manageable with standard dose modifications.", isFinal: false }])
  });
  sr.onend();
  await sleep(90);
  sr.onresult({
    resultIndex: 0,
    results: makeResults([{ text: "Overall we recommend expanding first-line adoption.", isFinal: true }])
  });
  btns[2].click();
  check("Cell 3 preserves uncommitted speech across onend pauses and builds 3-sentence paragraph",
    cells[2].value === "Clinical efficacy remains durable across subgroups. Tolerability was manageable with standard dose modifications. Overall we recommend expanding first-line adoption.",
    cells[2].value);

  // ---------------- Scenario D: Pre-existing typed text + dictation + manual edit + second dictation ----------------
  cells[3].value = "Initial note:";
  cells[3].dispatchEvent(new w.Event("input", { bubbles: true }));
  btns[3].click();
  sr = FakeSR.last;
  sr.onresult({
    resultIndex: 0,
    results: makeResults([{ text: "biomarker positive patients", isFinal: false }])
  });
  check("Cell 4 appends dictated phrase after pre-existing typed text",
    cells[3].value === "Initial note: biomarker positive patients", cells[3].value);

  // User manually adds a comma while dictation is still active
  cells[3].value = "Initial note: biomarker positive patients,";
  cells[3].dispatchEvent(new w.Event("input", { bubbles: true }));

  // Speech continues in same slot with extended transcript
  sr.onresult({
    resultIndex: 0,
    results: makeResults([{ text: "biomarker positive patients achieved 78% ORR in phase 3.", isFinal: true }])
  });
  btns[3].click();
  check("Cell 4 preserves manual mid-dictation comma and continues sentence",
    cells[3].value === "Initial note: biomarker positive patients, achieved 78% ORR in phase 3.",
    cells[3].value);

  // Click Dictate a second time on Cell 4 to add another sentence
  btns[3].click();
  sr = FakeSR.last;
  sr.onresult({
    resultIndex: 0,
    results: makeResults([{ text: "Follow-up continues at 12 months.", isFinal: true }])
  });
  btns[3].click();
  check("Cell 4 second Dictate session appends to existing paragraph",
    cells[3].value === "Initial note: biomarker positive patients, achieved 78% ORR in phase 3. Follow-up continues at 12 months.",
    cells[3].value);

  await req("POST", "/api/studio/delete", JSON.stringify({ slug }));
  console.log(fails ? ("\n" + fails + " FAIL") : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error("CRASH", e);
  process.exit(2);
});
