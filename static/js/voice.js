/* Beacon voice commands - answer the survey hands-free.
 *
 * Built only on the browser's own Web Speech API (SpeechRecognition), which is
 * free and needs no server key, so deploying the studio online costs nothing
 * extra.  Recognition is unavailable on some browsers; the survey then simply
 * stays manual-only and the mic button never appears.
 *
 * The parser is a pure function (parseCommand) so it can be unit-tested without
 * a microphone: it turns one spoken utterance into a list of actions -
 * pick an option by name / number / ordinal / letter / conversational phrase,
 * toggle several with "and", rate rows individually or all at once,
 * or navigate with "next" / "back" / "clear".
 */
(function () {
  "use strict";

  var NUM = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20
  };
  // Common speech-to-text homophones for single spoken numbers
  var HOMOPHONE_NUM = {
    won: 1, to: 2, too: 2, two: 2, for: 4, fore: 4, ate: 8
  };
  var ORD = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
    seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
    thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16,
    seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
    "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, "6th": 6,
    "7th": 7, "8th": 8, "9th": 9, "10th": 10, "11th": 11, "12th": 12,
    "13th": 13, "14th": 14, "15th": 15, "16th": 16, "17th": 17,
    "18th": 18, "19th": 19, "20th": 20
  };
  var LETTER_POS = {
    a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10
  };
  var STOP = {
    the: 1, a: 1, an: 1, of: 1, in: 1, on: 1, for: 1, to: 1, and: 1,
    or: 1, with: 1, my: 1, i: 1, it: 1, is: 1, im: 1, am: 1, are: 1,
    be: 1, as: 1, at: 1, by: 1, from: 1, that: 1, this: 1, would: 1,
    will: 1, please: 1, select: 1, pick: 1, choose: 1, option: 1,
    choice: 1, answer: 1, number: 1, "not": 0
  };

  function norm(t) {
    return String(t === undefined || t === null ? "" : t).toLowerCase()
      .replace(/[^\w\u00C0-\uFFFF]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // Canonicalize UK/US medical & survey spellings and common suffixes for resilient matching
  function canonWord(w) {
    if (!w) return "";
    var s = w.toLowerCase()
      .replace(/ae/g, "e")
      .replace(/oe/g, "e")
      .replace(/our\b/g, "or")
      .replace(/re\b/g, "er")
      .replace(/ise\b/g, "ize")
      .replace(/isation\b/g, "ization");
    if (s.length > 6) {
      s = s.replace(/ologies\b|ology\b|ologist\b|ologists\b/, "olog")
           .replace(/therapies\b|therapy\b/, "therap");
    }
    if (s.length > 5) {
      s = s.replace(/ies\b/, "y").replace(/ing\b/, "").replace(/ed\b/, "").replace(/s\b/, "");
    } else if (s.length > 3 && /s\b/.test(s) && !/ss\b/.test(s)) {
      s = s.slice(0, -1);
    }
    return s;
  }

  function canonPhrase(p) {
    return norm(p).split(" ").filter(Boolean).map(canonWord).join(" ");
  }

  function editDistance(a, b) {
    if (a === b) return 0;
    var al = a.length, bl = b.length;
    if (!al) return bl;
    if (!bl) return al;
    if (Math.abs(al - bl) > 3) return 99;
    var prev = [], curr = [], i, j;
    for (j = 0; j <= bl; j++) prev[j] = j;
    for (i = 1; i <= al; i++) {
      curr[0] = i;
      for (j = 1; j <= bl; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      var tmp = prev; prev = curr; curr = tmp;
    }
    return prev[bl];
  }

  // Keep signs and decimal points: normalising these as option labels loses values.
  function parseNumber(text) {
    if (text === undefined || text === null) return null;
    var t = String(text).toLowerCase().trim().replace(/,/g, "").replace(/percent|%/g, "").trim();
    if (!t) return null;
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(t)) return Number(t);
    var sign = 1;
    t = t.replace(/^(minus|negative)\s+/, function () { sign = -1; return ""; });
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(t)) return sign * Number(t);
    var parts = t.split(/ point | dot /), total = 0, group = 0;
    var tens = { thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
    var words = parts[0].replace(/-/g, " ").split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    var lastWasSmallUnit = false;
    var lastWasTens = false;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w === "and") continue;
      if (NUM[w] !== undefined) {
        // Two consecutive unit/teen words like "four five" is a list of numbers, not 4+5=9
        if (lastWasSmallUnit) return null;
        if (lastWasTens && NUM[w] >= 10) return null;
        group += NUM[w];
        if (NUM[w] === 20) {
          lastWasTens = true;
          lastWasSmallUnit = false;
        } else {
          lastWasSmallUnit = true;
          lastWasTens = false;
        }
      } else if (tens[w]) {
        if (lastWasSmallUnit || lastWasTens) return null;
        group += tens[w];
        lastWasTens = true;
        lastWasSmallUnit = false;
      } else if (w === "hundred") {
        group = (group || 1) * 100;
        lastWasSmallUnit = false;
        lastWasTens = false;
      } else if (w === "thousand" || w === "million") {
        total += (group || 1) * (w === "million" ? 1000000 : 1000);
        group = 0;
        lastWasSmallUnit = false;
        lastWasTens = false;
      } else {
        return null;
      }
    }
    var value = total + group;
    if (parts.length > 2) return null;
    if (parts.length === 2) {
      var digits = parts[1].split(/\s+/).map(function (w) { return NUM[w] !== undefined && NUM[w] < 10 ? NUM[w] : w; }).join("");
      if (!/^\d+$/.test(digits)) return null;
      value += Number("0." + digits);
    }
    return sign * value;
  }

  // Parse a spoken index/number including ordinals ("second", "2nd") and STT homophones ("to"->2, "for"->4)
  function parseIndexToken(raw) {
    var s = norm(raw);
    if (!s) return null;
    if (ORD[s] !== undefined) return ORD[s];
    if (NUM[s] !== undefined) return NUM[s];
    if (HOMOPHONE_NUM[s] !== undefined) return HOMOPHONE_NUM[s];
    var n = parseNumber(s);
    return n !== null ? n : null;
  }

  // Strip conversational framing around an option phrase
  function cleanOptionPhrase(raw) {
    var p = norm(raw);
    if (!p) return "";
    p = p.replace(/^(?:please\s+)?(?:i\s+would\s+like\s+to\s+|i\s+would\s+|i\s+d\s+|i\s+will\s+|i\s+ll\s+|let\s+s\s+|let\s+me\s+|can\s+you\s+)?(?:select|choose|pick|mark|check|tick|go\s+with|take|use|say|answer|rate)\s+/, "")
         .replace(/^(?:my\s+(?:answer|choice|selection|specialty|option|pick|response)\s+(?:is|would\s+be)\s+|(?:the\s+)?(?:answer|choice|selection|option)\s+is\s+|i\s+am\s+(?:in|a|an)\s+|i\s+work\s+in\s+|i\s+prefer\s+|it\s+is\s+|it\s+s\s+|that\s+is\s+|this\s+is\s+)/, "")
         .replace(/\s+(?:please|thank\s+you|thanks|for\s+me)$/, "")
         .replace(/^the\s+/, "")
         .replace(/\s+(?:one|option|choice|item)s?$/, "")
         .trim();
    return p;
  }

  function matchOptionWithScore(phrase, opts) {
    var rawP = norm(phrase);
    var p = cleanOptionPhrase(rawP) || rawP;
    if (!p || !opts || !opts.length) return { option: null, score: 0 };
    var pCanon = canonPhrase(p);
    var pCompact = pCanon.replace(/\s+/g, "");
    var best = null, bestScore = 0;

    opts.forEach(function (o) {
      var L = norm(o.label);
      if (!L) return;
      var lCanon = canonPhrase(L);
      var lCompact = lCanon.replace(/\s+/g, "");

      if (L === p || L === rawP) { best = o; bestScore = 1000; return; }
      if (lCanon && (lCanon === pCanon || lCompact === pCompact)) {
        if (bestScore < 950) { best = o; bestScore = 950; }
        return;
      }
      if (p.length >= 3 && L.indexOf(p) === 0 && bestScore < 600) { best = o; bestScore = 600; return; }
      if (pCanon.length >= 3 && lCanon.indexOf(pCanon) === 0 && bestScore < 560) { best = o; bestScore = 560; return; }
      if (p.length >= 4 && L.indexOf(p) >= 0 && bestScore < 450) { best = o; bestScore = 450; return; }
      if (pCanon.length >= 4 && lCanon.indexOf(pCanon) >= 0 && bestScore < 420) { best = o; bestScore = 420; return; }
      if (L.length >= 4 && (p.indexOf(L) >= 0 || rawP.indexOf(L) >= 0) && bestScore < 360) { best = o; bestScore = 360; return; }
      if (lCanon.length >= 4 && pCanon.indexOf(lCanon) >= 0 && bestScore < 340) { best = o; bestScore = 340; return; }

      // Word-level matching (with canonical stemming & edit-distance tolerance for 5+ char words)
      var lt = L.split(" ").filter(function (w) { return w.length > 2 && !STOP[w]; });
      if (!lt.length) lt = L.split(" ").filter(Boolean);
      if (!lt.length) return;
      var pt = p.split(" ").filter(function (w) { return !STOP[w]; });
      if (!pt.length) pt = p.split(" ").filter(Boolean);

      var shared = lt.filter(function (w) {
        var wc = canonWord(w);
        return pt.some(function (x) {
          var xc = canonWord(x);
          if (x === w || (wc && wc === xc)) return true;
          if (w.length >= 4 && x.indexOf(w) === 0) return true;
          if (x.length >= 4 && w.indexOf(x) === 0) return true;
          if (wc.length >= 4 && xc.indexOf(wc) === 0) return true;
          if (xc.length >= 4 && wc.indexOf(xc) === 0) return true;
          if (wc.length >= 5 && xc.length >= 5 && editDistance(wc, xc) <= (wc.length >= 8 ? 2 : 1)) return true;
          return false;
        });
      }).length;

      var score = shared / lt.length;
      var reverseScore = pt.length ? (shared / pt.length) : 0;
      var effective = Math.max(score, reverseScore >= 0.75 && shared >= 1 ? 0.65 : 0);
      if (shared > 0 && effective >= 0.5 && effective * 100 > bestScore) {
        best = o;
        bestScore = effective * 100;
      } else if (lCompact.length >= 5 && pCompact.length >= 5) {
        var dist = editDistance(lCompact, pCompact);
        if (dist <= (lCompact.length >= 9 ? 2 : 1) && bestScore < 280) {
          best = o;
          bestScore = 280 - dist * 20;
        }
      }
    });
    return { option: best, score: bestScore };
  }

  function matchOption(phrase, opts) {
    return matchOptionWithScore(phrase, opts).option;
  }

  // Resolve a spoken rating value from either a number, homophone, or scale/column anchor label
  function resolveRatingValue(rawPhrase, ctx) {
    if (rawPhrase === undefined || rawPhrase === null) return null;
    var rawStr = String(rawPhrase).trim();
    if (!rawStr) return null;

    // 1. Direct number parse
    var direct = parseNumber(rawStr);
    if (direct !== null) return direct;

    var cleaned = norm(rawStr)
      .replace(/^(?:rate\s+it|rate\s+this|rate|score\s+it|score|give\s+it\s+a|give\s+it|give\s+a|give|set\s+to|set\s+it\s+to|set|value\s+is|value|it\s+is\s+a|it\s+is|it\s+s\s+a|it\s+s|is\s+a|is|answer\s+is|my\s+answer\s+is|my\s+rating\s+is|i\s+would\s+rate\s+this|i\s+would\s+rate\s+it|i\s+would\s+rate|i\s+rate\s+it|i\s+rate\s+this|i\s+rate|i\s+give\s+it|rating\s+is|rating|option|number|level|column|col|point|a|an)\s+/, "")
      .replace(/\s+(?:out\s+of\s+\d+|on\s+a\s+scale\s+of\s+\d+|stars?|points?|percent|please|thanks|thank\s+you)$/, "")
      .trim();

    if (cleaned) {
      var nClean = parseNumber(cleaned);
      if (nClean !== null) return nClean;
      if (HOMOPHONE_NUM[cleaned] !== undefined) return HOMOPHONE_NUM[cleaned];
      if (ORD[cleaned] !== undefined) return ORD[cleaned];
    }

    // 2. Match against scale labels / column labels if provided in ctx
    var scaleOpts = [];
    var sc = ctx && ctx.scale;
    var minV = sc && sc.min != null ? Number(sc.min) : 1;
    var maxV = sc && sc.max != null ? Number(sc.max) : 5;
    var midV = Math.round((minV + maxV) / 2);

    if (ctx && Array.isArray(ctx.scaleLabels) && ctx.scaleLabels.length) {
      ctx.scaleLabels.forEach(function (sl) {
        if (sl && sl.label && sl.value !== undefined) {
          scaleOpts.push({ code: sl.value, label: sl.label });
        }
      });
    }
    if (sc) {
      if (sc.min_label) scaleOpts.push({ code: minV, label: sc.min_label });
      if (sc.mid_label) scaleOpts.push({ code: midV, label: sc.mid_label });
      if (sc.max_label) scaleOpts.push({ code: maxV, label: sc.max_label });
      if (Array.isArray(sc.points)) {
        sc.points.forEach(function (pt) {
          if (pt && pt.label && pt.v !== undefined) scaleOpts.push({ code: pt.v, label: pt.label });
        });
      }
    }
    if (scaleOpts.length && cleaned) {
      var hit = matchOptionWithScore(cleaned, scaleOpts);
      if (hit.option && hit.score >= 75 && hit.option.code !== undefined) return hit.option.code;
    }
    if (sc && cleaned) {
      if (/^(?:minimum|lowest|least|bottom)$/.test(cleaned)) return minV;
      if (/^(?:maximum|highest|most|top|best)$/.test(cleaned)) return maxV;
      if (/^(?:middle|midpoint|neutral|average|medium)$/.test(cleaned)) return midV;
    }

    // 3. Extract trailing number / homophone token if embedded in natural speech ("I would rate this as four")
    var tokens = (cleaned || norm(rawStr)).split(/\s+/).filter(Boolean);
    for (var wi = tokens.length - 1; wi >= 0; wi--) {
      var tok = tokens[wi];
      if (HOMOPHONE_NUM[tok] !== undefined && tokens.length <= 3) return HOMOPHONE_NUM[tok];
      for (var wl = Math.min(3, tokens.length - wi); wl >= 1; wl--) {
        var phrase = tokens.slice(wi, wi + wl).join(" ");
        var pn = parseNumber(phrase);
        if (pn !== null) return pn;
      }
    }
    return null;
  }

  // Match a spoken clause to a specific row index + rating value
  function parseRowClause(clause, ctx) {
    if (!clause) return null;
    var cNorm = norm(clause);
    if (!cNorm) return null;

    // Pattern A: "row 1 is 4", "second row 5", "2nd row is 4", "item two four", "for row 2 give 4"
    var cm = cNorm.match(/^(?:for\s+|on\s+|in\s+|rate\s+|set\s+|give\s+)?(?:(?:row|field|item|statement|question|line|attribute|option|number)\s*(?:number\s*)?(\d+|[a-z]+)|(\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s*(?:row|field|item|statement|line|attribute|one)?)\s*(?:is|are|to|as|equals|gets|rating|value|score|at|a)?\s*(.+)$/i);
    if (cm) {
      var rawIdx = (cm[1] || cm[2] || "").toLowerCase();
      var idx = parseIndexToken(rawIdx);
      var val = resolveRatingValue(cm[3], ctx);
      if (idx !== null && idx >= 1 && val !== null) {
        return { act: "fieldValue", index: idx - 1, value: val };
      }
    }

    // Pattern B: "1 is 4", "2 equals 5"
    var shortCm = cNorm.match(/^(\d+)\s*(?:is|to|equals|gets)\s*(.+)$/i);
    if (shortCm) {
      var sIdx = parseIndexToken(shortCm[1]);
      var sVal = resolveRatingValue(shortCm[2], ctx);
      if (sIdx !== null && sIdx >= 1 && sVal !== null) {
        return { act: "fieldValue", index: sIdx - 1, value: sVal };
      }
    }

    // Pattern C: Match against row labels (exact prefix OR fuzzy row label match)
    if (ctx.rows && ctx.rows.length) {
      var rowOpts = ctx.rows.map(function (r, idx) {
        return { code: idx, label: r.label || "" };
      });
      // C1: Exact row label prefix ("Ease of use 5", "Ease of use is 5")
      for (var ri = 0; ri < ctx.rows.length; ri++) {
        var rNorm = norm(ctx.rows[ri].label);
        if (rNorm && cNorm.indexOf(rNorm) === 0) {
          var rem = cNorm.slice(rNorm.length).replace(/^(?:is|are|to|as|equals|gets|rating|score|value|a)\s*/, "").trim();
          var rVal = resolveRatingValue(rem, ctx);
          if (rVal !== null) return { act: "fieldValue", index: ri, value: rVal };
        }
      }
      // C2: Strip leading "for / rate / on" and split off the trailing value token(s), longest tail first
      var stripped = cNorm.replace(/^(?:for|on|in|rate|score|set|give)\s+/, "").trim();
      var words = stripped.split(/\s+/);
      for (var tailLen = Math.min(4, words.length - 1); tailLen >= 1; tailLen--) {
        var tail = words.slice(words.length - tailLen).join(" ");
        var head = words.slice(0, words.length - tailLen).join(" ")
          .replace(/\s+(?:is|are|to|as|equals|gets|rating|score|value|give|a)$/, "").trim();
        if (!head) continue;
        var candVal = resolveRatingValue(tail, ctx);
        if (candVal !== null) {
          var rowHit = matchOptionWithScore(head, rowOpts);
          if (rowHit.option && rowHit.score >= 55) {
            return { act: "fieldValue", index: rowHit.option.code, value: candVal };
          }
        }
      }
    }
    return null;
  }

  // One utterance in, a list of actions out.  ctx: { options, multi }.
  function parseCommand(text, ctx) {
    ctx = ctx || {};
    var t = norm(text);
    if (!t) return [];
    if (/^dictate /i.test(text)) return [{ act: "value", value: text.slice(8) }];
    if (/^(stop listening|voice off|turn off voice|mute|stop voice)$/.test(t)) return [{ act: "stop" }];
    if (/^(next field|next row|next item|down|move down)$/.test(t)) return [{ act: "fieldMove", direction: 1 }];
    if (/^(previous field|prev field|previous row|prev row|previous item|up|move up)$/.test(t)) return [{ act: "fieldMove", direction: -1 }];

    var control = String(text).match(/^(?:field|control|click) (\d+|[a-z]+)(?: (?:is |equals |to )?(.+))?$/i);
    if (control) return [{ act: "control", index: parseIndexToken(control[1]), value: control[2] }];

    // Drop conversational padding around navigation/picks
    t = t.replace(/^the /, "").replace(/ (one|option|choice)s?$/, "").replace(/\s+please$/, "");
    if (/^(next|continue|proceed|go on|carry on|submit|done|finish|ok next|okay next|next question|move on|skip|forward|go forward)$/.test(t)) return [{ act: "next" }];
    if (/^(back|previous|go back|backwards|last question|prior question|previous question)$/.test(t)) return [{ act: "back" }];
    if (/^(clear|reset|clear selection|start over|clear my answers|clear all|unselect all|deselect all|erase)$/.test(t)) return [{ act: "clear" }];

    // ---- Ranking question natural voice commands ----
    if (ctx.type === "rank" && ctx.rows && ctx.rows.length) {
      var rankMove = t.match(/^(?:move|push|shift|bring|put)\s+(.+?)\s+(up|down|top|first|bottom|last)$/);
      if (rankMove) {
        var rTarget = rankMove[1].replace(/^(?:item|row|option|number)\s+/, "").trim();
        var dirWord = rankMove[2];
        var rIdx = parseIndexToken(rTarget);
        var rowOpts = ctx.rows.map(function (r, idx) { return { code: r.code, label: r.label, idx: idx }; });
        var targetCode = null;
        if (rIdx !== null && rIdx >= 1 && rIdx <= ctx.rows.length) {
          targetCode = ctx.rows[rIdx - 1].code;
        } else {
          var hitR = matchOption(rTarget, rowOpts);
          if (hitR) targetCode = hitR.code;
        }
        if (targetCode !== null) {
          return [{
            act: "rankMove",
            code: targetCode,
            direction: (dirWord === "up" || dirWord === "top" || dirWord === "first") ? -1 : 1,
            extreme: (dirWord === "top" || dirWord === "first" || dirWord === "bottom" || dirWord === "last")
          }];
        }
      }
    }

    // ---- Multi-field / Rating Scale / Rating Grid / Gauge Meter / Matrix voice handling ----
    var isRatingScale = ctx.type === "rating_scale" || ctx.type === "rating_grid" ||
                        ctx.type === "semantic_diff" || ctx.type === "emoji_grid" ||
                        ctx.type === "gauge_meter" || ctx.type === "numeric_matrix" ||
                        ctx.type === "sum_to_100" || ctx.type === "delta" ||
                        (ctx.rows && ctx.rows.length > 0 && ctx.inputType === "number");
    var hasMultiFields = isRatingScale || (ctx.fieldsCount && ctx.fieldsCount > 1 && ctx.inputType === "number");

    if (hasMultiFields) {
      // Check if utterance ends with "and next" / "then next" so we can append navigation
      var trailingNext = false;
      var workingText = String(text);
      if (/\b(?:and|then)\s+(?:next|continue|proceed|done)\s*$/i.test(workingText)) {
        trailingNext = true;
        workingText = workingText.replace(/\b(?:and|then)\s+(?:next|continue|proceed|done)\s*$/i, "").trim();
        t = norm(workingText);
      }

      // 0. "All rows <rating>" / "rate all 4" / "every row is 4" / "4 for all" / "straight 4"
      var allMatch = t.match(/^(?:(?:rate|score|give|set|make|mark|fill)\s+)?(?:all(?:\s+of\s+them|\s+rows|\s+items|\s+statements|\s+fields)?|every\s+(?:row|item|statement|field|one)|everything|each\s+(?:row|item|one)|straight(?:\s+line)?)\s*(?:is|are|to|as|at|with|gets|equals|a)?\s*(.+)$/i) ||
                     t.match(/^(.+?)\s+(?:for|on|across)\s+(?:all|every)\s*(?:rows|items|statements|fields|of\s+them)?$/i);
      if (allMatch) {
        var allVal = resolveRatingValue(allMatch[1], ctx);
        var count = Math.max(ctx.fieldsCount || 0, (ctx.rows && ctx.rows.length) || 0);
        if (allVal !== null && count > 0) {
          var allActs = [];
          for (var ai = 0; ai < count; ai++) {
            allActs.push({ act: "fieldValue", index: ai, value: allVal });
          }
          if (trailingNext) allActs.push({ act: "next" });
          return allActs;
        }
      }

      // 1. Explicit row selection without value: "row 2", "second row", "2nd row", "select row 3", "field 2"
      var rowNav = t.match(/^(?:go\s+to\s+|select\s+|focus\s+|move\s+to\s+)?(?:(?:row|field|item|statement|line)\s*(?:number\s*)?(\d+|[a-z]+)|(\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*(?:row|field|item|statement|line)?)$/i);
      if (rowNav) {
        var rawNav = rowNav[1] || rowNav[2];
        var rIdxNav = parseIndexToken(rawNav);
        if (rIdxNav !== null && rIdxNav >= 1) return [{ act: "fieldSelect", index: rIdxNav - 1 }];
      }

      // 2. Explicit row-assigned ratings: "row 1 four, row 2 five" or "row 1 is 4 and row 2 is 5" or "Ease of use 5"
      var clauses = workingText.split(/\band\b|\bthen\b|,|;/i).map(function (s) { return s.trim(); }).filter(Boolean);
      var rowActs = [];
      var allClausesMatched = clauses.length > 0;

      clauses.forEach(function (clause) {
        var parsed = parseRowClause(clause, ctx);
        if (parsed) rowActs.push(parsed);
        else allClausesMatched = false;
      });

      if (rowActs.length && allClausesMatched) {
        if (trailingNext) rowActs.push({ act: "next" });
        return rowActs;
      }

      // 3. Multiple sequential numbers in one breath:
      //    (a) separated by "and", "then", ",", ";" -> e.g. "4 and 5" or "4, 5, 3"
      if (clauses.length > 1) {
        var seqVals = [];
        var allNum = true;
        clauses.forEach(function (c) {
          var n = resolveRatingValue(c, ctx);
          if (n !== null) seqVals.push(n);
          else allNum = false;
        });
        if (allNum && seqVals.length > 1) {
          var startIdx = (ctx.fieldsCount && seqVals.length === ctx.fieldsCount) ? 0 : (ctx.activeFieldIndex || 0);
          var outSeq = seqVals.map(function (v, i) {
            return { act: "fieldValue", index: startIdx + i, value: v };
          });
          if (trailingNext) outSeq.push({ act: "next" });
          return outSeq;
        }
      }

      //    (b) space-separated sequence of rating numbers: e.g. "4 5 3" or "four five three" or "4 4 4"
      var spaceTokens = t.split(/\s+/).filter(Boolean);
      if (spaceTokens.length >= 2 && spaceTokens.length <= 15 && parseNumber(t) === null) {
        var spaceVals = [];
        var allSpaceNum = true;
        spaceTokens.forEach(function (tok) {
          var v = parseIndexToken(tok);
          if (v !== null) spaceVals.push(v);
          else allSpaceNum = false;
        });
        if (allSpaceNum && spaceVals.length >= 2) {
          var startIdx2 = (ctx.fieldsCount && spaceVals.length === ctx.fieldsCount) ? 0 : (ctx.activeFieldIndex || 0);
          var outSpace = spaceVals.map(function (v, i) {
            return { act: "fieldValue", index: startIdx2 + i, value: v };
          });
          if (trailingNext) outSpace.push({ act: "next" });
          return outSpace;
        }
      }

      // 4. Single rating number or scale label for current active field
      var singleVal = resolveRatingValue(workingText, ctx);
      if (singleVal !== null) {
        var singleOut = [{ act: "fieldValue", index: ctx.activeFieldIndex || 0, value: singleVal, autoAdvance: true }];
        if (trailingNext) singleOut.push({ act: "next" });
        return singleOut;
      }
    }

    // ---- Single input field (numeric, slider, date, open_text, select) ----
    if (ctx.inputType) {
      if (/^(number|range)$/.test(ctx.inputType)) {
        var numVal = parseNumber(text);
        if (numVal === null) {
          var strippedNum = t.replace(/^(?:it\s+is|it\s+s|set\s+to|set\s+it\s+to|set|value\s+is|value|my\s+answer\s+is|answer\s+is|answer|number|rate|score|give|around|about)\s+/, "")
                             .replace(/\s+(?:percent|points?|years?|patients?|please|thanks)$/, "").trim();
          numVal = parseNumber(strippedNum);
          if (numVal === null && HOMOPHONE_NUM[strippedNum] !== undefined) {
            numVal = HOMOPHONE_NUM[strippedNum];
          }
        }
        return numVal === null ? [{ act: "unknown", text: text }] : [{ act: "value", value: numVal }];
      }
      var strVal = String(text).trim();
      return !strVal ? [{ act: "unknown", text: text }] : [{ act: "value", value: strVal }];
    }

    // ---- Option-based questions (single_select, multi_select, choice_task) ----
    var opts = ctx.options || [], acts = [];
    function pickN(n) {
      if (n >= 1 && n <= opts.length) {
        acts.push({ act: "pick", code: opts[n - 1].code });
        return true;
      }
      // Also allow matching by explicit option code (e.g. "98" for "98. None of these")
      for (var i = 0; i < opts.length; i++) {
        if (String(opts[i].code).toLowerCase() === String(n).toLowerCase()) {
          acts.push({ act: "pick", code: opts[i].code });
          return true;
        }
      }
      return false;
    }

    function tryPickSinglePart(rawPart) {
      var p = norm(rawPart);
      if (!p) return false;
      if (/^(next|continue|proceed|go on|done|submit)$/.test(p)) {
        acts.push({ act: "next" });
        return true;
      }
      if (/^(clear|reset)$/.test(p)) {
        acts.push({ act: "clear" });
        return true;
      }
      if (/^(back|previous|go back)$/.test(p)) {
        acts.push({ act: "back" });
        return true;
      }

      // Exclusive / None of these
      if (/^(none|none of these|none of them|none of the above|not applicable|n a|na|neither|nothing|no thank you|no thanks)$/.test(p)) {
        var na = null;
        opts.forEach(function (o) {
          if (o.exclusive || /none|not applicable|\bn\/a\b|neither/i.test(String(o.label || ""))) na = o;
        });
        if (na) { acts.push({ act: "pick", code: na.code }); return true; }
      }

      // Select all (for multi-select)
      if (ctx.multi && /^(select all|all of them|all options|all of the above|check all|every option|all)$/.test(p)) {
        opts.forEach(function (o) {
          if (!o.exclusive) acts.push({ act: "pick", code: o.code });
        });
        return acts.length > 0;
      }

      // Strip conversational framing ("I choose option 2", "select the second option", "option number two")
      var cleaned = cleanOptionPhrase(p);

      // "last" / "the last option"
      if (/^(?:the\s+)?last(?:\s+option|\s+choice|\s+one|\s+item)?$/.test(p) || cleaned === "last") {
        if (opts.length) {
          acts.push({ act: "pick", code: opts[opts.length - 1].code });
          return true;
        }
      }

      // Explicit option/number/choice/treatment prefix + number/ordinal/letter ("option 2", "option two", "option number 2", "treatment 2", "option B", "2nd option")
      var explicitMatch = p.match(/^(?:(?:select|pick|choose|mark|check|go\s+with|i\s+choose|i\s+select|i\s+pick|my\s+answer\s+is|it\s+is|it\s+s)\s+)?(?:the\s+)?(?:(?:option|number|choice|answer|item|treatment|profile|card|letter)\s*(?:number\s*)?)+(\d+(?:st|nd|rd|th)?|[a-z]+)$/i) ||
                          cleaned.match(/^(?:(?:option|number|choice|answer|item|treatment|profile|card|letter)\s*(?:number\s*)?)+(\d+(?:st|nd|rd|th)?|[a-z]+)$/i) ||
                          p.match(/^(?:(?:select|pick|choose|go\s+with)\s+)?(?:the\s+)?(\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*(?:option|choice|answer|item|treatment|one)?$/i);
      if (explicitMatch) {
        var tok = explicitMatch[1].toLowerCase();
        var idx = parseIndexToken(tok);
        if (idx !== null) {
          if (pickN(idx)) return true;
          return false;
        }
        if (LETTER_POS[tok] !== undefined && pickN(LETTER_POS[tok])) return true;
      }

      // Bare number / ordinal / homophone / single letter ("2", "two", "second", "2nd", "B")
      var bareIdx = parseIndexToken(cleaned || p);
      if (bareIdx !== null && (cleaned || p).split(/\s+/).length <= 2) {
        if (pickN(bareIdx)) return true;
        return false;
      }
      if (LETTER_POS[cleaned] !== undefined && cleaned.length === 1 && opts.length >= LETTER_POS[cleaned]) {
        if (pickN(LETTER_POS[cleaned])) return true;
      }

      // Match against option labels
      var hit = matchOption(cleaned || p, opts) || matchOption(p, opts);
      if (hit) {
        acts.push({ act: "pick", code: hit.code });
        return true;
      }
      return false;
    }

    // Before splitting on "and", check if the whole utterance is a single option (especially options whose label contains "and"!)
    if (!/\b(?:and|then)\s+(?:next|continue|proceed)\s*$/i.test(t)) {
      var hasExplicitMulti = /\b(?:option|choice|number)\s+\S+\s+and\s+(?:option|choice|number)\b/i.test(t);
      if (!hasExplicitMulti) {
        var wholeDirect = matchOptionWithScore(t, opts);
        if (wholeDirect.option && (wholeDirect.score >= 450 || (!ctx.multi && wholeDirect.score >= 90))) {
          return [{ act: "pick", code: wholeDirect.option.code }];
        }
      }
      // Single-token or single-phrase pick (e.g. "option 2", "2", "second", "none of these", "option 9")
      if (!/\band\b|\bthen\b|\bplus\b|,/.test(t)) {
        if (tryPickSinglePart(t)) return acts;
        return [{ act: "unknown", text: t }];
      }
    }

    // Multi-part utterance ("chemo and IO", "option 1 and immunotherapy", "option 2 then next")
    var rawParts = t.split(/\band\b|\bthen\b|\bplus\b|\balso\b|,|;/).map(function (s) { return norm(s); }).filter(Boolean);
    for (var pi = 0; pi < rawParts.length; pi++) {
      // Check if rawParts[pi] + " and " + rawParts[pi + 1] forms a single option label containing "and"
      if (pi + 1 < rawParts.length) {
        var joined = rawParts[pi] + " and " + rawParts[pi + 1];
        var joinedMatch = matchOptionWithScore(joined, opts);
        if (joinedMatch.option && joinedMatch.score >= 500) {
          acts.push({ act: "pick", code: joinedMatch.option.code });
          pi++;
          continue;
        }
      }
      if (!tryPickSinglePart(rawParts[pi])) {
        acts.push({ act: "unknown", text: rawParts[pi] });
      }
    }
    return acts.length ? acts : [{ act: "unknown", text: t }];
  }

  function supported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  // Errors that end listening.  The browser will not grant them on a retry, so restarting would
  // only spin.  "no-speech" (a pause with nothing said) and "aborted" (we stopped it) are ordinary.
  var BENIGN = { "no-speech": 1, "aborted": 1 };

  // handlers: onFinal(text), onInterim(text), onState("listening"|"off"|"error", code)
  function create(handlers) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    var rec = new SR(), on = false, heard = false, silentEnds = 0;
    var lang = (document.documentElement && document.documentElement.lang) || navigator.language || "en-US";
    rec.lang = lang === "en" ? "en-US" : lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    var finalizedByIdx = {}, pendingInterim = "";
    function emit(state, code) { if (handlers.onState) handlers.onState(state, code); }
    function fail(code) { on = false; emit("error", code); }
    // false only when the browser refused to start listening at all
    function begin() {
      heard = false;
      finalizedByIdx = {};
      pendingInterim = "";
      try { rec.start(); return true; }
      catch (e) { return !!e && e.name === "InvalidStateError"; }   // already running is fine
    }

    rec.onaudiostart = function () { heard = true; silentEnds = 0; };
    rec.onresult = function (e) {
      heard = true; silentEnds = 0;
      var fin = "", inter = "", i;
      for (i = 0; i < e.results.length; i++) {
        var r = e.results[i];
        if (!r || !r[0]) continue;
        var t = String(r[0].transcript || "").trim();
        if (!t) continue;
        if (r.isFinal) {
          if (finalizedByIdx[i] !== t) {
            finalizedByIdx[i] = t;
            fin += (fin ? " " : "") + t;
          }
        } else {
          inter += (inter ? " " : "") + t;
        }
      }
      pendingInterim = inter.trim();
      if (fin && handlers.onFinal) handlers.onFinal(fin.trim());
      if (pendingInterim && handlers.onInterim) handlers.onInterim(pendingInterim);
    };
    rec.onerror = function (e) {
      var code = (e && e.error) || "error";
      if (!BENIGN[code]) fail(code);
    };
    rec.onend = function () {
      if (pendingInterim) {
        var leftover = pendingInterim;
        pendingInterim = "";
        if (handlers.onFinal) handlers.onFinal(leftover);
      }
      if (!on) { emit("off"); return; }
      // A session that ends without ever capturing audio means the microphone is blocked or missing.
      // A few in a row is a fault to report, not something to keep retrying.
      silentEnds = heard ? 0 : silentEnds + 1;
      if (silentEnds >= 3) { fail("no-audio"); return; }
      // the browser stops listening after each utterance - start again at once
      if (!begin()) { fail("no-start"); return; }
      emit("listening");
    };

    return {
      start: function () {
        on = true; silentEnds = 0;
        if (!begin()) { fail("no-start"); return; }
        emit("listening");
      },
      stop: function () {
        on = false;
        try { rec.stop(); } catch (e) {}
        emit("off");
      },
      active: function () { return on; }
    };
  }

  window.BeaconVoice = {
    supported: supported,
    create: create,
    parseCommand: parseCommand,
    norm: norm,
    parseNumber: parseNumber,
    matchOption: matchOption,
    resolveRatingValue: resolveRatingValue
  };
})();
