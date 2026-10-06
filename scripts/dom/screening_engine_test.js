/* Screening engine (screen in / screen out) - pure node, no server needed.
 *
 *   node scripts/dom/screening_engine_test.js
 *
 * Exercises static/js/qlogic.js: option groups, counts, cross-question rules,
 * qualify mode, the legacy `terminate` / `terminate_if_lt` shorthand, the
 * live-vs-next phases and the plain-English summaries.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "static", "js", "qlogic.js"), "utf8");

const sandbox = { window: {}, console };
sandbox.window.BeaconQ = undefined;
vm.createContext(sandbox);
vm.runInContext("var window = this.window; var document = undefined;" + SRC, sandbox);
const Q = sandbox.window.BeaconQ;

let fails = 0;
const check = (label, cond, detail = "") => {
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond ? "" : "  -> " + detail));
  if (!cond) fails++;
};

const SPECIALTY = {
  id: "Q1", type: "single_select", stem: "Specialty",
  options: [
    { code: 1, label: "Medical oncology" },
    { code: 2, label: "Haem/onc" },
    { code: 3, label: "Thoracic oncology" },
    { code: 4, label: "Haematology only" },
    { code: 5, label: "Radiation oncology" },
    { code: 6, label: "Surgical oncology" },
  ],
};
const VOLUME = {
  id: "Q3", type: "numeric", stem: "Patients per month",
  screening: {
    mode: "qualify", match: "any", when: "next",
    rules: [{ q: "Q3", op: "gte", value: 5 }],
  },
};
const BRANDS = {
  id: "Q5", type: "multi_select", stem: "Which brands",
  options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" },
            { code: 4, label: "None of these", exclusive: true }],
};
const GRID = {
  id: "Q7", type: "rating_grid", stem: "Barriers",
  scale: { min: 1, max: 5 },
  rows: [{ code: "pa", label: "Prior auth" }, { code: "st", label: "Step therapy" }],
};
const RANK = {
  id: "Q9", type: "rank", stem: "Rank the drivers",
  rows: [{ code: "eff", label: "Efficacy" }, { code: "tol", label: "Tolerability" }, { code: "cost", label: "Cost" }],
};
const VERB = { id: "Q11", type: "open_text", stem: "Why?" };

const QUESTIONS = [SPECIALTY, VOLUME, BRANDS, GRID, RANK, VERB];
const verdict = (answers, opts) => Q.screeningVerdict(QUESTIONS, answers, opts || {});

// ------------------------------------------------------------------ legacy shorthand
SPECIALTY.options[4].terminate = true;
SPECIALTY.options[5].terminate = true;

check("legacy terminate options are read as a screening block",
  Q.screening(SPECIALTY).length === 1 && Q.screening(SPECIALTY)[0].source === "options");
check("picking a terminating option screens out",
  (verdict({ Q1: { _: 5 } }) || {}).qid === "Q1");
check("a non-terminating option continues",
  verdict({ Q1: { _: 1 } }) === null);
check("the legacy block fires live, as soon as the option is picked",
  (verdict({ Q1: { _: 6 } }, { phase: "live" }) || {}).qid === "Q1");
check("screen-out reason names the question",
  /Q1/.test((verdict({ Q1: { _: 5 } }) || {}).reason || ""),
  JSON.stringify(verdict({ Q1: { _: 5 } })));
delete SPECIALTY.options[4].terminate;
delete SPECIALTY.options[5].terminate;

// ------------------------------------------------------------------ option groups
SPECIALTY.screening = { mode: "screen_out", match: "any", when: "live", rules: [{ q: "Q1", op: "any_of", value: "5,6" }] };
check("group 'any of' screens out on a member", (verdict({ Q1: { _: 6 } }) || {}).qid === "Q1");
check("group 'any of' lets an outsider through", verdict({ Q1: { _: 3 } }) === null);

SPECIALTY.screening.rules = [{ q: "Q1", op: "none_of", value: "1,2,3" }];
check("'none of' screens out an outsider", (verdict({ Q1: { _: 4 } }) || {}).qid === "Q1");
check("'none of' keeps an insider", verdict({ Q1: { _: 2 } }) === null);

BRANDS.screening = { mode: "screen_out", match: "all", when: "live", rules: [{ q: "Q5", op: "all_of", value: "1,2" }] };
check("'includes all of' needs every code", verdict({ Q5: { codes: [1] } }) === null);
check("'includes all of' fires when all are ticked", (verdict({ Q5: { codes: [1, 2, 3] } }) || {}).qid === "Q5");

BRANDS.screening.rules = [{ q: "Q5", op: "exactly", value: "4" }];
check("'exactly' fires on the exclusive option alone",
  (verdict({ Q5: { codes: [4] } }) || {}).qid === "Q5");
check("'exactly' does not fire when something else is ticked too",
  verdict({ Q5: { codes: [1, 4] } }) === null);

BRANDS.screening.rules = [{ q: "Q5", op: "count_gte", value: 3 }];
check("count rule screens out at three picks", (verdict({ Q5: { codes: [1, 2, 3] } }) || {}).qid === "Q5");
check("count rule allows two picks", verdict({ Q5: { codes: [1, 2] } }) === null);

// ------------------------------------------------------------------ qualify mode
check("qualify: a qualifying volume continues", verdict({ Q3: { _: 12 } }) === null);
check("qualify: too few patients screens out", (verdict({ Q3: { _: 3 } }) || {}).qid === "Q3");
check("qualify: a blank answer is still pending, not a screen-out",
  verdict({ Q3: {} }) === null);
delete VOLUME.screening;

// ------------------------------------------------------------------ cross-question rules
delete SPECIALTY.screening;
delete BRANDS.screening;
VOLUME.screening = {
  mode: "screen_out", match: "all", when: "next", reason: "Haematology-only, low volume",
  rules: [{ q: "Q1", op: "selected", value: 4 }, { q: "Q3", op: "lt", value: 10 }],
};
check("cross-question rule fires when both hold", (verdict({ Q1: { _: 4 }, Q3: { _: 8 } }) || {}).qid === "Q3");
check("cross-question rule ignores a different specialty", verdict({ Q1: { _: 2 }, Q3: { _: 8 } }) === null);
check("cross-question rule ignores a high volume", verdict({ Q1: { _: 4 }, Q3: { _: 30 } }) === null);
check("cross-question rule waits for both answers", verdict({ Q3: { _: 8 } }) === null);
check("the author's reason is carried into the data",
  (verdict({ Q1: { _: 4 }, Q3: { _: 8 } }) || {}).reason === "Haematology-only, low volume");
check("a 'next' rule does not fire during the live phase",
  verdict({ Q1: { _: 4 }, Q3: { _: 8 } }, { phase: "live" }) === null);
check("the custom message survives into the verdict",
  (function () {
    VOLUME.screening.message = "Thank you, but this study needs higher-volume clinicians.";
    var v = verdict({ Q1: { _: 4 }, Q3: { _: 8 } });
    return v && v.message.indexOf("higher-volume") > 0;
  })());
delete VOLUME.screening;

// ------------------------------------------------------------------ grids, ranks, text
GRID.screening = { mode: "screen_out", match: "all", when: "live", rules: [{ q: "Q7", op: "row_gte", value: "pa=4" }] };
check("grid row rule fires on a high rating", (verdict({ Q7: { pa: 5, st: 2 } }) || {}).qid === "Q7");
check("grid row rule ignores a low rating", verdict({ Q7: { pa: 2, st: 2 } }) === null);
check("grid rule waits until every row is answered", verdict({ Q7: { pa: 5 } }) === null);
delete GRID.screening;

RANK.screening = { mode: "screen_out", match: "all", when: "live", rules: [{ q: "Q9", op: "ranked_first", value: "cost" }] };
check("rank: cost first screens out", (verdict({ Q9: { order: ["cost", "eff", "tol"] } }) || {}).qid === "Q9");
check("rank: efficacy first continues", verdict({ Q9: { order: ["eff", "cost", "tol"] } }) === null);
RANK.screening.rules = [{ q: "Q9", op: "ranked_top", value: "cost=2" }];
check("rank: cost in the top two screens out", (verdict({ Q9: { order: ["eff", "cost", "tol"] } }) || {}).qid === "Q9");
delete RANK.screening;

VERB.screening = { mode: "screen_out", match: "all", when: "next", rules: [{ q: "Q11", op: "contains", value: "no idea" }] };
check("text rule matches the phrase", (verdict({ Q11: { _: "No idea really" } }) || {}).qid === "Q11");
check("text rule ignores other answers", verdict({ Q11: { _: "Efficacy data" } }) === null);
VERB.screening.rules = [{ q: "Q11", op: "words_lt", value: 3 }];
check("word-count rule fires on a two-word answer", (verdict({ Q11: { _: "Too short" } }) || {}).qid === "Q11");
delete VERB.screening;

// ------------------------------------------------------------------ plain English + typing
SPECIALTY.screening = { mode: "screen_out", match: "any", when: "live", rules: [{ q: "Q1", op: "any_of", value: "5,6" }] };
const sum = Q.screenSummary(SPECIALTY, QUESTIONS);
check("summary reads as a sentence",
  sum.length === 1 && /screen out when Q1 is any of Radiation oncology, Surgical oncology/.test(sum[0].text),
  JSON.stringify(sum));
check("operator list is filtered by question type",
  Q.opsFor(SPECIALTY).some(o => o.op === "any_of") && !Q.opsFor(SPECIALTY).some(o => o.op === "row_eq"));
check("grid questions offer row conditions", Q.opsFor(GRID).some(o => o.op === "row_gte"));
check("rank questions offer rank conditions", Q.opsFor(RANK).some(o => o.op === "ranked_first"));
check("text questions offer word conditions", Q.opsFor(VERB).some(o => o.op === "words_lt"));
check("every question type offers answered / not_answered",
  Q.opsFor(GRID).some(o => o.op === "answered") && Q.opsFor(SPECIALTY).some(o => o.op === "not_answered"));
delete SPECIALTY.screening;

console.log(fails ? "\n" + fails + " FAILED" : "\nall screening engine checks passed");
process.exit(fails ? 1 : 0);
