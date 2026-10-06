/* BEACON question logic shared by the respondent survey and the Studio preview.
 *
 *   BeaconQ.sanitize(html)             whitelist rich text (mirrors core/sanitize.py)
 *   BeaconQ.pipe(text, ctx)            replace {Q1} {Q1.text} {Q1.opt:3} ... with answers
 *   BeaconQ.richInto(el, html, ctx)    sanitize + pipe + inject as DOM
 *   BeaconQ.showIf(q, ctx)             evaluate q.show_if -> true/false
 *   BeaconQ.screening(q)               screening blocks of a question (explicit + legacy)
 *   BeaconQ.screeningVerdict(qs, a, o) first block that ends the survey -> {qid,reason,message}|null
 *   BeaconQ.screenSummary(q, qs)       the same rules in plain English, one line per block
 *   BeaconQ.opsFor(q)                  conditions valid for that question type
 *   BeaconQ.order(list, q, seed)       apply q.randomize to options / rows (pinned kept)
 *   BeaconQ.sampleAnswers(questions)   plausible answers for every question (preview/piping)
 *
 * ctx = { answers: {qid: {...}}, questions: [...] }
 */
(function () {
  "use strict";

  var TAGS = { b: 1, strong: 1, i: 1, em: 1, u: 1, s: 1, span: 1, mark: 1, sup: 1, sub: 1, br: 1,
               p: 1, div: 1, ul: 1, ol: 1, li: 1, a: 1, font: 1,
               table: 1, thead: 1, tbody: 1, tr: 1, td: 1, th: 1 };
  var STYLE = { "color": 1, "background-color": 1, "font-family": 1, "font-size": 1, "font-weight": 1,
                "font-style": 1, "text-decoration": 1, "text-align": 1 };
  var STYLE_VAL = /^[#a-zA-Z0-9 ,.%()'"-]+$/;

  function cleanStyle(v) {
    var out = [];
    String(v || "").split(";").forEach(function (d) {
      var i = d.indexOf(":"); if (i < 0) return;
      var p = d.slice(0, i).trim().toLowerCase(), val = d.slice(i + 1).trim();
      if (STYLE[p] && val && STYLE_VAL.test(val) && val.toLowerCase().indexOf("url(") < 0) out.push(p + ": " + val);
    });
    return out.join("; ");
  }

  function sanitizeNode(node, doc) {
    // returns a clean clone (or a text node / fragment) of node
    if (node.nodeType === 3) return doc.createTextNode(node.nodeValue);
    if (node.nodeType !== 1) return null;
    var tag = node.tagName.toLowerCase();
    var out;
    if (TAGS[tag]) {
      out = doc.createElement(tag);
      var st = node.getAttribute("style");
      if (st) { st = cleanStyle(st); if (st) out.setAttribute("style", st); }
      if (tag === "a") {
        var href = (node.getAttribute("href") || "").trim();
        if (/^(https?:)?\/\/|^mailto:/i.test(href)) {
          out.setAttribute("href", href); out.setAttribute("target", "_blank"); out.setAttribute("rel", "noopener");
        }
      }
      if (tag === "font") {
        ["color", "face", "size"].forEach(function (a) {
          var v = node.getAttribute(a); if (v && STYLE_VAL.test(v)) out.setAttribute(a, v);
        });
      }
      var cls = node.getAttribute("class");
      if (cls && /^[a-zA-Z0-9_ -]+$/.test(cls)) out.setAttribute("class", cls);
    } else if (tag === "script" || tag === "style" || tag === "iframe" || tag === "object" || tag === "embed") {
      return null;
    } else {
      out = doc.createDocumentFragment();       // unknown tag: keep its children only
    }
    for (var c = node.firstChild; c; c = c.nextSibling) {
      var k = sanitizeNode(c, doc); if (k) out.appendChild(k);
    }
    return out;
  }

  function sanitizeToFragment(html) {
    var tpl = document.createElement("template");
    tpl.innerHTML = String(html || "");
    var frag = document.createDocumentFragment();
    for (var c = tpl.content.firstChild; c; c = c.nextSibling) {
      var k = sanitizeNode(c, document); if (k) frag.appendChild(k);
    }
    return frag;
  }

  function sanitize(html) {
    var d = document.createElement("div");
    d.appendChild(sanitizeToFragment(html));
    return d.innerHTML;
  }

  function stripTags(html) {
    var d = document.createElement("div");
    d.appendChild(sanitizeToFragment(String(html || "").replace(/<br\s*\/?>|<\/(p|div|li)>/gi, "\n")));
    return (d.textContent || "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  }

  // ---------------------------------------------------------------- piping
  function findQ(ctx, qid) {
    var qs = (ctx && ctx.questions) || [];
    for (var i = 0; i < qs.length; i++) if (qs[i].id === qid) return qs[i];
    return null;
  }
  function optLabel(q, code) {
    var os = (q && q.options) || [];
    for (var i = 0; i < os.length; i++) if (String(os[i].code) === String(code)) return os[i].label;
    return "";
  }
  function rowLabel(q, code) {
    var rs = (q && q.rows) || [];
    for (var i = 0; i < rs.length; i++) if (String(rs[i].code) === String(code)) return rs[i].label;
    return "";
  }
  function answerText(q, a) {
    if (!q || !a) return "";
    switch (q.type) {
      case "single_select": return a._ === undefined ? "" : (optLabel(q, a._) || String(a._));
      case "multi_select": return (a.codes || []).map(function (c) { return optLabel(q, c) || String(c); }).join(", ");
      case "rank": return (a.order || []).slice(0, q.rank_count || 3).map(function (c) { return rowLabel(q, c) || c; }).join(", ");
      default: return a._ === undefined || a._ === null ? "" : String(a._);
    }
  }

  // {Q1} {Q1.text} {Q1.code} {Q1.other} {Q1.stem} {Q1.opt:2} {Q1.row:a} {Q1.r:a} {Q1.first} {Q1.last}
  var TOKEN = /\{([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+)(?::([A-Za-z0-9_]+))?)?\}/g;

  function resolve(qid, field, arg, ctx) {
    var q = findQ(ctx, qid);
    var a = (ctx && ctx.answers && ctx.answers[qid]) || {};
    if (!q) return "";
    switch (field || "text") {
      case "text": return answerText(q, a);
      case "code": return a._ !== undefined ? String(a._) : (a.codes || []).join(",");
      case "other": return a.other_text || "";
      case "stem": return q.stem || "";
      case "opt": return optLabel(q, arg);
      case "row": return rowLabel(q, arg);
      case "r": return a[arg] === undefined ? "" : String(a[arg]);
      case "first": return (a.codes && a.codes.length) ? optLabel(q, a.codes[0]) : (a.order ? rowLabel(q, a.order[0]) : answerText(q, a));
      case "last": return (a.codes && a.codes.length) ? optLabel(q, a.codes[a.codes.length - 1]) : (a.order ? rowLabel(q, a.order[a.order.length - 1]) : answerText(q, a));
    }
    return "";
  }

  function pipe(text, ctx, fallback) {
    return String(text == null ? "" : text).replace(TOKEN, function (m, qid, field, arg) {
      var v = resolve(qid, field, arg, ctx);
      return v === "" ? (fallback === undefined ? "" : fallback) : v;
    });
  }

  function pipeFragment(frag, ctx, fallback) {
    var walker = document.createTreeWalker(frag, 4 /* TEXT */);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (n) { if (TOKEN.test(n.nodeValue)) { TOKEN.lastIndex = 0; n.nodeValue = pipe(n.nodeValue, ctx, fallback); } TOKEN.lastIndex = 0; });
    return frag;
  }

  function richInto(el, html, ctx, fallback) {
    el.innerHTML = "";
    el.appendChild(pipeFragment(sanitizeToFragment(html), ctx, fallback));
    return el;
  }

  // ---------------------------------------------------------------- show-if
  function isAnswered(q, a) {
    if (!q || !a) return false;
    if (q.type === "multi_select") return (a.codes || []).length > 0;
    if (q.type === "rank") return (a.order || []).length > 0;
    if (a._ !== undefined && a._ !== "") return true;
    return Object.keys(a).some(function (k) { return k !== "_order" && a[k] !== undefined && a[k] !== ""; });
  }
  function ruleTrue(r, ctx) {
    var q = findQ(ctx, r.q);
    var a = (ctx.answers && ctx.answers[r.q]) || {};
    var codes = q && q.type === "multi_select" ? (a.codes || []).map(String)
              : (a._ !== undefined ? [String(a._)] : []);
    var num = Number(a._);
    var want = r.value === undefined || r.value === null ? "" : String(r.value);
    switch (r.op) {
      case "answered": return isAnswered(q, a);
      case "not_answered": return !isAnswered(q, a);
      case "selected": return codes.indexOf(want) >= 0;
      case "not_selected": return codes.indexOf(want) < 0;
      case "any_of": return want.split(",").some(function (v) { return codes.indexOf(v.trim()) >= 0; });
      case "none_of": return !want.split(",").some(function (v) { return codes.indexOf(v.trim()) >= 0; });
      case "eq": return a._ !== undefined && String(a._) === want;
      case "ne": return a._ === undefined || String(a._) !== want;
      case "gt": return !isNaN(num) && a._ !== undefined && num > Number(want);
      case "gte": return !isNaN(num) && a._ !== undefined && num >= Number(want);
      case "lt": return !isNaN(num) && a._ !== undefined && num < Number(want);
      case "lte": return !isNaN(num) && a._ !== undefined && num <= Number(want);
      case "contains": return String(answerText(q, a)).toLowerCase().indexOf(want.toLowerCase()) >= 0;
      case "row_eq": { var parts = want.split("="); return parts.length === 2 && String(a[parts[0].trim()]) === parts[1].trim(); }
    }
    return true;
  }
  function showIf(q, ctx) {
    var s = q && q.show_if;
    if (!s || !s.rules || !s.rules.length) return true;
    var results = s.rules.map(function (r) { return ruleTrue(r, ctx || {}); });
    var ok = (s.match === "any") ? results.some(Boolean) : results.every(Boolean);
    return s.negate ? !ok : ok;
  }

  // ---------------------------------------------------------------- ordering
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {                      // mulberry32
    var t = seed >>> 0;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      var r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  // list = q.options or q.rows. Items with pin:true keep their index. seed = respondent id.
  function order(list, q, seed) {
    var rz = q && q.randomize;
    var mode = rz && typeof rz === "object" ? rz.mode : rz;
    if (!list || !mode || mode === "none") return list.slice();
    var r = rng(hash(String(seed || "") + "|" + (q.id || "")));
    var free = [], slots = [];
    list.forEach(function (it, i) { if (!it.pin) { free.push(it); slots.push(i); } });
    if (mode === "shuffle") {
      for (var i = free.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = free[i]; free[i] = free[j]; free[j] = t; }
    } else if (mode === "reverse") {            // half the respondents see the list flipped
      if (r() < 0.5) free.reverse();
    } else if (mode === "rotate") {             // random start point, relative order kept
      var k = Math.floor(r() * free.length);
      free = free.slice(k).concat(free.slice(0, k));
    }
    var out = list.slice();
    slots.forEach(function (s, i) { out[s] = free[i]; });
    return out;
  }

  // ---------------------------------------------------------------- screening
  // SCREEN IN / SCREEN OUT - per-question, per-option-group, fully data driven.
  //
  // A question can carry a screening block next to its content:
  //
  //   screening: { mode:  "screen_out" | "qualify",
  //                match: "all" | "any",
  //                when:  "live" | "next",           // as soon as it matches / on Next
  //                message: "text respondents read when it fires",
  //                reason:  "short line recorded in the screen-out report",
  //                rules: [ { q: "Q1", op: "any_of", value: "5,6,7,8" }, ... ] }
  //
  //   screen_out  - when the rules match the respondent is screened out.
  //   qualify     - the respondent may only continue when the rules match;
  //                 everybody else is screened out at this question.
  //
  // The legacy shorthand still works and is merged in as extra blocks, so older
  // studies keep behaving exactly as they did:
  //   options[].terminate = true       -> screens out when that option is picked
  //   terminate_if_lt / terminate_message on a numeric question
  //
  // Everything is evaluated against the same ctx as show-if:
  //   ctx = { answers: {qid: {...}}, questions: [...] }

  // op -> { label, value, kinds }.  kinds [] means "every question type".
  var SCREEN_OPS = [
    { op: "selected",     label: "is",                       value: "codes", kinds: ["choice"] },
    { op: "not_selected", label: "is not",                   value: "codes", kinds: ["choice"] },
    { op: "any_of",       label: "is any of",                value: "codes", kinds: ["choice"] },
    { op: "none_of",      label: "is none of",               value: "codes", kinds: ["choice"] },
    { op: "all_of",       label: "includes all of",          value: "codes", kinds: ["choice", "rank"] },
    { op: "exactly",      label: "is exactly these",         value: "codes", kinds: ["choice"] },
    { op: "count_gte",    label: "selects at least",         value: "count", kinds: ["choice"] },
    { op: "count_lte",    label: "selects at most",          value: "count", kinds: ["choice"] },
    { op: "count_eq",     label: "selects exactly",          value: "count", kinds: ["choice"] },
    { op: "eq",           label: "equals",                   value: "number", kinds: ["number"] },
    { op: "ne",           label: "does not equal",           value: "number", kinds: ["number"] },
    { op: "gt",           label: "is more than",             value: "number", kinds: ["number"] },
    { op: "gte",          label: "is at least",              value: "number", kinds: ["number"] },
    { op: "lt",           label: "is less than",             value: "number", kinds: ["number"] },
    { op: "lte",          label: "is at most",               value: "number", kinds: ["number"] },
    { op: "between",      label: "is between",               value: "between", kinds: ["number"] },
    { op: "contains",     label: "mentions",                 value: "text", kinds: ["text"] },
    { op: "not_contains", label: "does not mention",         value: "text", kinds: ["text"] },
    { op: "words_lt",     label: "is shorter than (words)",  value: "count", kinds: ["text"] },
    { op: "row_eq",       label: "row is",                   value: "rowvalue", kinds: ["grid"] },
    { op: "row_ne",       label: "row is not",               value: "rowvalue", kinds: ["grid"] },
    { op: "row_gte",      label: "row is at least",          value: "rowvalue", kinds: ["grid"] },
    { op: "row_lte",      label: "row is at most",           value: "rowvalue", kinds: ["grid"] },
    { op: "ranked_first", label: "ranks first",              value: "codes", kinds: ["rank"] },
    { op: "ranked_top",   label: "ranks in the top",         value: "ranktop", kinds: ["rank"] },
    { op: "answered",     label: "was answered",             value: "none", kinds: [] },
    { op: "not_answered", label: "was skipped",              value: "none", kinds: [] }
  ];
  var SCREEN_OP_BY_ID = {};
  SCREEN_OPS.forEach(function (o) { SCREEN_OP_BY_ID[o.op] = o; });

  // Which family of controls the condition needs, per question type.
  var TYPE_KIND = {
    single_select: "choice", multi_select: "choice",
    numeric: "number", slider: "number", nps: "number", date: "number", delta: "number",
    open_text: "text", loop: "text",
    rank: "rank",
    rating_grid: "grid", semantic_diff: "grid", sum_to_100: "grid", emoji_grid: "grid",
    heatmap: "grid", numeric_matrix: "grid", concept_test: "grid"
  };
  function qKind(q) { return TYPE_KIND[q && q.type] || "any"; }

  function opsFor(q) {
    var k = qKind(q);
    return SCREEN_OPS.filter(function (o) { return !o.kinds.length || o.kinds.indexOf(k) >= 0; });
  }
  function opInfo(op) { return SCREEN_OP_BY_ID[op] || { op: op, label: op, value: "text", kinds: [] }; }
  function valueKind(op) { return opInfo(op).value; }

  function codeList(value) {
    return String(value === undefined || value === null ? "" : value)
      .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  }
  // the codes the respondent picked for a question, whichever shape the answer has
  function pickedCodes(q, a) {
    a = a || {};
    if (q && q.type === "multi_select") return (a.codes || []).map(String);
    if (q && q.type === "rank") return (a.order || []).map(String);
    if (a._ !== undefined && a._ !== null && String(a._) !== "") return [String(a._)];
    return [];
  }
  function numOf(a) {
    if (!a) return NaN;
    if (a.delta !== undefined && a.before !== undefined) return Number(a.delta);
    return a._ === undefined || a._ === null || a._ === "" ? NaN : Number(a._);
  }
  function textOf(q, a) {
    a = a || {};
    if (q && q.type === "loop") {
      return (q.items || []).map(function (it) { return String(a[it.code] || ""); }).join(" ");
    }
    return String(a._ === undefined || a._ === null ? "" : a._);
  }
  function wordsOf(t) { return String(t).trim().split(/\s+/).filter(Boolean).length; }
  function rowKey(item) { return String(item || "").split("=")[0].trim(); }
  function rowWant(item) { var p = String(item || "").split("="); return p.length > 1 ? p.slice(1).join("=").trim() : ""; }

  function screenRuleTrue(r, ctx) {
    var q = findQ(ctx, r.q);
    var a = (ctx && ctx.answers && ctx.answers[r.q]) || {};
    var codes = pickedCodes(q, a);
    var want = codeList(r.value);
    var num = numOf(a);
    switch (r.op) {
      case "selected": return codes.indexOf(want[0]) >= 0;
      case "not_selected": return codes.indexOf(want[0]) < 0;
      case "any_of": return want.some(function (v) { return codes.indexOf(v) >= 0; });
      case "none_of": return !want.some(function (v) { return codes.indexOf(v) >= 0; });
      case "all_of": return want.length > 0 && want.every(function (v) { return codes.indexOf(v) >= 0; });
      case "exactly": return codes.length === want.length && want.every(function (v) { return codes.indexOf(v) >= 0; });
      case "count_gte": return codes.length >= Number(r.value);
      case "count_lte": return codes.length <= Number(r.value);
      case "count_eq": return codes.length === Number(r.value);
      case "eq": return num === Number(r.value);
      case "ne": return !(num === Number(r.value));
      case "gt": return isFinite(num) && num > Number(r.value);
      case "gte": return isFinite(num) && num >= Number(r.value);
      case "lt": return isFinite(num) && num < Number(r.value);
      case "lte": return isFinite(num) && num <= Number(r.value);
      case "between": {
        var p = String(r.value || "").split("-");
        var lo = Number(p[0]), hi = Number(p[1]);
        return isFinite(num) && num >= lo && num <= hi;
      }
      case "contains": return textOf(q, a).toLowerCase().indexOf(String(r.value || "").toLowerCase()) >= 0;
      case "not_contains": return textOf(q, a).toLowerCase().indexOf(String(r.value || "").toLowerCase()) < 0;
      case "words_lt": return wordsOf(textOf(q, a)) < Number(r.value);
      case "row_eq": case "row_ne": case "row_gte": case "row_lte": {
        var key = rowKey(r.value), target = Number(rowWant(r.value));
        var got = a[key];
        if (got === undefined || got === "" || got === null) return false;
        var g = Number(got);
        if (r.op === "row_eq") return g === target;
        if (r.op === "row_ne") return !(g === target);
        if (r.op === "row_gte") return g >= target;
        return g <= target;
      }
      case "ranked_first": return codes.length > 0 && codes[0] === want[0];
      case "ranked_top": {
        var n = Number(rowWant(r.value));
        return codes.slice(0, n).indexOf(rowKey(r.value)) >= 0;
      }
      case "answered": return isAnswered(q, a);
      case "not_answered": return !isAnswered(q, a);
    }
    return ruleTrue(r, ctx);              // fall back to the show-if operators
  }

  // Every screening block a question carries, explicit + legacy, normalised.
  function screening(q) {
    var out = [];
    if (!q) return out;
    var s = q.screening;
    if (s && s.enabled !== false && (s.rules || []).length) {
      out.push({
        owner: q.id,
        mode: s.mode === "qualify" ? "qualify" : "screen_out",
        match: s.match === "any" ? "any" : "all",
        when: s.when === "next" ? "next" : "live",
        rules: s.rules, message: s.message || "", reason: s.reason || "", source: "rules"
      });
    }
    var term = ((q.options) || []).filter(function (o) { return o.terminate; });
    if (term.length) {
      out.push({
        owner: q.id, mode: "screen_out", match: "any", when: "live",
        rules: term.map(function (o) { return { q: q.id, op: "selected", value: o.code }; }),
        message: q.terminate_message || "", reason: "", source: "options"
      });
    }
    if (q.terminate_if_lt !== undefined && q.terminate_if_lt !== null && String(q.terminate_if_lt) !== "") {
      out.push({
        owner: q.id, mode: "screen_out", match: "all", when: "next",
        rules: [{ q: q.id, op: "lt", value: q.terminate_if_lt }],
        message: q.terminate_message || "", reason: "", source: "legacy"
      });
    }
    return out;
  }
  function hasScreening(q) { return screening(q).length > 0; }

  // Has the respondent finished this question? Stricter than `isAnswered` (which is
  // happy with any answer at all) because a screening rule on a grid should wait for
  // the whole grid, not fire on the first row somebody happens to tap.
  function complete(q, a) {
    a = a || {};
    if (!q) return false;
    switch (q.type) {
      case "single_select": case "numeric": case "slider": case "nps":
      case "open_text": case "date":
        return a._ !== undefined && a._ !== null && String(a._) !== "";
      case "multi_select": return (a.codes || []).length > 0;
      case "rank": return (a.order || []).length === (q.rows || []).length && (q.rows || []).length > 0;
      case "delta": return a.before !== undefined && a.after !== undefined;
      case "sum_to_100": return (q.rows || []).some(function (r) { return a[r.code] !== undefined; });
      case "loop": return (q.items || []).length > 0 && (q.items || []).every(function (it) {
        return String(a[it.code] || "").trim() !== ""; });
      default:
        if ((q.rows || []).length) return (q.rows || []).every(function (r) {
          return a[r.code] !== undefined && a[r.code] !== ""; });
        return isAnswered(q, a);
    }
  }

  // "match" / "no" / "pending" - pending until the questions it reads are answered.
  function blockState(block, ctx) {
    var answers = (ctx && ctx.answers) || {};
    var owner = findQ(ctx, block.owner);
    if (!complete(owner, answers[block.owner])) return "pending";
    for (var i = 0; i < block.rules.length; i++) {
      var r = block.rules[i];
      if (r.q === block.owner) continue;
      if (!isAnswered(findQ(ctx, r.q), answers[r.q] || {})) return "pending";
    }
    var res = block.rules.map(function (r) { return screenRuleTrue(r, ctx); });
    var ok = block.match === "any" ? res.some(Boolean) : res.every(Boolean);
    return ok ? "match" : "no";
  }

  // First block that ends the survey, in questionnaire order. Returns
  // { qid, mode, reason, message } or null.
  //   opts.phase = "live"  - only blocks that fire as soon as they match
  //   opts.upto            - last question index to consider
  function screeningVerdict(questions, answers, opts) {
    opts = opts || {};
    var ctx = { answers: answers || {}, questions: questions || [] };
    for (var i = 0; i < ctx.questions.length; i++) {
      if (opts.upto != null && i > opts.upto) break;
      var q = ctx.questions[i];
      var blocks = screening(q);
      for (var b = 0; b < blocks.length; b++) {
        var blk = blocks[b];
        if (opts.phase === "live" && blk.when !== "live") continue;
        var st = blockState(blk, ctx);
        if (blk.mode === "screen_out" && st === "match") return hit(q, blk, ctx);
        if (blk.mode === "qualify" && st === "no") return hit(q, blk, ctx);
      }
    }
    return null;
  }
  function hit(q, blk, ctx) {
    return {
      qid: q.id,
      mode: blk.mode,
      message: blk.message || "",
      reason: blk.reason ? String(blk.reason)
        : (q.id + ": " + (blk.mode === "qualify"
            ? "did not qualify - " + blockText(blk, ctx.questions)
            : blockText(blk, ctx.questions)))
    };
  }

  // ------------------------------------------------- screening in plain words
  function itemLabel(q, code) {
    var l = optLabel(q, code) || rowLabel(q, code);
    return l ? String(l) : String(code);
  }
  function valueText(r, questions) {
    var q = null;
    for (var i = 0; i < (questions || []).length; i++) if (questions[i].id === r.q) q = questions[i];
    var kind = valueKind(r.op);
    if (kind === "codes") {
      var codes = codeList(r.value);
      var labels = codes.map(function (c) { return itemLabel(q, c); });
      if (r.op === "ranked_first") return labels.join(" / ") || "…";
      return labels.length ? labels.join(r.op === "all_of" ? " and " : ", ") : "…";
    }
    if (kind === "ranktop") return itemLabel(q, rowKey(r.value)) + " (top " + rowWant(r.value) + ")";
    if (kind === "rowvalue") return itemLabel(q, rowKey(r.value)) + " = " + rowWant(r.value);
    if (kind === "between") { var p = String(r.value || "").split("-"); return (p[0] || "?") + " and " + (p[1] || "?"); }
    if (kind === "count") return String(r.value) + (r.op === "words_lt" ? " words" : "");
    if (kind === "none") return "";
    return String(r.value === undefined || r.value === null ? "" : r.value);
  }
  function ruleText(r, questions) {
    var v = valueText(r, questions);
    return (r.q || "?") + " " + opInfo(r.op).label + (v ? " " + v : "");
  }
  function blockText(block, questions) {
    var join = block.match === "any" ? " or " : " and ";
    return block.rules.map(function (r) { return ruleText(r, questions); }).join(join);
  }
  // One readable line per block, for the Studio, the Word outline and the data.
  function screenSummary(q, questions) {
    return screening(q).map(function (b) {
      return {
        mode: b.mode, when: b.when, source: b.source,
        text: (b.mode === "qualify" ? "continue only when " : "screen out when ") + blockText(b, questions || [q])
      };
    });
  }

  // ---------------------------------------------------------------- sample answers (preview)
  function sampleAnswers(questions, uptoId) {
    var out = {};
    for (var i = 0; i < (questions || []).length; i++) {
      var q = questions[i];
      if (q.id === uptoId) break;
      var a = {};
      switch (q.type) {
        case "single_select": case "nps": a._ = q.options && q.options.length ? q.options[0].code : 7; break;
        case "multi_select": a.codes = (q.options || []).slice(0, 2).map(function (o) { return o.code; }); break;
        case "numeric": case "slider": a._ = Math.round(((q.min || 0) + (q.max || 100)) / 2); break;
        case "open_text": a._ = "(sample answer to " + q.id + ")"; break;
        case "rank": a.order = (q.rows || []).map(function (r) { return r.code; }); break;
        case "rating_grid": case "semantic_diff": case "emoji_grid":
          (q.rows || []).forEach(function (r) { a[r.code] = q.scale ? Math.ceil((q.scale.min + q.scale.max) / 2) : 4; }); break;
        case "sum_to_100":
          (q.rows || []).forEach(function (r, k, arr) { a[r.code] = k === 0 ? 100 - 10 * (arr.length - 1) : 10; }); break;
        case "date": a._ = "2026-01-15"; break;
        case "numeric_matrix": (q.rows || []).forEach(function (r, k) { a[r.code] = 10 + k * 5; }); break;
        case "delta": a.before = 40; a.after = 60; a.delta = 20; break;
        case "concept_test":
          (q.rows || []).forEach(function (r) { a[r.code] = q.scale ? Math.ceil((q.scale.min + q.scale.max) / 2) : 4; }); break;
        case "loop":
          (q.items || []).forEach(function (it, k) { a[it.code] = q.child === "numeric" ? 5 + k : "(sample " + it.label + ")"; }); break;
        case "text_block": break;
        default: break;
      }
      out[q.id] = a;
    }
    return out;
  }

  // labels for the Studio's "insert piped text" menu
  function pipeTokens(questions, uptoId) {
    var toks = [];
    for (var i = 0; i < (questions || []).length; i++) {
      var q = questions[i];
      if (q.id === uptoId) break;
      if (q.type === "choice_task") continue;
      toks.push({ token: "{" + q.id + "}", label: q.id + " - answer as text" });
      if (q.options && q.options.length) {
        toks.push({ token: "{" + q.id + ".code}", label: q.id + " - answer code" });
        if (q.type === "multi_select") {
          toks.push({ token: "{" + q.id + ".first}", label: q.id + " - first selected" });
          toks.push({ token: "{" + q.id + ".last}", label: q.id + " - last selected" });
        }
        if (q.options.some(function (o) { return o.other; })) toks.push({ token: "{" + q.id + ".other}", label: q.id + " - 'other' text" });
        q.options.forEach(function (o) {
          toks.push({ token: "{" + q.id + ".opt:" + o.code + "}", label: q.id + " option " + o.code + ": " + String(o.label).slice(0, 40) });
        });
      }
      if (q.rows && q.rows.length) {
        q.rows.forEach(function (r) {
          toks.push({ token: "{" + q.id + ".row:" + r.code + "}", label: q.id + " row " + r.code + ": " + String(r.label).slice(0, 40) });
          if (q.scale) toks.push({ token: "{" + q.id + ".r:" + r.code + "}", label: q.id + " rating for " + r.code });
        });
      }
      toks.push({ token: "{" + q.id + ".stem}", label: q.id + " - question text" });
    }
    return toks;
  }

  window.BeaconQ = {
    sanitize: sanitize, sanitizeToFragment: sanitizeToFragment, stripTags: stripTags,
    pipe: pipe, richInto: richInto, showIf: showIf, order: order, hash: hash,
    sampleAnswers: sampleAnswers, pipeTokens: pipeTokens, answerText: answerText,
    // screening (screen in / screen out)
    SCREEN_OPS: SCREEN_OPS, opsFor: opsFor, opInfo: opInfo, valueKind: valueKind,
    qKind: qKind, screening: screening, hasScreening: hasScreening, blockState: blockState,
    screeningVerdict: screeningVerdict, screenSummary: screenSummary,
    ruleText: ruleText, blockText: blockText, valueText: valueText, codeList: codeList
  };
})();
