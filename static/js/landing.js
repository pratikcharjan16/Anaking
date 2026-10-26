/* SurveyKart Landing Page: hero AI+Kart conversation, animated + interactive 100-pt Kart
   shopping simulator, scroll reveals, and signed-in header controls. */
(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function maskedEmail(email) {
    var parts = String(email || "").split("@");
    return parts.length === 2 && parts[0] ? parts[0].charAt(0) + "xxx@" + parts[1] : "";
  }
  function accountLabel(user) {
    return user.name || user.username || user.email_masked || maskedEmail(user.email) || "Account";
  }
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- hero: "Shop your questions. Insights Delivered." -------------------
  var NEED = "Build an oncology switching study: 2 single selects, 1 constant sum, and 1 delta question.";
  var typeEl = document.getElementById("ai-type");
  var replyEl = document.getElementById("ai-reply");
  var actionsEl = document.getElementById("ai-actions");
  var fastEl = document.getElementById("ai-fast");
  var youMsg = typeEl && typeEl.closest(".ai-msg");

  function retrigger(root) {
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll("*"), function (n) {
      var a = n.style.animation;
      n.style.animation = "none";
      void n.offsetWidth;
      n.style.animation = a || "";
    });
    var a = root.style.animation;
    root.style.animation = "none";
    void root.offsetWidth;
    root.style.animation = a || "";
  }
  function type(text, i, done) {
    if (!typeEl) return;
    typeEl.textContent = text.slice(0, i);
    if (i < text.length) setTimeout(function () { type(text, i + 1, done); }, 28);
    else if (done) done();
  }

  function showConversation(statically) {
    if (!typeEl) return;
    if (statically) {
      typeEl.textContent = NEED;
      youMsg.classList.add("done");
      [replyEl, actionsEl, fastEl].forEach(function (el) { if (el) el.hidden = false; });
      return;
    }
    typeEl.textContent = "";
    youMsg.classList.remove("done");
    [replyEl, actionsEl, fastEl].forEach(function (el) { if (el) el.hidden = true; });
    retrigger(youMsg);
    type(NEED, 0, function () {
      youMsg.classList.add("done");
      setTimeout(function () {
        if (replyEl) { replyEl.hidden = false; retrigger(replyEl); }
        setTimeout(function () {
          if (actionsEl) { actionsEl.hidden = false; retrigger(actionsEl); }
          setTimeout(function () {
            if (fastEl) { fastEl.hidden = false; retrigger(fastEl); }
            setTimeout(function () { showConversation(false); }, 5500);
          }, 1400);
        }, 900);
      }, 350);
    });
  }
  if (typeEl) showConversation(reduce);

  // ---- Interactive & Animated SurveyKart 100-Point Demo (All 23 Platform Question Types) ---
  var CATALOG = [
    // Questions (16)
    { key: "single_select", label: "Single select", icon: "\u25C9", cat: "Questions", desc: "One answer from a list", points: 10 },
    { key: "multi_select", label: "Multi-select", icon: "\u2611", cat: "Questions", desc: "Select all options that apply", points: 15 },
    { key: "rank", label: "Rank order", icon: "\u21C5", cat: "Questions", desc: "Order items by preference", points: 15 },
    { key: "grid_matrix", label: "Grid / matrix", icon: "\u25A6", cat: "Questions", desc: "Rows \u00d7 columns matrix picks", points: 20 },
    { key: "numeric_matrix", label: "Numeric matrix", icon: "\u25A4", cat: "Questions", desc: "Number for every row \u00d7 col", points: 20 },
    { key: "text_grid", label: "Text grid", icon: "\u229E", cat: "Questions", desc: "Rows \u00d7 columns text & voice", points: 25 },
    { key: "rating_scale", label: "Rating scale", icon: "\u2605", cat: "Questions", desc: "Anchored multi-row rating", points: 20 },
    { key: "gauge_meter", label: "Gauge meter", icon: "\u23F1", cat: "Questions", desc: "Interactive dial speedometer", points: 10 },
    { key: "semantic_diff", label: "NPS / semantic scale", icon: "\u2194", cat: "Questions", desc: "Score between two anchors", points: 15 },
    { key: "emoji_grid", label: "Emoji reaction", icon: "\u263A", cat: "Questions", desc: "Faces instead of numbers", points: 15 },
    { key: "numeric", label: "Numeric entry", icon: "#", cat: "Questions", desc: "Exact number (%, $, count)", points: 15 },
    { key: "open_text", label: "Text entry (open-ended)", icon: "\u00B6", cat: "Questions", desc: "Free verbatim + voice note", points: 15 },
    { key: "slider", label: "Scale slider", icon: "\u2696", cat: "Questions", desc: "Drag slider to a value", points: 15 },
    { key: "constant_sum", label: "Constant sum", icon: "\u03A3", cat: "Questions", desc: "Split 100 pts across items", points: 20 },
    { key: "date", label: "Date picker", icon: "\uD83D\uDCC5", cat: "Questions", desc: "Pick a calendar date", points: 10 },
    { key: "delta_question", label: "Delta question", icon: "\u0394", cat: "Questions", desc: "Carry baseline & measure shift", points: 30 },
    // Methodologies (5)
    { key: "concept_test", label: "Concept test", icon: "\uD83D\uDCA1", cat: "Methodologies", desc: "Show concept & rate rows", points: 30 },
    { key: "heat_map", label: "Heat map", icon: "\u25A9", cat: "Methodologies", desc: "Intensity per row \u00d7 column", points: 30 },
    { key: "walkthrough", label: "Walkthrough", icon: "\u25B6", cat: "Methodologies", desc: "Narrated multi-step story", points: 40 },
    { key: "maxdiff", label: "MaxDiff", icon: "\u2194", cat: "Methodologies", desc: "Best / worst trade-offs", points: 35 },
    { key: "conjoint", label: "Conjoint", icon: "\u21C4", cat: "Methodologies", desc: "Discrete choice experiment", points: 40 },
    // Survey Flow & Objects (2)
    { key: "loop", label: "Question loop", icon: "\u27F3", cat: "Flow", desc: "Repeat questions across items", points: 25 },
    { key: "text_block", label: "Text block", icon: "\u2261", cat: "Flow", desc: "Rich intro / stimulus step", points: 0 }
  ];

  var DEFAULT_PTS = 100;
  var counts = { single_select: 2, constant_sum: 1, delta_question: 1 };
  var activeCatFilter = "all";
  var animTimers = [];
  var catEl = document.getElementById("sk-demo-catalog");
  var catTabsEl = document.getElementById("sk-cat-tabs");

  function clearAnimTimers() {
    while (animTimers.length) clearTimeout(animTimers.pop());
  }

  function usedPts() {
    return CATALOG.reduce(function (sum, item) {
      return sum + (counts[item.key] || 0) * item.points;
    }, 0);
  }

  function renderKartDemo(pulseKey, caption) {
    if (!catEl) return;
    var used = usedPts();
    var left = Math.max(0, DEFAULT_PTS - used);
    var shown = CATALOG.filter(function (item) {
      return activeCatFilter === "all" || item.cat === activeCatFilter;
    });

    catEl.innerHTML = shown.map(function (item) {
      var q = counts[item.key] || 0;
      var cls = "sk-qcard" + (q ? " in-kart" : "") + (pulseKey === item.key ? " pulse-step" : "");
      var ptsLabel = item.points === 0 ? "Free \u00b7 0 pts" : (item.points + " pts");
      var ptsCls = "sk-qcard-pts" + (item.points === 0 ? " free" : "");
      var qtyTxt = q
        ? (q + " in Kart \u00b7 " + (q * item.points) + " pts")
        : "Tap + to shop";
      return '<div class="' + cls + '" data-qkey="' + item.key + '">' +
        '<div class="sk-qcard-top">' +
          '<span class="sk-qcard-titlewrap">' +
            '<span class="sk-qcard-ic" aria-hidden="true">' + item.icon + '</span>' +
            '<span class="sk-qcard-name">' + esc(item.label) + '</span>' +
          '</span>' +
          '<span class="' + ptsCls + '">' + ptsLabel + '</span>' +
        '</div>' +
        '<p class="sk-qcard-desc">' + esc(item.desc) + '</p>' +
        '<div class="sk-qcard-btns">' +
          '<span class="sk-qqty">' + qtyTxt + '</span>' +
          '<span class="sk-qbtn-group">' +
            (q ? '<button type="button" class="sk-qbtn" data-kart-dec="' + item.key + '" aria-label="Remove ' + esc(item.label) + '">&minus;</button>' : '') +
            '<button type="button" class="sk-qbtn add" data-kart-inc="' + item.key + '" aria-label="Add ' + esc(item.label) + '">+ Add</button>' +
          '</span>' +
        '</div>' +
      '</div>';
    }).join("");

    var usedEl = document.getElementById("sk-demo-used");
    var leftEl = document.getElementById("sk-demo-left");
    var barEl = document.getElementById("sk-demo-bar");
    var linesEl = document.getElementById("sk-demo-lines");
    var totalEl = document.getElementById("sk-demo-total");
    var capEl = document.getElementById("sk-demo-caption");

    if (usedEl) usedEl.textContent = String(used);
    if (leftEl) leftEl.textContent = String(left);
    if (barEl) {
      barEl.style.width = Math.min(100, Math.round((used / DEFAULT_PTS) * 100)) + "%";
      barEl.className = "sk-meter-fill" + (used > DEFAULT_PTS ? " over" : "");
    }
    if (capEl && caption) capEl.textContent = caption;

    var selected = CATALOG.filter(function (item) { return (counts[item.key] || 0) > 0; });
    if (linesEl) {
      linesEl.innerHTML = selected.length ? selected.map(function (item) {
        var q = counts[item.key];
        return '<li><span>' + q + ' &times; ' + esc(item.label) + ' <small style="opacity:.75">(' + item.points + ' pts each)</small></span>' +
               '<b>&minus;' + (q * item.points) + ' pts</b></li>';
      }).join("") : '<li><span>Your Kart is empty &mdash; 100 pts available!</span><b>0 pts</b></li>';
    }
    if (totalEl) {
      totalEl.textContent = used + " pts deducted (" + left + " pts left for next project)";
    }
  }

  function playWalkthrough() {
    clearAnimTimers();
    activeCatFilter = "all";
    if (catTabsEl) {
      Array.prototype.forEach.call(catTabsEl.querySelectorAll("[data-cat-filter]"), function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-cat-filter") === "all");
      });
    }
    counts = {};
    renderKartDemo(null, "Step 0: New registration on SurveyKart -> 100 Kart points allocated!");
    var steps = [
      { delay: 950, key: "single_select", qty: 1, msg: "Step 1: +1 Single select (-10 pts) -> 90 pts left" },
      { delay: 1900, key: "single_select", qty: 2, msg: "Step 2: +2nd Single select (-20 pts total) -> 80 pts left" },
      { delay: 2950, key: "constant_sum", qty: 1, msg: "Step 3: +1 Constant sum (-20 pts) -> 40 pts used, 60 pts left" },
      { delay: 4050, key: "delta_question", qty: 1, msg: "Step 4: +1 Delta question (-30 pts) -> Total 70 pts deducted, 30 pts remaining!" }
    ];
    steps.forEach(function (st) {
      animTimers.push(setTimeout(function () {
        counts[st.key] = st.qty;
        renderKartDemo(st.key, st.msg);
      }, st.delay));
    });
  }

  if (catEl) {
    renderKartDemo(null, "Example: 2 Single select (20) + 1 Constant sum (20) + 1 Delta (30) = 70 pts deducted, 30 pts left!");
    catEl.addEventListener("click", function (e) {
      var inc = e.target.closest("[data-kart-inc]");
      var dec = e.target.closest("[data-kart-dec]");
      if (!inc && !dec) return;
      clearAnimTimers();
      var key = (inc || dec).getAttribute(inc ? "data-kart-inc" : "data-kart-dec");
      var item = CATALOG.filter(function (x) { return x.key === key; })[0];
      if (!item) return;
      if (inc) {
        if (usedPts() + item.points > DEFAULT_PTS) {
          renderKartDemo(key, "100-pt default Kart reached! For another project or larger Kart, request Admin to allocate more points.");
          return;
        }
        counts[key] = (counts[key] || 0) + 1;
        renderKartDemo(key, "Added " + item.label + " (-" + item.points + " pts) -> " + (DEFAULT_PTS - usedPts()) + " pts remaining in Kart.");
      } else {
        counts[key] = Math.max(0, (counts[key] || 0) - 1);
        renderKartDemo(key, "Removed " + item.label + " (+" + item.points + " pts returned to Kart).");
      }
    });

    if (catTabsEl) {
      catTabsEl.addEventListener("click", function (e) {
        var tab = e.target.closest("[data-cat-filter]");
        if (!tab) return;
        clearAnimTimers();
        activeCatFilter = tab.getAttribute("data-cat-filter") || "all";
        Array.prototype.forEach.call(catTabsEl.querySelectorAll("[data-cat-filter]"), function (b) {
          b.classList.toggle("is-active", b === tab);
        });
        renderKartDemo(null);
      });
    }

    var replayBtn = document.getElementById("sk-demo-replay");
    if (replayBtn) replayBtn.addEventListener("click", playWalkthrough);
    var resetBtn = document.getElementById("sk-demo-reset");
    if (resetBtn) resetBtn.addEventListener("click", function () {
      clearAnimTimers();
      counts = {};
      renderKartDemo(null, "Kart reset -> Full 100 Kart points available! Click + Add on any question type.");
    });

    if (!reduce && "IntersectionObserver" in window) {
      var playedOnce = false;
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting && !playedOnce) {
            playedOnce = true;
            playWalkthrough();
          }
        });
      }, { threshold: 0.35 }).observe(catEl);
    }
  }

  // ---- Forensic Verbatim X-Ray: Open-Ended AI Response Detection Demo ----
  var aiViewport = document.getElementById("sk-ai-viewport");
  if (aiViewport) {
    var AI_PRESETS = {
      chatgpt: {
        displayScore: 89,
        verdict: "likely_ai",
        text: "As an AI language model, switching first-line oncology therapy involves a multifaceted landscape of clinical considerations. Moreover, progression-free survival plays a pivotal role, and it is important to note that delving into tolerability fosters optimal outcomes in summary.",
        meta: { keystrokes: 2, pasted_chars: 268, pastes: 1, input_events: 2, typed_ms: 1750, blur_ms: 6200 },
        aiMarks: ["As an AI language model", "multifaceted", "landscape", "Moreover", "plays a pivotal role", "it is important to note", "delving", "fosters", "in summary"],
        hmMarks: [],
        fallbackSignals: [
          { label: "AI self-reference phrase", weight: 50 },
          { label: "AI-typical vocabulary", weight: 30 },
          { label: "essentially the whole answer was pasted in", weight: 22 },
          { label: "no first person anywhere in the answer", weight: 9 }
        ]
      },
      human: {
        displayScore: 12,
        verdict: "human",
        text: "Honestly in my practice I've switched ~30% of patients within 3 months if grade 3 neutropenia hits or scans show early liver progression. We've found dose holds only buy maybe 2 weeks before patients ask for an oral option.",
        meta: { keystrokes: 228, pasted_chars: 0, pastes: 0, input_events: 224, typed_ms: 34500, blur_ms: 0 },
        aiMarks: [],
        hmMarks: ["Honestly", "in my practice", "I've", "30% of patients", "3 months", "We've", "maybe", "2 weeks"],
        fallbackSignals: [
          { label: "first-person clinical experience", weight: -14 },
          { label: "natural contractions & concrete numbers", weight: -12 },
          { label: "organic keystroke cadence (0% pasted)", weight: -10 }
        ]
      },
      nudge: {
        displayScore: 48,
        verdict: "possible_ai",
        text: "In clinical practice, treatment switching generally depends on progression-free survival and tolerability. Furthermore, it is important to note that biomarker shifts can guide second-line selection when toxicity emerges.",
        meta: { keystrokes: 46, pasted_chars: 112, pastes: 1, input_events: 42, typed_ms: 9400, blur_ms: 2100 },
        aiMarks: ["Furthermore", "it is important to note"],
        hmMarks: ["In clinical practice"],
        fallbackSignals: [
          { label: "AI-typical transition phrasing", weight: 18 },
          { label: "partial clipboard paste burst", weight: 16 },
          { label: "impersonal academic register", weight: 14 }
        ]
      },
      list: {
        displayScore: 94,
        verdict: "likely_ai",
        text: "When it comes to switching therapy, several crucial factors apply:\n1. **Disease Progression** \u2014 radiographic evidence underscores resistance.\n2. **Adverse Events** \u2014 furthermore, robust toxicity management is paramount.\n3. **Biomarker Shift** \u2014 lastly, leveraging comprehensive genomic profiling.",
        meta: { keystrokes: 4, pasted_chars: 286, pastes: 1, input_events: 3, typed_ms: 1900, blur_ms: 4800 },
        aiMarks: ["When it comes to", "crucial", "**Disease Progression**", "\u2014", "underscores", "**Adverse Events**", "furthermore", "robust", "paramount", "**Biomarker Shift**", "lastly", "leveraging", "comprehensive"],
        hmMarks: [],
        fallbackSignals: [
          { label: "AI-typical vocabulary", weight: 30 },
          { label: "formatted like a document, not a typed answer", weight: 20 },
          { label: "essentially the whole answer was pasted in", weight: 22 },
          { label: "the answer is a formatted list, not a typed reply", weight: 12 }
        ]
      }
    };

    var xrayTextEl = document.getElementById("sk-ai-xray-text");
    var customInputEl = document.getElementById("sk-ai-custom-input");
    var scanBeamEl = document.getElementById("sk-ai-scanbeam");
    var arcFillEl = document.getElementById("sk-ai-arc-fill");
    var needleEl = document.getElementById("sk-ai-needle");
    var needlePolyEl = document.getElementById("sk-ai-needle-poly");
    var needleLineEl = document.getElementById("sk-ai-needle-line");
    var needleBeaconEl = document.getElementById("sk-ai-needle-beacon");
    var scoreNumEl = document.getElementById("sk-ai-score-num");
    var verdictPillEl = document.getElementById("sk-ai-verdict-pill");
    var verdictDescEl = document.getElementById("sk-ai-verdict-desc");
    var telKeysEl = document.getElementById("sk-tel-keys");
    var telPasteEl = document.getElementById("sk-tel-paste");
    var telSpeedEl = document.getElementById("sk-tel-speed");
    var telWordsEl = document.getElementById("sk-tel-words");
    var signalsEl = document.getElementById("sk-ai-signals");
    var nudgeEl = document.getElementById("sk-ai-nudge");
    var nudgeTitleEl = document.getElementById("sk-ai-nudge-title");
    var nudgeMsgEl = document.getElementById("sk-ai-nudge-msg");
    var gate1El = document.getElementById("sk-gate-1");
    var gate2El = document.getElementById("sk-gate-2");
    var gate3El = document.getElementById("sk-gate-3");
    var autoBtn = document.getElementById("sk-ai-autocycle");
    var presetBtns = Array.prototype.slice.call(document.querySelectorAll("[data-ai-preset]"));

    var currentMode = "chatgpt";
    var tourTimer = null;
    var checkDebounce = null;
    var liveMeta = { keystrokes: 0, pasted_chars: 0, pastes: 0, input_events: 0, typed_ms: 0, blur_ms: 0, startedAt: 0, blurAt: 0 };

    // Direct-coordinate 60fps Gauge Needle & Arc Animator (immune to CSS/SVG transform bugs)
    var gaugeCurrentScore = 18;
    var gaugeTargetScore = 89;
    var gaugeColor = "#e06c5a";
    var gaugeAnimRaf = null;
    var gaugeStartScore = 18;
    var gaugeStartTime = 0;
    var GAUGE_ARC_LEN = 201.06; // pi * 64

    function drawGaugeAt(scoreVal, colorHex) {
      var clamped = Math.max(0, Math.min(100, scoreVal));
      // Map 0..100 into 0.06..0.94 of the semicircle so the needle always points into the arc
      // and never lies dead-flat on the horizontal floor (0 deg or 180 deg).
      var visualFrac = 0.06 + (clamped / 100) * 0.88;
      var theta = Math.PI * (1 - visualFrac); // pi (left) -> 0 (right)
      var ux = Math.cos(theta);
      var uy = -Math.sin(theta);
      var nx = -uy;
      var ny = ux;

      var cx = 90, cy = 92;
      var rTip = 56;
      var rArc = 64;
      var rTail = 9;
      var halfBase = 3.6;

      var tipX = cx + rTip * ux;
      var tipY = cy + rTip * uy;
      var tailX = cx - rTail * ux;
      var tailY = cy - rTail * uy;
      var leftX = cx + halfBase * nx;
      var leftY = cy + halfBase * ny;
      var rightX = cx - halfBase * nx;
      var rightY = cy - halfBase * ny;
      var arcX = cx + rArc * ux;
      var arcY = cy + rArc * uy;

      if (needlePolyEl) {
        needlePolyEl.setAttribute(
          "points",
          tailX.toFixed(1) + "," + tailY.toFixed(1) + " " +
          leftX.toFixed(1) + "," + leftY.toFixed(1) + " " +
          tipX.toFixed(1) + "," + tipY.toFixed(1) + " " +
          rightX.toFixed(1) + "," + rightY.toFixed(1)
        );
      }
      if (needleLineEl) {
        needleLineEl.setAttribute("x1", String(cx));
        needleLineEl.setAttribute("y1", String(cy));
        needleLineEl.setAttribute("x2", tipX.toFixed(1));
        needleLineEl.setAttribute("y2", tipY.toFixed(1));
      }
      if (needleBeaconEl) {
        needleBeaconEl.setAttribute("cx", arcX.toFixed(1));
        needleBeaconEl.setAttribute("cy", arcY.toFixed(1));
        needleBeaconEl.setAttribute("fill", colorHex);
      }
      if (arcFillEl) {
        var offset = GAUGE_ARC_LEN * (1 - visualFrac);
        arcFillEl.style.strokeDasharray = String(GAUGE_ARC_LEN);
        arcFillEl.style.strokeDashoffset = offset.toFixed(1);
        arcFillEl.style.stroke = colorHex;
      }
      if (scoreNumEl) {
        scoreNumEl.textContent = String(Math.round(clamped));
      }
    }

    function animateGaugeTo(targetScore, verdict) {
      var nextTarget = Math.max(0, Math.min(100, Number(targetScore) || 0));
      var nextColor = verdict === "likely_ai" ? "#e06c5a" : (verdict === "possible_ai" ? "#e0c165" : "#3aa886");

      // If already animating to (or settled at) this exact target score, don't restart the tween
      if (Math.abs(nextTarget - gaugeTargetScore) < 0.5 && gaugeColor === nextColor) {
        if (!gaugeAnimRaf && Math.abs(gaugeCurrentScore - nextTarget) < 0.5) {
          drawGaugeAt(nextTarget, nextColor);
          return;
        }
        if (gaugeAnimRaf) return;
      }

      gaugeTargetScore = nextTarget;
      gaugeColor = nextColor;
      gaugeStartScore = gaugeCurrentScore;
      gaugeStartTime = null;

      if (gaugeAnimRaf) cancelAnimationFrame(gaugeAnimRaf);

      function step(now) {
        if (gaugeStartTime === null) gaugeStartTime = now;
        var elapsed = Math.max(0, now - gaugeStartTime);
        var dur = 480;
        var t = Math.min(1, elapsed / dur);
        var ease = 1 - Math.pow(1 - t, 3);
        gaugeCurrentScore = gaugeStartScore + (gaugeTargetScore - gaugeStartScore) * ease;
        drawGaugeAt(gaugeCurrentScore, gaugeColor);
        if (t < 1) {
          gaugeAnimRaf = requestAnimationFrame(step);
        } else {
          gaugeCurrentScore = gaugeTargetScore;
          drawGaugeAt(gaugeCurrentScore, gaugeColor);
          gaugeAnimRaf = null;
        }
      }

      gaugeAnimRaf = requestAnimationFrame(step);
    }

    function triggerLaser() {
      if (!scanBeamEl || reduce) return;
      scanBeamEl.classList.remove("run");
      void scanBeamEl.offsetWidth;
      scanBeamEl.classList.add("run");
    }

    function highlightText(rawText, aiMarks, hmMarks) {
      var html = esc(rawText).replace(/\n/g, "<br>");
      (aiMarks || []).forEach(function (phrase) {
        var safe = esc(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        html = html.replace(new RegExp(safe, "gi"), function (m) {
          return '<mark class="sk-ai-mark-ai">' + m + '</mark>';
        });
      });
      (hmMarks || []).forEach(function (phrase) {
        var safe = esc(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        html = html.replace(new RegExp(safe, "gi"), function (m) {
          return '<mark class="sk-ai-mark-hm">' + m + '</mark>';
        });
      });
      return html;
    }

    function updateHud(res, text, meta, presetOverride) {
      var rawScore = Math.max(0, Math.min(100, Math.round(res.score || 0)));
      var score = (presetOverride && typeof presetOverride.displayScore === "number")
        ? presetOverride.displayScore
        : rawScore;
      var verdict = (presetOverride && presetOverride.verdict) ||
        res.verdict ||
        (score >= 60 ? "likely_ai" : (score >= 35 ? "possible_ai" : "human"));
      var words = res.words != null ? res.words : (text.trim() ? text.trim().split(/\s+/).length : 0);

      animateGaugeTo(score, verdict);

      var tier = verdict === "likely_ai" ? "bad" : (verdict === "possible_ai" ? "warn" : "ok");
      if (verdictPillEl) {
        verdictPillEl.className = "sk-ai-verdict-pill " + tier;
        verdictPillEl.textContent = verdict === "too_short"
          ? "KEEP TYPING (8+ WORDS)"
          : (tier === "bad" ? "LIKELY AI \u00b7 QC FLAGGED" : (tier === "warn" ? "POSSIBLE AI \u00b7 SOFT NUDGE" : "AUTHENTIC HUMAN \u00b7 VERIFIED"));
      }
      if (verdictDescEl) {
        verdictDescEl.textContent = verdict === "too_short"
          ? "Write at least 8 words so SurveyKart can evaluate linguistic style and typing cadence."
          : (tier === "bad"
              ? "Synthetic LLM phrasing and/or one-shot clipboard burst detected across forensic layers."
              : (tier === "warn"
                  ? "Mixed stylistic signals detected — respondent receives a polite confirmation prompt."
                  : "Natural human cadence, personal clinical phrasing, and organic keystroke timing verified."));
      }

      var chars = Math.max(1, text.length);
      var keys = (meta && meta.keystrokes) || 0;
      var pasted = (meta && meta.pasted_chars) || 0;
      var pastePct = Math.min(100, Math.round((pasted / chars) * 100));
      var secs = Math.max(0.4, ((meta && meta.typed_ms) || 1200) / 1000);
      var cps = text.length ? Math.round((text.length / secs) * 10) / 10 : 0;

      if (telKeysEl) telKeysEl.textContent = keys + (keys === 1 ? " key" : " keys");
      if (telPasteEl) telPasteEl.textContent = pastePct + "% pasted";
      if (telSpeedEl) telSpeedEl.textContent = cps + " ch/s";
      if (telWordsEl) telWordsEl.textContent = words + (words === 1 ? " word" : " words");

      if (nudgeEl && nudgeTitleEl && nudgeMsgEl) {
        nudgeEl.className = "sk-ai-nudge" + (tier === "bad" ? " bad" : (tier === "warn" ? " warn" : ""));
        if (verdict === "too_short") {
          nudgeTitleEl.textContent = "Live Monitor:";
          nudgeMsgEl.textContent = "Waiting for 8+ words to score open-ended verbatim authenticity.";
        } else if (tier === "bad") {
          nudgeTitleEl.textContent = "\u26a0 Respondent Nudge Triggered:";
          nudgeMsgEl.textContent = "This reads like AI-generated or pasted text. Please answer in your own clinical words or confirm before moving on.";
        } else if (tier === "warn") {
          nudgeTitleEl.textContent = "\u25cb Gentle Check:";
          nudgeMsgEl.textContent = "Parts of this answer look pasted or formal — please double-check it reflects your own experience.";
        } else {
          nudgeTitleEl.textContent = "\u2713 Respondent Clear:";
          nudgeMsgEl.textContent = "Authentic first-hand verbatim confirmed — respondent advances seamlessly with zero friction.";
        }
      }

      var sigs = ((res.signals && res.signals.length) ? res.signals : (presetOverride && presetOverride.fallbackSignals) || []).slice(0, 6);
      if (signalsEl) {
        if (!sigs.length) {
          signalsEl.innerHTML = '<span class="sk-sig-chip good">Clean verbatim — no synthetic signals</span>';
        } else {
          signalsEl.innerHTML = sigs.map(function (s) {
            var isHuman = (s.weight || 0) < 0;
            var sign = (s.weight > 0 ? "+" : "") + Math.round(s.weight || 0);
            return '<span class="sk-sig-chip' + (isHuman ? ' good' : '') + '">' +
              esc(s.label || s.id) + ' (' + sign + ')</span>';
          }).join("");
        }
      }

      var gates = Array.prototype.slice.call(document.querySelectorAll("#sk-ai-gates .sk-gate"));
      gates.forEach(function (g) {
        g.className = "sk-gate active-" + tier;
      });
      if (gate1El) gate1El.textContent = tier === "ok" ? "Silent pass (0 friction)" : "Own-words prompt shown";
      if (gate2El) gate2El.textContent = tier === "bad" ? "ai_verbatim flag attached" : (tier === "warn" ? "Soft review note saved" : "Clean QC record");
      if (gate3El) gate3El.textContent = tier === "ok" ? "Verified in XLSX / PPTX" : "Highlighted in AI Queue";
    }

    function scoreViaBackend(text, meta, presetOverride) {
      // Immediately animate the gauge when a preset is selected so there is zero network lag
      if (presetOverride) {
        updateHud({
          score: presetOverride.displayScore,
          verdict: presetOverride.verdict,
          signals: presetOverride.fallbackSignals || []
        }, text, meta, presetOverride);
      }
      fetch("/api/check_text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qid: "Q7", text: text, meta: meta })
      })
        .then(function (r) { return r.json(); })
        .then(function (res) { updateHud(res, text, meta, presetOverride); })
        .catch(function () {});
    }

    function applyPreset(key, fromTour) {
      if (!fromTour && tourTimer) {
        clearInterval(tourTimer);
        tourTimer = null;
        if (autoBtn) autoBtn.classList.add("paused");
      }
      currentMode = key;
      presetBtns.forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-ai-preset") === key);
      });
      triggerLaser();

      if (key === "custom") {
        if (xrayTextEl) xrayTextEl.hidden = true;
        if (customInputEl) {
          customInputEl.hidden = false;
          if (!customInputEl.value) {
            liveMeta = { keystrokes: 0, pasted_chars: 0, pastes: 0, input_events: 0, typed_ms: 600, blur_ms: 0, startedAt: Date.now(), blurAt: 0 };
          }
          customInputEl.focus();
          scoreViaBackend(customInputEl.value || "", liveMeta, null);
        }
        return;
      }

      var p = AI_PRESETS[key] || AI_PRESETS.chatgpt;
      if (customInputEl) customInputEl.hidden = true;
      if (xrayTextEl) {
        xrayTextEl.hidden = false;
        xrayTextEl.innerHTML = highlightText(p.text, p.aiMarks, p.hmMarks);
      }
      scoreViaBackend(p.text, p.meta, p);
    }

    presetBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        applyPreset(btn.getAttribute("data-ai-preset"), false);
      });
    });

    if (customInputEl) {
      customInputEl.addEventListener("keydown", function (e) {
        if (!liveMeta.startedAt) liveMeta.startedAt = Date.now();
        if (e.key && e.key.length === 1) liveMeta.keystrokes += 1;
      });
      customInputEl.addEventListener("paste", function (e) {
        if (!liveMeta.startedAt) liveMeta.startedAt = Date.now();
        var pasted = (e.clipboardData && e.clipboardData.getData("text")) || "";
        liveMeta.pastes += 1;
        liveMeta.pasted_chars += pasted.length;
        triggerLaser();
      });
      customInputEl.addEventListener("input", function () {
        if (!liveMeta.startedAt) liveMeta.startedAt = Date.now();
        liveMeta.input_events += 1;
        liveMeta.typed_ms = Math.max(350, Date.now() - liveMeta.startedAt);
        if (checkDebounce) clearTimeout(checkDebounce);
        checkDebounce = setTimeout(function () {
          scoreViaBackend(customInputEl.value, liveMeta, null);
        }, 160);
      });
    }

    function startTour() {
      if (tourTimer) clearInterval(tourTimer);
      if (autoBtn) autoBtn.classList.remove("paused");
      var order = ["chatgpt", "human", "nudge", "list"];
      var idx = order.indexOf(currentMode);
      if (idx < 0) idx = 0;
      tourTimer = setInterval(function () {
        idx = (idx + 1) % order.length;
        applyPreset(order[idx], true);
      }, 3800);
    }

    if (autoBtn) {
      autoBtn.addEventListener("click", function () {
        if (tourTimer) {
          clearInterval(tourTimer);
          tourTimer = null;
          autoBtn.classList.add("paused");
        } else {
          if (currentMode === "custom") applyPreset("chatgpt", true);
          startTour();
        }
      });
    }

    applyPreset("chatgpt", true);
    startTour();
  }

  // ---- reveal on scroll --------------------------------------------------
  if (!reduce && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.16 });
    document.querySelectorAll(".ln-reveal").forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll(".ln-reveal").forEach(function (el) { el.classList.add("in"); });
  }

  // ---- demo animations replay when a card scrolls back into view ---------
  if (!reduce && "IntersectionObserver" in window) {
    document.querySelectorAll(".ln-demo").forEach(function (card) {
      var visible = false;
      new IntersectionObserver(function (es) {
        es.forEach(function (en) {
          if (!en.isIntersecting) { visible = false; return; }
          if (visible) return;
          if (card.dataset.seen) retrigger(card.querySelector(".ln-demo-stage"));
          card.dataset.seen = "1";
          visible = true;
        });
      }, { threshold: 0.45 }).observe(card);
    });
  }

  // ---- Interactive Straight-Line for Rating Scale Demo (#straightline-demo) ----
  (function initStraightlineDemo() {
    var root = document.getElementById("straightline-demo");
    if (!root) return;

    var matrixCard = document.getElementById("sl-matrix-card");
    var stage = document.getElementById("sl-matrix-stage");
    var svg = document.getElementById("sl-vector-svg");
    var laserBeam = document.getElementById("sl-laser-beam");
    var trajGlow = document.getElementById("sl-traj-glow");
    var trajLine = document.getElementById("sl-traj-line");
    var caliperTag = document.getElementById("sl-caliper-tag");
    var statusBadge = document.getElementById("sl-status-badge");
    var nudgeStrip = document.getElementById("sl-nudge-strip");
    var nudgeLabel = document.getElementById("sl-nudge-label");
    var nudgeText = document.getElementById("sl-nudge-text");

    var seismoPath = document.getElementById("sl-seismo-path");
    var seismoDots = document.getElementById("sl-seismo-dots");
    var seismoCaption = document.getElementById("sl-seismo-caption");

    var mSigma = document.getElementById("sl-m-sigma");
    var mSigmaSub = document.getElementById("sl-m-sigma-sub");
    var mStreak = document.getElementById("sl-m-streak");
    var mStreakSub = document.getElementById("sl-m-streak-sub");
    var mPace = document.getElementById("sl-m-pace");
    var mPaceSub = document.getElementById("sl-m-pace-sub");

    var qcTicket = document.getElementById("sl-qc-ticket");
    var qcFlag = document.getElementById("sl-qc-flag");
    var qcDesc = document.getElementById("sl-qc-desc");
    var step1 = document.getElementById("sl-step-1");
    var step2 = document.getElementById("sl-step-2");
    var step3 = document.getElementById("sl-step-3");
    var tourBtn = document.getElementById("sl-tour-btn");

    var presetBtns = Array.prototype.slice.call(root.querySelectorAll("[data-sl-preset]"));
    var rowEls = Array.prototype.slice.call(root.querySelectorAll("[data-sl-row]"));

    var SCALE_LABELS = { 1: "1 \u00b7 Poor", 2: "2 \u00b7 Fair", 3: "3 \u00b7 Good", 4: "4 \u00b7 Very Good", 5: "5 \u00b7 Exceptional" };
    var PRESETS = {
      col4:  { vals: [4, 4, 4, 4, 4], pace: 0.32, totalSec: 1.6 },
      human: { vals: [5, 3, 4, 2, 5], pace: 2.76, totalSec: 13.8 },
      diag:  { vals: [1, 2, 3, 4, 5], pace: 0.42, totalSec: 2.1 },
      rush5: { vals: [5, 5, 5, 5, 5], pace: 0.24, totalSec: 1.2 }
    };
    var TOUR_ORDER = ["col4", "human", "diag", "rush5"];

    var currentVals = [4, 4, 4, 4, 4];
    var currentPace = 0.32;
    var activePreset = "col4";
    var slTimer = null;
    var lastClickTs = 0;

    function computeStats(vals, pace) {
      var n = vals.length;
      var sum = 0;
      var counts = {};
      var maxCount = 0;
      var domVal = vals[0];
      for (var i = 0; i < n; i++) {
        var v = vals[i];
        sum += v;
        counts[v] = (counts[v] || 0) + 1;
        if (counts[v] > maxCount) {
          maxCount = counts[v];
          domVal = v;
        }
      }
      var mean = sum / n;
      var sq = 0;
      for (var j = 0; j < n; j++) sq += Math.pow(vals[j] - mean, 2);
      var sigma = Math.sqrt(sq / n);

      var maxStreak = 1, curStreak = 1;
      for (var k = 1; k < n; k++) {
        if (vals[k] === vals[k - 1]) {
          curStreak++;
          if (curStreak > maxStreak) maxStreak = curStreak;
        } else {
          curStreak = 1;
        }
      }

      var isAsc = true, isDesc = true;
      for (var m = 1; m < n; m++) {
        if (vals[m] - vals[m - 1] !== 1) isAsc = false;
        if (vals[m] - vals[m - 1] !== -1) isDesc = false;
      }
      var isUniform = maxCount === n;
      var isDiagonal = !isUniform && (isAsc || isDesc);
      var isNearUniform = !isUniform && maxCount >= n - 1;

      var tier = isUniform ? "bad" : ((isDiagonal || isNearUniform) ? "warn" : "ok");
      var flag = isUniform
        ? (pace <= 0.30 ? "straightliner_Q9 + speeder" : "straightliner_Q9")
        : (isDiagonal ? "diagonal_staircase_Q9" : (isNearUniform ? "near_uniform_watch" : "clean \u00b7 verified"));

      return {
        mean: mean,
        sigma: sigma,
        maxCount: maxCount,
        maxStreak: maxStreak,
        domVal: domVal,
        isUniform: isUniform,
        isDiagonal: isDiagonal,
        isNearUniform: isNearUniform,
        tier: tier,
        flag: flag
      };
    }

    function drawVector(st) {
      if (!stage || !svg || !trajLine || !trajGlow || !laserBeam) return;
      var rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      var w = Math.round(rect.width);
      var h = Math.round(rect.height);
      svg.setAttribute("viewBox", "0 0 " + w + " " + h);

      var pts = [];
      rowEls.forEach(function (rowEl, idx) {
        var val = currentVals[idx];
        var btn = rowEl.querySelector('.sl-cell[data-val="' + val + '"]');
        if (!btn) return;
        var br = btn.getBoundingClientRect();
        pts.push({
          x: Math.round((br.left - rect.left + br.width / 2) * 10) / 10,
          y: Math.round((br.top - rect.top + br.height / 2) * 10) / 10
        });
      });
      if (pts.length < 2) return;

      var poly = pts.map(function (p) { return p.x + "," + p.y; }).join(" ");
      trajLine.setAttribute("points", poly);
      trajGlow.setAttribute("points", poly);
      trajLine.setAttribute("class", "sl-traj-line " + st.tier);
      trajGlow.setAttribute("class", "sl-traj-glow " + st.tier);

      if (st.isUniform || st.isDiagonal) {
        var first = pts[0], last = pts[pts.length - 1];
        laserBeam.setAttribute("x1", String(first.x));
        laserBeam.setAttribute("y1", st.isUniform ? "4" : String(first.y));
        laserBeam.setAttribute("x2", String(last.x));
        laserBeam.setAttribute("y2", st.isUniform ? String(h - 4) : String(last.y));
        laserBeam.setAttribute("class", "sl-laser-beam is-visible" + (st.isDiagonal ? " warn" : ""));
      } else {
        laserBeam.setAttribute("class", "sl-laser-beam");
      }
    }

    function drawSeismo(st) {
      if (!seismoPath || !seismoDots) return;
      var xs = [18, 90, 160, 230, 302];
      var coords = currentVals.map(function (v, idx) {
        var delta = v - st.mean;
        var y = st.isUniform ? 42 : Math.max(12, Math.min(72, Math.round(42 - delta * 15)));
        return { x: xs[idx], y: y };
      });
      var d = coords.map(function (c, i) { return (i === 0 ? "M " : "L ") + c.x + " " + c.y; }).join(" ");
      seismoPath.setAttribute("d", d);
      seismoPath.setAttribute("class", "sl-seismo-path " + st.tier);

      seismoDots.setAttribute("class", "sl-seismo-dots " + st.tier);
      seismoDots.innerHTML = coords.map(function (c) {
        return '<circle cx="' + c.x + '" cy="' + c.y + '" r="4.2"/>';
      }).join("");

      if (seismoCaption) {
        seismoCaption.textContent = st.isUniform
          ? "FLATLINE DETECTED \u00b7 ZERO DIFFERENTIATION ACROSS ITEMS"
          : (st.isDiagonal
              ? "LINEAR STAIRCASE RAMP \u00b7 MECHANICAL DIAGONAL CLICKING"
              : (st.isNearUniform
                  ? "LOW-SPREAD TRACE \u00b7 4 OF 5 ITEMS IN ONE COLUMN"
                  : "ORGANIC VARIANCE WAVE \u00b7 DIFFERENTIATED CLINICAL JUDGMENT"));
      }
    }

    function renderState() {
      var st = computeStats(currentVals, currentPace);

      if (matrixCard) matrixCard.setAttribute("data-sl-state", st.tier);

      rowEls.forEach(function (rowEl, idx) {
        var pickedVal = currentVals[idx];
        var cells = rowEl.querySelectorAll(".sl-cell");
        Array.prototype.forEach.call(cells, function (btn) {
          var v = Number(btn.getAttribute("data-val"));
          var on = v === pickedVal;
          btn.classList.toggle("is-picked", on);
          btn.classList.toggle("is-locked", on && st.tier === "bad");
          btn.classList.toggle("is-warn", on && st.tier === "warn");
          btn.setAttribute("aria-pressed", on ? "true" : "false");
        });
      });

      if (statusBadge) {
        statusBadge.className = "sl-status-badge " + st.tier;
        statusBadge.textContent = st.isUniform
          ? "COLUMN LOCK \u00b7 \u03c3 = 0.00"
          : (st.isDiagonal
              ? "DIAGONAL STAIRCASE \u00b7 WATCH"
              : (st.isNearUniform
                  ? "NEAR-UNIFORM \u00b7 \u03c3 = " + st.sigma.toFixed(2)
                  : "GENUINE VARIANCE \u00b7 \u03c3 = " + st.sigma.toFixed(2)));
      }

      if (caliperTag) {
        caliperTag.className = "sl-caliper-tag" + (st.tier === "bad" ? "" : (" " + st.tier));
        caliperTag.textContent = st.isUniform
          ? "LOCKED COL " + st.domVal + " \u00b7 5/5 IDENTICAL"
          : (st.isDiagonal
              ? "DIAGONAL VECTOR 1\u21925"
              : (st.isNearUniform
                  ? "4/5 SAME COLUMN (" + st.domVal + ")"
                  : "HEALTHY SPREAD \u00b7 " + Object.keys(currentVals.reduce(function (a, x) { a[x] = 1; return a; }, {})).length + " SCALE PTS USED"));
      }

      if (nudgeStrip && nudgeLabel && nudgeText) {
        nudgeStrip.className = "sl-nudge-strip " + st.tier;
        if (st.isUniform) {
          nudgeLabel.textContent = "Live Respondent Nudge:";
          nudgeText.textContent = "All 5 attributes are rated \"" + SCALE_LABELS[st.domVal] + "\" in " + (currentPace * 5).toFixed(1) + "s \u2014 please review each row individually before continuing.";
        } else if (st.isDiagonal) {
          nudgeLabel.textContent = "Pattern Watch Prompt:";
          nudgeText.textContent = "Ratings step mechanically across 1\u20132\u20133\u20134\u20135 \u2014 respondent receives a gentle check to confirm each clinical attribute.";
        } else if (st.isNearUniform) {
          nudgeLabel.textContent = "Soft Variance Check:";
          nudgeText.textContent = "80% of rows share column " + st.domVal + " (\u03c3 = " + st.sigma.toFixed(2) + ") \u2014 recorded cleanly with a low-differentiation note.";
        } else {
          nudgeLabel.textContent = "Verified Respondent Flow:";
          nudgeText.textContent = "Zero interruption! Respondent differentiates strengths and trade-offs naturally across the 1\u20135 scale.";
        }
      }

      if (mSigma) mSigma.textContent = st.sigma.toFixed(2);
      if (mSigmaSub) mSigmaSub.textContent = st.isUniform ? "Zero variance" : (st.sigma >= 0.9 ? "Healthy spread" : "Low spread");
      if (mStreak) mStreak.textContent = st.maxCount + " / 5";
      if (mStreakSub) mStreakSub.textContent = Math.round((st.maxCount / 5) * 100) + "% Col " + st.domVal + (st.isUniform ? " lock" : " max");
      if (mPace) mPace.textContent = currentPace.toFixed(2) + "s";
      if (mPaceSub) mPaceSub.textContent = currentPace < 0.6 ? "Speed-click burst" : "Considered read";

      if (qcTicket) qcTicket.className = "sl-qc-ticket " + st.tier;
      if (qcFlag) qcFlag.textContent = st.flag;
      if (qcDesc) {
        qcDesc.textContent = st.isUniform
          ? "Uniform column selection triggered automatic QC flag. Response is preserved in audit history and can be excluded from means & PowerPoint charts in one click."
          : (st.tier === "warn"
              ? "Mechanical staircase or near-uniform column streak logged for analyst review without blocking legitimate edge-case opinions."
              : "Passes SurveyKart straight-line & speed checks cleanly — full weight included in live top-2-box means and crosstabs.");
      }
      if (step1) step1.classList.toggle("is-on", st.tier !== "ok");
      if (step2) step2.classList.toggle("is-on", st.isUniform);
      if (step3) step3.classList.toggle("is-on", true);

      presetBtns.forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-sl-preset") === activePreset);
      });

      drawSeismo(st);
      requestAnimationFrame(function () { drawVector(st); });
    }

    function applyPreset(key) {
      var p = PRESETS[key];
      if (!p) return;
      activePreset = key;
      currentVals = p.vals.slice();
      currentPace = p.pace;
      renderState();
    }

    function stopSlTour() {
      if (slTimer) {
        clearInterval(slTimer);
        slTimer = null;
      }
    }

    function startSlTour() {
      stopSlTour();
      if (reduce) return;
      var idx = Math.max(0, TOUR_ORDER.indexOf(activePreset));
      slTimer = setInterval(function () {
        idx = (idx + 1) % TOUR_ORDER.length;
        applyPreset(TOUR_ORDER[idx]);
      }, 4600);
    }

    presetBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        stopSlTour();
        applyPreset(btn.getAttribute("data-sl-preset"));
      });
    });

    rowEls.forEach(function (rowEl, rowIdx) {
      rowEl.addEventListener("click", function (ev) {
        var cell = ev.target.closest(".sl-cell");
        if (!cell) return;
        stopSlTour();
        activePreset = "";
        var now = Date.now();
        if (lastClickTs && now - lastClickTs < 6000) {
          currentPace = Math.max(0.18, Math.min(4.5, (now - lastClickTs) / 1000));
        } else {
          currentPace = 1.45;
        }
        lastClickTs = now;
        currentVals[rowIdx] = Number(cell.getAttribute("data-val")) || 3;
        renderState();
      });
    });

    if (tourBtn) {
      tourBtn.addEventListener("click", function () {
        var nextIdx = (TOUR_ORDER.indexOf(activePreset) + 1) % TOUR_ORDER.length;
        applyPreset(TOUR_ORDER[nextIdx]);
        startSlTour();
      });
    }

    if (typeof ResizeObserver !== "undefined" && stage) {
      new ResizeObserver(function () {
        renderState();
      }).observe(stage);
    } else {
      window.addEventListener("resize", function () { renderState(); });
    }

    applyPreset("col4");
    startSlTour();
  })();

  // ---- Interactive Dictate & Voice Recording Demo (#voice-open-demo) ----
  (function initVoiceOpenDemo() {
    var root = document.getElementById("voice-open-demo");
    if (!root) return;

    var presetBtns = Array.prototype.slice.call(root.querySelectorAll("[data-vc-preset]"));
    var reelL = document.getElementById("vc-reel-l");
    var reelR = document.getElementById("vc-reel-r");
    var modeChip = document.getElementById("vc-mode-chip");
    var timecodeEl = document.getElementById("vc-timecode");
    var playBtn = document.getElementById("vc-play-btn");
    var soundBtn = document.getElementById("vc-sound-toggle");
    var waveStage = document.getElementById("vc-wave-stage");
    var waveBarsWrap = document.getElementById("vc-wave-bars");
    var barEls = waveBarsWrap ? Array.prototype.slice.call(waveBarsWrap.querySelectorAll("i")) : [];
    var playhead = document.getElementById("vc-playhead");
    var filePill = document.getElementById("vc-file-pill");
    var vuDb = document.getElementById("vc-vu-db");

    var livePill = document.getElementById("vc-live-pill");
    var finalWordsEl = document.getElementById("vc-final-words");
    var interimWordsEl = document.getElementById("vc-interim-words");
    var caretEl = document.getElementById("vc-voice-caret");
    var keyTermsEl = document.getElementById("vc-key-terms");
    var editNoteEl = document.getElementById("vc-edit-note");

    var multBadge = document.getElementById("vc-mult-badge");
    var spokenStat = document.getElementById("vc-spoken-stat");
    var spokenFill = document.getElementById("vc-spoken-fill");
    var kWords = document.getElementById("vc-k-words");
    var kWordsSub = document.getElementById("vc-k-words-sub");
    var kWpm = document.getElementById("vc-k-wpm");
    var kAuth = document.getElementById("vc-k-auth");
    var kAuthSub = document.getElementById("vc-k-auth-sub");
    var archDictate = document.getElementById("vc-arch-dictate");
    var archRecord = document.getElementById("vc-arch-record");

    var BASE_HEIGHTS = [28, 52, 76, 44, 88, 64, 34, 72, 94, 58, 40, 82, 68, 30, 74, 90, 56, 46, 84, 62, 36, 78, 92, 54, 42, 70, 48, 32];

    var SCENARIOS = {
      clinician: {
        chip: "\uD83C\uDF99\uFE0F DICTATE STREAM",
        file: "\uD83C\uDF99\uFE0F SpeechRecognition \u00b7 live stream into Q11 box",
        channel: "dictate",
        duration: 15.6,
        wpm: 200,
        mult: "3.7\u00d7 Richer",
        fillPct: 92,
        terms: ["grade-2 neuropathy", "cycle four", "oral once-daily", "home adherence"],
        text: "Honestly, once grade-2 neuropathy appears around cycle four, I switch my older patients to the oral once-daily regimen because home adherence stays high and families avoid extra infusion clinic trips."
      },
      clip: {
        chip: "\uD83C\uDFA4 OPUS VOICE CLIP",
        file: "\uD83D\uDCBE R042_Q11.webm \u00b7 24.8 KB stored via /api/voice",
        channel: "record",
        duration: 18.4,
        wpm: 186,
        mult: "4.1\u00d7 Richer",
        fillPct: 96,
        terms: ["renal clearance", "caregiver support", "dose flexibility", "frail elderly"],
        text: "For frail elderly patients with borderline renal clearance, I rely heavily on dose flexibility and caregiver support at home; hearing how tired they sound in clinic tells me when to step down early."
      },
      mobile: {
        chip: "\uD83D\uDCF1 MOBILE HANDS-FREE",
        file: "\uD83D\uDCF1 Ward Phone Mic \u00b7 zero thumb-typing fatigue",
        channel: "dictate",
        duration: 11.2,
        wpm: 193,
        mult: "3.1\u00d7 Richer",
        fillPct: 84,
        terms: ["infusion chair wait", "subcutaneous dosing", "ward rounds"],
        text: "Between ward rounds I rarely have two hands free to type long paragraphs, so tapping Dictate lets me explain how infusion chair wait times push our team toward subcutaneous dosing."
      }
    };

    var activeMode = "clinician";
    var streamTimer = null;
    var wordIdx = 0;
    var currentWords = [];
    var audioEnabled = false;
    var audioCtx = null;
    var liveRecognition = null;
    var micStartedAt = 0;

    function highlightTerms(text, terms) {
      var html = esc(text);
      (terms || []).forEach(function (term) {
        var safe = esc(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        html = html.replace(new RegExp("(" + safe + ")", "gi"), '<span class="vc-term-hl">$1</span>');
      });
      return html;
    }

    function playSyllablePing(idx) {
      if (!audioEnabled) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!audioCtx) audioCtx = new AC();
        if (audioCtx.state === "suspended") audioCtx.resume();
        var now = audioCtx.currentTime;
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        var freqs = [196, 220, 246.9, 261.6, 293.7, 246.9, 220];
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freqs[idx % freqs.length], now);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.exponentialRampToValueAtTime(0.028, now + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.095);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.1);
      } catch (e) {}
    }

    function setSpinning(on) {
      if (reelL) reelL.classList.toggle("is-spinning", !!on && !reduce);
      if (reelR) reelR.classList.toggle("is-spinning", !!on && !reduce);
      if (caretEl) caretEl.classList.toggle("is-idle", !on);
    }

    function updateWaveform(progress, liveEnergy) {
      var pct = Math.max(0, Math.min(1, progress));
      if (playhead) playhead.style.left = Math.round(pct * 96 + 2) + "%";
      var activeBar = Math.floor(pct * (barEls.length - 1));
      barEls.forEach(function (bar, i) {
        var base = BASE_HEIGHTS[i % BASE_HEIGHTS.length];
        var jitter = liveEnergy ? (((i * 17 + Math.round(pct * 100)) % 22) - 10) : 0;
        var h = Math.max(18, Math.min(96, base + jitter));
        bar.style.setProperty("--h", h + "%");
        bar.classList.toggle("is-past", i <= activeBar);
        bar.classList.toggle("is-live", liveEnergy && Math.abs(i - activeBar) <= 1);
      });
    }

    function formatTime(sec) {
      var s = Math.max(0, sec);
      var whole = Math.floor(s);
      var tenths = Math.floor((s - whole) * 10);
      var mm = String(Math.floor(whole / 60)).padStart(2, "0");
      var ss = String(whole % 60).padStart(2, "0");
      return mm + ":" + ss + "." + tenths;
    }

    function stopEverything() {
      if (streamTimer) {
        clearInterval(streamTimer);
        streamTimer = null;
      }
      if (liveRecognition) {
        try { liveRecognition.stop(); } catch (e) {}
        liveRecognition = null;
      }
      setSpinning(false);
    }

    function renderScenarioProgress(sc, count, isDone) {
      var total = currentWords.length || 1;
      var shown = currentWords.slice(0, count).join(" ");
      var nextPreview = !isDone && count < total ? " " + currentWords.slice(count, Math.min(total, count + 2)).join(" ") : "";
      var pct = Math.min(1, count / total);

      if (finalWordsEl) finalWordsEl.innerHTML = highlightTerms(shown, sc.terms);
      if (interimWordsEl) interimWordsEl.textContent = nextPreview;

      var elapsed = sc.duration * pct;
      if (timecodeEl) timecodeEl.textContent = formatTime(elapsed);
      if (vuDb) {
        var db = isDone ? "-48.0 dB" : ("-" + (4.2 + ((count * 7) % 9) * 0.9).toFixed(1) + " dB");
        vuDb.textContent = db;
      }
      updateWaveform(pct, !isDone);

      if (livePill) {
        livePill.className = "vc-live-pill" + (isDone ? " done" : "");
        livePill.textContent = isDone
          ? (sc.channel === "record" ? "\u2713 Voice Clip Attached" : "\u2713 Transcript Ready")
          : (sc.channel === "record" ? "\u25cf Playing Voice Clip" : "\u25cf Streaming to Box");
      }
      if (playBtn) {
        playBtn.innerHTML = isDone ? "&#9654; Replay Stream" : "&#9208; Pause";
      }
    }

    function applyScenario(key, instant) {
      stopEverything();
      var sc = SCENARIOS[key] || SCENARIOS.clinician;
      activeMode = key;
      currentWords = sc.text.split(/\s+/);

      presetBtns.forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-vc-preset") === key);
      });
      if (modeChip) modeChip.textContent = sc.chip;
      if (filePill) filePill.textContent = sc.file;
      if (multBadge) multBadge.textContent = sc.mult;
      if (spokenStat) spokenStat.textContent = currentWords.length + " words \u00b7 " + Math.round(sc.duration) + "s";
      if (spokenFill) spokenFill.style.width = sc.fillPct + "%";
      if (kWords) kWords.textContent = String(currentWords.length);
      if (kWordsSub) kWordsSub.textContent = sc.terms.length + " clinical themes";
      if (kWpm) kWpm.textContent = String(sc.wpm);
      if (kAuth) kAuth.textContent = "Human";
      if (kAuthSub) kAuthSub.textContent = sc.channel === "record" ? "Opus audio + text" : "0% clipboard paste";
      if (archDictate) archDictate.classList.toggle("is-active", sc.channel === "dictate");
      if (archRecord) archRecord.classList.toggle("is-active", sc.channel === "record");
      if (editNoteEl) editNoteEl.innerHTML = sc.channel === "record" ? "&#128266; Replay or delete anytime" : "&#9998; Editable before Next &rarr;";

      if (keyTermsEl) {
        keyTermsEl.innerHTML = sc.terms.map(function (t) {
          return '<span class="vc-term-chip">' + esc(t) + '</span>';
        }).join("");
      }

      if (instant || reduce) {
        wordIdx = currentWords.length;
        renderScenarioProgress(sc, wordIdx, true);
        setSpinning(false);
        return;
      }

      wordIdx = Math.min(4, currentWords.length);
      setSpinning(true);
      renderScenarioProgress(sc, wordIdx, false);
      streamTimer = setInterval(function () {
        wordIdx += 1;
        playSyllablePing(wordIdx);
        if (wordIdx >= currentWords.length) {
          renderScenarioProgress(sc, currentWords.length, true);
          stopEverything();
        } else {
          renderScenarioProgress(sc, wordIdx, false);
        }
      }, 210);
    }

    function startLiveMicMode() {
      stopEverything();
      activeMode = "mic";
      presetBtns.forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-vc-preset") === "mic");
      });
      if (modeChip) modeChip.textContent = "\u25cf LIVE BROWSER MIC";
      if (archDictate) archDictate.classList.add("is-active");
      if (archRecord) archRecord.classList.remove("is-active");

      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        if (filePill) filePill.textContent = "Browser SpeechRecognition unavailable here \u2014 playing simulated live mic";
        applyScenario("clinician", false);
        return;
      }

      if (filePill) filePill.textContent = "\uD83C\uDF99\uFE0F Speak into your microphone \u2014 words stream live below";
      if (finalWordsEl) finalWordsEl.textContent = "";
      if (interimWordsEl) interimWordsEl.textContent = "Listening\u2026 speak a sentence about any product or therapy\u2026";
      if (keyTermsEl) keyTermsEl.innerHTML = '<span class="vc-term-chip">Live Microphone Active</span>';
      if (livePill) {
        livePill.className = "vc-live-pill";
        livePill.textContent = "\u25cf Listening Live";
      }
      if (playBtn) playBtn.innerHTML = "&#9724; Stop Mic";

      var committed = "";
      micStartedAt = Date.now();
      setSpinning(true);

      try {
        var rec = new SR();
        liveRecognition = rec;
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = "en-US";
        var finalizedByIdx = {};
        rec.onresult = function (ev) {
          var interim = "";
          for (var i = 0; i < ev.results.length; i++) {
            var res = ev.results[i];
            if (!res || !res[0]) continue;
            var txt = String(res[0].transcript || "").trim();
            if (!txt) continue;
            if (res.isFinal) {
              if (finalizedByIdx[i] !== txt) {
                finalizedByIdx[i] = txt;
                committed += (committed ? " " : "") + txt;
              }
            } else {
              interim += (interim ? " " : "") + txt;
            }
          }
          var combined = (committed + " " + interim).trim();
          var wc = combined ? combined.split(/\s+/).length : 0;
          var secs = Math.max(1, (Date.now() - micStartedAt) / 1000);
          if (finalWordsEl) finalWordsEl.textContent = committed;
          if (interimWordsEl) interimWordsEl.textContent = interim ? (" " + interim) : "";
          if (timecodeEl) timecodeEl.textContent = formatTime(secs);
          if (vuDb) vuDb.textContent = "-" + (5 + (wc % 7)).toFixed(1) + " dB";
          if (kWords) kWords.textContent = String(wc);
          if (kWpm) kWpm.textContent = String(Math.min(260, Math.round((wc / secs) * 60)));
          if (spokenStat) spokenStat.textContent = wc + " words \u00b7 " + Math.round(secs) + "s";
          updateWaveform(Math.min(0.96, (wc % 28) / 28 + 0.1), true);
        };
        rec.onerror = function () {
          stopEverything();
          if (interimWordsEl) interimWordsEl.textContent = " (Mic permission blocked or unavailable \u2014 click Live Clinician Dictation to preview)";
          if (livePill) {
            livePill.className = "vc-live-pill done";
            livePill.textContent = "Mic Paused";
          }
          if (playBtn) playBtn.innerHTML = "&#9654; Retry Mic";
        };
        rec.onend = function () {
          setSpinning(false);
          if (livePill) {
            livePill.className = "vc-live-pill done";
            livePill.textContent = "\u2713 Mic Captured";
          }
          if (playBtn) playBtn.innerHTML = "&#9654; Speak Again";
        };
        rec.start();
      } catch (err) {
        applyScenario("clinician", false);
      }
    }

    presetBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-vc-preset");
        if (key === "mic") startLiveMicMode();
        else applyScenario(key, false);
      });
    });

    if (playBtn) {
      playBtn.addEventListener("click", function () {
        if (activeMode === "mic") {
          if (liveRecognition) stopEverything();
          else startLiveMicMode();
          return;
        }
        var sc = SCENARIOS[activeMode] || SCENARIOS.clinician;
        if (streamTimer) {
          stopEverything();
          if (playBtn) playBtn.innerHTML = "&#9654; Resume";
          if (livePill) livePill.textContent = "Paused";
        } else if (wordIdx > 0 && wordIdx < currentWords.length) {
          setSpinning(true);
          streamTimer = setInterval(function () {
            wordIdx += 1;
            playSyllablePing(wordIdx);
            if (wordIdx >= currentWords.length) {
              renderScenarioProgress(sc, currentWords.length, true);
              stopEverything();
            } else {
              renderScenarioProgress(sc, wordIdx, false);
            }
          }, 210);
        } else {
          applyScenario(activeMode, false);
        }
      });
    }

    if (soundBtn) {
      soundBtn.addEventListener("click", function () {
        audioEnabled = !audioEnabled;
        soundBtn.setAttribute("aria-pressed", audioEnabled ? "true" : "false");
        soundBtn.innerHTML = audioEnabled ? "&#128266; Audio On" : "&#128264; Audio Off";
        if (audioEnabled && !streamTimer && activeMode !== "mic") {
          applyScenario(activeMode, false);
        }
      });
    }

    if (waveStage) {
      waveStage.addEventListener("click", function (ev) {
        if (activeMode === "mic") return;
        var rect = waveStage.getBoundingClientRect();
        if (!rect.width) return;
        var ratio = Math.max(0.05, Math.min(1, (ev.clientX - rect.left) / rect.width));
        stopEverything();
        var sc = SCENARIOS[activeMode] || SCENARIOS.clinician;
        wordIdx = Math.max(1, Math.round(ratio * currentWords.length));
        renderScenarioProgress(sc, wordIdx, wordIdx >= currentWords.length);
      });
    }

    applyScenario("clinician", false);
  })();

  // ---- Interactive Walkthrough Questions Demo (#walkthrough-demo) ----
  (function initWalkthroughDemo() {
    var root = document.getElementById("walkthrough-demo");
    if (!root) return;

    var tabBtns = Array.prototype.slice.call(root.querySelectorAll("[data-wt-ch]"));
    var scenes = Array.prototype.slice.call(root.querySelectorAll("[data-wt-scene]"));
    var timePill = document.getElementById("wt-time-pill");
    var ptsPill = document.getElementById("wt-pts-pill");
    var ptsNum = document.getElementById("wt-pts-num");
    var rankPill = document.getElementById("wt-rank-pill");
    var captionEl = document.getElementById("wt-caption-text");
    var prevBtn = document.getElementById("wt-prev-btn");
    var nextBtn = document.getElementById("wt-next-btn");
    var playBtn = document.getElementById("wt-play-btn");
    var kTime = document.getElementById("wt-k-time");
    var kEng = document.getElementById("wt-k-eng");
    var kEngSub = document.getElementById("wt-k-eng-sub");
    var reactBtns = Array.prototype.slice.call(root.querySelectorAll("[data-wt-pick]"));
    var coachText = document.getElementById("wt-coach-text");
    var segFills = [0, 1, 2, 3].map(function (i) { return document.getElementById("wt-seg-fill-" + i); });

    var CHAPTERS = [
      {
        time: "\u23f1 10s visual chapter \u00b7 saves 3m reading",
        pts: 25,
        rank: "Engaged Responder",
        kTime: "10 sec",
        eng: "94%",
        engSub: "Calm visual entry",
        caption: "Chapter 01 \u2014 Keeping the responder\u2019s time at heart: instead of a 600-word dense table, they meet the patient case in 10 calm, visual seconds."
      },
      {
        time: "\u23f1 12s guided flow \u00b7 zero study-arm confusion",
        pts: 50,
        rank: "Clinical Explorer",
        kTime: "22 sec",
        eng: "96%",
        engSub: "Zero skim-fatigue",
        caption: "Chapter 02 \u2014 Animated pathway pulses show the 1:1 trial design effortlessly, respecting cognitive energy between busy clinic appointments."
      },
      {
        time: "\u23f1 12s self-drawing curve \u00b7 instant clarity",
        pts: 75,
        rank: "Insight Specialist",
        kTime: "34 sec",
        eng: "97%",
        engSub: "High comprehension",
        caption: "Chapter 03 \u2014 Survival separation (+6.6 mo PFS) draws live before their eyes \u2014 no squinting at tiny footnotes just to earn an honorarium."
      },
      {
        time: "\u23f1 11s two-way check-in \u00b7 responder feels heard",
        pts: 100,
        rank: "Valued Fellow",
        kTime: "45 sec",
        eng: "98%",
        engSub: "Two-way dialogue",
        caption: "Chapter 04 \u2014 Valuing responders beyond an honorarium: a warm micro-interaction invites their perspective and tailors upcoming questions."
      }
    ];

    var REACTIONS = {
      pfs: "+6.6 mo PFS Separation",
      oral: "Once-Daily Home Freedom",
      care: "Clear 45s Visual Format"
    };

    var curCh = 0;
    var tick = 0;
    var TICKS_PER_CH = 40;
    var playing = !reduce;
    var wtTimer = null;

    function bumpPoints(val) {
      if (ptsNum) ptsNum.textContent = String(val);
      if (ptsPill && !reduce) {
        ptsPill.classList.remove("is-bump");
        void ptsPill.offsetWidth;
        ptsPill.classList.add("is-bump");
        setTimeout(function () { ptsPill.classList.remove("is-bump"); }, 280);
      }
    }

    function updateSegBars(chIdx, pct) {
      segFills.forEach(function (el, i) {
        if (!el) return;
        if (i < chIdx) el.style.width = "100%";
        else if (i > chIdx) el.style.width = "0%";
        else el.style.width = Math.max(8, Math.min(100, Math.round(pct * 100))) + "%";
      });
    }

    function showChapter(idx, resetProgress) {
      curCh = (idx + CHAPTERS.length) % CHAPTERS.length;
      if (resetProgress) tick = 0;
      var ch = CHAPTERS[curCh];

      tabBtns.forEach(function (b, i) {
        b.classList.toggle("is-active", i === curCh);
      });

      scenes.forEach(function (sc, i) {
        var on = i === curCh;
        sc.classList.toggle("is-active", on);
        if (on && !reduce) {
          var svg = sc.querySelector("svg");
          if (svg) {
            var clone = svg.cloneNode(true);
            svg.parentNode.replaceChild(clone, svg);
          }
        }
      });

      if (timePill) timePill.textContent = ch.time;
      bumpPoints(ch.pts);
      if (rankPill) rankPill.textContent = ch.rank;
      if (captionEl) captionEl.textContent = ch.caption;
      if (kTime) kTime.textContent = ch.kTime;
      if (kEng) kEng.textContent = ch.eng;
      if (kEngSub) kEngSub.textContent = ch.engSub;
      updateSegBars(curCh, reduce ? 1 : (tick / TICKS_PER_CH));
    }

    function stopAuto() {
      playing = false;
      if (wtTimer) {
        clearInterval(wtTimer);
        wtTimer = null;
      }
      if (playBtn) playBtn.innerHTML = "&#9654; Auto-Story";
    }

    function startAuto() {
      if (reduce) return;
      if (wtTimer) clearInterval(wtTimer);
      playing = true;
      if (playBtn) playBtn.innerHTML = "&#9208; Auto-Story";
      wtTimer = setInterval(function () {
        tick += 1;
        if (tick > TICKS_PER_CH) {
          tick = 0;
          showChapter((curCh + 1) % CHAPTERS.length, true);
        } else {
          updateSegBars(curCh, tick / TICKS_PER_CH);
        }
      }, 95);
    }

    tabBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        stopAuto();
        showChapter(Number(btn.getAttribute("data-wt-ch")) || 0, true);
        updateSegBars(curCh, 1);
      });
    });

    if (prevBtn) {
      prevBtn.addEventListener("click", function () {
        stopAuto();
        showChapter(curCh - 1, true);
        updateSegBars(curCh, 1);
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener("click", function () {
        stopAuto();
        showChapter(curCh + 1, true);
        updateSegBars(curCh, 1);
      });
    }
    if (playBtn) {
      playBtn.addEventListener("click", function () {
        if (playing) stopAuto();
        else startAuto();
      });
    }

    reactBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        stopAuto();
        var key = btn.getAttribute("data-wt-pick") || "pfs";
        reactBtns.forEach(function (b) {
          b.classList.toggle("is-selected", b === btn);
        });
        bumpPoints(125);
        if (rankPill) rankPill.textContent = "Co-Creator Fellow";
        if (coachText) {
          coachText.innerHTML = "<strong>Thank you for sharing!</strong> You unlocked <b>+25 Bonus Insight Pts</b> \u2014 we\u2019ll tailor the next two questions around <em>" + esc(REACTIONS[key] || REACTIONS.pfs) + "</em> so every minute of your time feels respected.";
        }
      });
    });

    showChapter(0, true);
    if (!reduce) startAuto();
  })();

  // ---- Signature Animated SurveyKart Key Features Flow Infographic -------
  (function initSurveyKartFlowShowcase() {
    var board = document.getElementById("sk-flow-board");
    if (!board) return;

    var filterBtns = Array.prototype.slice.call(board.querySelectorAll(".skf-filter-btn[data-skf-stream]"));
    var nodes = Array.prototype.slice.call(board.querySelectorAll(".skf-node[data-stream]"));
    var ribbons = Array.prototype.slice.call(board.querySelectorAll(".skf-ribbon-group[data-ribbon]"));
    var readoutTitle = document.getElementById("skf-readout-title");
    var readoutCopy = document.getElementById("skf-readout-copy");

    var STREAM_META = {
      all: {
        title: "All 4 Engines Active:",
        copy: "100 Kart pts \u2192 Voice + AI QC \u2192 Live .PPTX"
      },
      kart: {
        title: "Kart Store Streaming:",
        copy: "100 free signup pts across 23 question types (10\u201340 pts)"
      },
      voice: {
        title: "Voice & Dictate Streaming:",
        copy: "Say option numbers/names or dictate full paragraphs live"
      },
      qc: {
        title: "AI & Plumb-Line QC Streaming:",
        copy: "7-signal AI X-Ray + \u03c3 = 0.00 straight-line guard"
      },
      deck: {
        title: "Live Deck & Share Streaming:",
        copy: "0-pt shared links + instant crosstabs & native .PPTX"
      }
    };

    var lockedStream = "all";

    function applyStream(stream) {
      var meta = STREAM_META[stream] || STREAM_META.all;
      board.setAttribute("data-active-stream", stream);
      filterBtns.forEach(function (btn) {
        btn.classList.toggle("is-active", btn.getAttribute("data-skf-stream") === stream);
      });
      nodes.forEach(function (node) {
        var match = stream !== "all" && node.getAttribute("data-stream") === stream;
        node.classList.toggle("is-spotlight", match);
      });
      ribbons.forEach(function (rib) {
        var match = stream !== "all" && rib.getAttribute("data-ribbon") === stream;
        rib.classList.toggle("is-spotlight", match);
      });
      if (readoutTitle) readoutTitle.textContent = meta.title;
      if (readoutCopy) readoutCopy.textContent = meta.copy;
    }

    filterBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        lockedStream = btn.getAttribute("data-skf-stream") || "all";
        applyStream(lockedStream);
      });
    });

    nodes.forEach(function (node) {
      var st = node.getAttribute("data-stream") || "all";
      node.addEventListener("mouseenter", function () {
        applyStream(st);
      });
      node.addEventListener("mouseleave", function () {
        applyStream(lockedStream);
      });
      node.addEventListener("click", function (ev) {
        if (ev.target && ev.target.closest("a")) return;
        lockedStream = (lockedStream === st) ? "all" : st;
        applyStream(lockedStream);
      });
    });

    applyStream("all");
  })();

  // ---- who is signed in --------------------------------------------------
  function renderAuth(me) {
    var chip = document.getElementById("ln-auth");
    if (me.dev_login) {
      var devbox = document.getElementById("ln-devbox");
      if (devbox) devbox.hidden = false;
    }
    if (!chip || !me.user) return;
    if (me.user.status === "approved") {
      var kartBadge = me.user.role === "admin"
        ? '<a class="ln-btn ln-btn-gold sm" href="/admin/console">&#9733; Admin Console</a><a class="ln-btn ln-btn-ghost sm" href="/admin-portal">Portal</a>'
        : '<span class="ln-btn ln-btn-gold sm" style="cursor:default">&#128722; ' + me.user.points_balance + ' / ' + me.user.points_limit + ' pts</span>';
      chip.innerHTML = '<span class="ln-joined" style="flex-wrap:wrap">' +
        kartBadge +
        '<span class="ln-uname">' + esc(accountLabel(me.user)) + "</span>" +
        '<a class="ln-btn ln-btn-primary sm" href="/studio/">Studio</a>' +
        '<a class="ln-btn ln-btn-ghost sm" href="/signin?next=/welcome">Use a different account</a>' +
        '<button class="ln-btn ln-btn-ghost sm" id="ln-signout" type="button">Sign out</button></span>';
    } else {
      chip.innerHTML = '<span class="ln-joined">' +
        '<span class="ln-uname">' + esc(accountLabel(me.user)) + "</span>" +
        '<a class="ln-btn ln-btn-ghost sm" href="/signin?next=/welcome">Use a different account</a>' +
        '<button class="ln-btn ln-btn-ghost sm" id="ln-signout" type="button">Sign out</button></span>';
    }
    var out = document.getElementById("ln-signout");
    if (out) out.addEventListener("click", function () {
      fetch("/auth/logout", {
        method: "POST",
        headers: { "X-Requested-With": "fetch" }
      }).then(function () { location.reload(); });
    });
  }

  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(renderAuth)
    .catch(function () {});

  var adminBtn = document.getElementById("ln-dev-admin");
  if (adminBtn) adminBtn.addEventListener("click", function () {
    var email = document.getElementById("ln-dev-email"), name = document.getElementById("ln-dev-name");
    if (email) email.value = "admin@surveykart.local";
    if (name) name.value = "SurveyKart Admin";
    var f = document.getElementById("ln-devform");
    if (f && f.requestSubmit) f.requestSubmit();
  });

  var form = document.getElementById("ln-devform");
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    fetch("/auth/dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: (document.getElementById("ln-dev-email") || {}).value || "",
        name: (document.getElementById("ln-dev-name") || {}).value || "",
        mode: "register"
      })
    }).then(function (r) { return r.json(); }).then(function (out) {
      if (out.error) alert(out.error);
      else location.href = out.redirect || (out.user && out.user.status !== "approved" ? "/welcome" : "/studio/");
    });
  });
})();
