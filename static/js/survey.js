/* PROJECT BEACON - respondent instrument.
 *
 * Layers, in order of purpose:
 *   1. attention    - narrated explainer, comprehension checks, minimum dwell time on the
 *                     conjoint. These exist to stop satisficing, not to decorate.
 *   2. engagement   - progress ring, insight points, section milestones. Points reward
 *                     completion and care; nothing rewards speed.
 *   3. instrument   - the questions themselves, rendered from /api/spec.
 */
(function () {
  "use strict";

  var STUDY = window.STUDY || { slug: "beacon" };
  var IS_TEST = /(^|\/)test$/.test(location.pathname.replace(/\/$/, ""));
  var NS = (STUDY.slug === "beacon" ? "beacon" : "study_" + STUDY.slug) +
           (IS_TEST ? "_test_" : "_");

  var SPEC = null, SESSION = null, CONJOINT = null, NARR = null, SCENES = null;
  var answers = {};
  var steps = [];
  var cur = 0;
  var t0 = Date.now();
  var points = 0;
  var seenSections = {};
  // Audio is opt-in. It must never start before the respondent chooses a preference.
  var soundOn = false;
  var audioPref = "manual"; // manual | all | off
  var testNotes = {}, reviewToken = "";
  var narrator = null;
  var explainer = null;
  var dwellTimer = null;
  var dwellStart = 0;
  var pendingDwell = null;
  var MIN_DWELL = 12;
  var LANG = "";           // respondent language, from ?lang= or the on-welcome picker
  var ORIG = {};           // question ids the respondent wants in the parent (original) language

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var el = function (tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  function loadSpecLang(lang) {
    if (SESSION && lang !== (SPEC.render_language || SPEC.default_language)) {
      store('session_id'); store('answers'); store('cur');
      location.href = location.pathname + '?lang=' + encodeURIComponent(lang);
      return Promise.resolve();
    }
    LANG = lang;
    try { store("lang", lang); } catch (e) {}
    return fetch("/api/spec/" + STUDY.slug + "?lang=" + encodeURIComponent(lang) + (IS_TEST ? "&preview=1" : ""))
      .then(function (r) { return r.json(); })
      .then(function (spec) {
        SPEC = spec;
        CONJOINT = spec.conjoint;
        NARR = spec.narration;
        SCENES = spec.explainer_scenes;
        window.BEACON_CONJOINT_SCENE = spec.conjoint_scene;
        setupLangPicker();
        applyWelcomeCopy();
      });
  }

  function setupLangPicker() {
    var pick = $("#lang-pick");
    if (pick) pick.remove();
    if (!SPEC || !SPEC.languages || SPEC.languages.length < 2) return;
    var host = document.querySelector("#start-btn");
    var row = el("div", "lang-pick");
    row.id = "lang-pick";
    row.appendChild(el("span", "lang-pick-ic", "\u2726"));
    var sel = el("select", "");
    SPEC.languages.forEach(function (l) {
      var o = document.createElement("option");
      o.value = l.code;
      o.textContent = l.native || l.code;
      if (l.code === SPEC.render_language) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      var m = null;
      SPEC.languages.forEach(function (l) { if (l.code === sel.value) m = l; });
      if (m && m.child && m.code !== SPEC.default_language) {
        // each language is its own child survey with its own link and data
        var qs = location.search.replace(/^\?/, "");
        location.href = "/survey/" + m.child + (IS_TEST ? "/test" : "") + (qs ? "?" + qs : "");
      } else {
        loadSpecLang(sel.value);
      }
    });
    row.appendChild(sel);
    if (host && host.parentElement) host.parentElement.insertBefore(row, host);
  }

  function applyWelcomeCopy() {
    if (!SPEC) return;
    try { document.documentElement.dir = SPEC.render_dir || "ltr"; } catch (e) {}
    if (SPEC.welcome_title) {
      var h = document.querySelector("#welcome h1");
      if (h) h.textContent = SPEC.welcome_title;
    }
    if (SPEC.welcome_text) {
      var ps = document.querySelectorAll("#welcome p");
      if (ps.length) ps[0].textContent = SPEC.welcome_text;
    }
  }

  function readEmbedded() {
    var out = {};
    try {
      var ps = new URLSearchParams(location.search);
      Array.from(new Set((SPEC.embedded || []).concat(["rid"]))).forEach(function (n) {
        var v = ps.get(n);
        if (v !== null) out[n] = v;
      });
    } catch (e) {}
    return out;
  }

  function isNum(x) { return x !== "" && x !== null && x !== undefined && !isNaN(Number(x)); }

  function store(k, v) {
    try {
      if (v === undefined) localStorage.removeItem(NS + k);
      else localStorage.setItem(NS + k, JSON.stringify(v));
    } catch (e) {}
  }
  function recall(k) {
    try { var v = localStorage.getItem(NS + k); return v ? JSON.parse(v) : null; }
    catch (e) { return null; }
  }

  // ============================================================ narration
  function stopNarration() {
    stopSpeech();
    if (narrator) {
      try { narrator.pause(); } catch (e) {}
      narrator = null;
    }
    document.querySelectorAll(".play-btn.playing").forEach(function (b) {
      b.classList.remove("playing");
    });
    document.querySelectorAll(".g-btn.playing").forEach(function (b) {
      b.classList.remove("playing");
      b.innerHTML = '<span class="g-ico">&#9654;</span> Listen';
    });
    var w = $("#welcome-wave");
    if (w) w.hidden = true;
  }

  function playClip(key, onEnd) {
    if (!soundOn || !NARR || !NARR[key]) { if (onEnd) onEnd(); return null; }
    stopNarration();
    var a = new Audio(NARR[key].src || "/audio/" + NARR[key].file);
    a.preload = "auto";
    narrator = a;
    if (onEnd) a.addEventListener("ended", function () { narrator = null; onEnd(); });
    var p = a.play();
    // Browsers block autoplay until the user has interacted; fail quietly rather than stalling.
    if (p && p.catch) p.catch(function () { narrator = null; });
    return a;
  }

  function setSound(on) {
    soundOn = on;
    store("sound", on);
    var b = $("#sound-btn");
    if (b) {
      b.classList.toggle("off", !on);
      b.innerHTML = on ? "&#128266;" : "&#128263;";
      b.title = on ? "Narration on" : "Narration off";
    }
    if (!on) stopNarration();
  }

  // ============================================================ spoken guide
  // Every screen offers the same three choices: listen (narration or text-to-speech),
  // read at your own pace, or replay. Works on any modern browser, no server cost.
  var tts = ("speechSynthesis" in window) ? window.speechSynthesis : null;
  var lastGuide = null;

  function stopSpeech() {
    if (tts) { try { tts.cancel(); } catch (e) {} }
  }

  function speak(text, btn) {
    if (!tts) return false;
    stopNarration();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 1.03;
    u.onend = u.onerror = function () {
      if (btn) {
        btn.classList.remove("playing");
        btn.innerHTML = '<span class="g-ico">&#9654;</span> Listen';
      }
    };
    lastGuide = text;
    tts.speak(u);
    return true;
  }

  function qSpeechText(q) {
    q = Object.assign({}, q, { stem: pipeText(q.stem) });
    var t = q.id + ". " + q.stem + (q.help ? " " + q.help : "");
    if (q.options) t += " The options are: " +
      q.options.map(function (o) { return o.label; }).join("; ") + ".";
    if (q.rows && q.cols) t += (q.select === "multi" ? " For each row, tick every column that applies."
      : " For each row, choose one column.") +
      " Rows: " + q.rows.map(function (r) { return r.label; }).join("; ") +
      ". Columns: " + q.cols.map(function (c) { return c.label; }).join("; ") + ".";
    else if (q.rows && q.scale) t += " Please rate each item from " + q.scale.min + " to " + q.scale.max +
      ". Items: " + q.rows.map(function (r) { return r.label; }).join("; ") + ".";
    return t;
  }

  function taskSpeechText(step) {
    var q = step.q;
    var alts = taskAt(step.taskId);
    var t = "Choice task " + step.slot + " of " + step.total + ". Patient: " + q.vignette + ". ";
    alts.forEach(function (alt, i) {
      var said = (CONJOINT.attributes || []).map(function (a, ai) {
        var lv = altLevel(alt, a, ai);
        return lv == null ? "" : (a.levels || [])[lv];
      }).filter(function (v) { return v != null; });
      t += "Treatment " + (i + 1) + ": " + said.join("; ") + ". ";
    });
    if (CONJOINT.has_opt_out !== false) t += "Or choose: " + q.opt_out_label + ".";
    return t;
  }

  function guideBar(textFn) {
    var bar = el("div", "guide");
    var listen = el("button", "g-btn", '<span class="g-ico">&#9654;</span> Listen');
    listen.type = "button";
    var replay = el("button", "g-btn", '<span class="g-ico">&#8635;</span> Replay');
    replay.type = "button";
    var hint = el("span", "g-hint", "or read at your own pace below");

    function setPlaying(on) {
      listen.classList.toggle("playing", on);
      listen.innerHTML = on ? '<span class="g-ico">&#9632;</span> Stop'
                            : '<span class="g-ico">&#9654;</span> Listen';
    }
    listen.addEventListener("click", function () {
      if (listen.classList.contains("playing")) { stopNarration(); return; }
      if (!soundOn) setSound(true);
      if (speak(textFn(), listen)) setPlaying(true);
      else { listen.title = "Audio is not supported on this device - please read below."; }
    });
    replay.addEventListener("click", function () {
      if (!soundOn) setSound(true);
      if (speak(lastGuide || textFn(), listen)) setPlaying(true);
    });

    bar.appendChild(listen);
    bar.appendChild(replay);
    bar.appendChild(hint);
    return bar;
  }

  // ============================================================ study coach
  // A small mascot that talks to the respondent: celebrates, nudges and guides.
  // It never blocks the survey - it only comments.
  var coachTimer = null;
  var PREVIEW = !!window.BEACON_PREVIEW_MODE;   // set by the Studio: render questions, no session/boot
  function coachSay(html, tone, ms) {
    if (PREVIEW) return;
    var c = $("#coach");
    if (!c) {
      c = el("div", "coach");
      c.id = "coach";
      c.innerHTML =
        '<span class="coach-face">' +
        '<svg viewBox="0 0 44 44"><rect x="4" y="8" width="36" height="30" rx="10" fill="#0b4f6c"/>' +
        '<circle cx="16" cy="21" r="3.4" fill="#fff"/><circle cx="28" cy="21" r="3.4" fill="#fff"/>' +
        '<path d="M15 28q7 5 14 0" stroke="#7fd4f0" stroke-width="2.6" fill="none" ' +
        'stroke-linecap="round"/>' +
        '<path d="M22 8V4" stroke="#0b4f6c" stroke-width="2.6"/>' +
        '<circle cx="22" cy="3" r="2.4" fill="#ffd166"/></svg></span>' +
        '<span class="coach-msg"></span>';
      document.body.appendChild(c);
    }
    c.className = "coach show " + (tone || "info");
    c.querySelector(".coach-msg").innerHTML = html;
    if (coachTimer) clearTimeout(coachTimer);
    coachTimer = setTimeout(function () { c.classList.remove("show"); }, ms || 5200);
  }

  // ============================================================ verbatim quality
  // Live gibberish detection: keyboard mashes, character/word repetition, vowel-less
  // strings, lorem ipsum. Flags while typing so the respondent can fix it in place.
  function textQuality(t) {
    var s = String(t || "").trim().toLowerCase();
    if (s.length < 8) return null;
    if (s.indexOf("lorem ipsum") >= 0) return "placeholder text";
    var letters = s.replace(/[^a-z]/g, "");
    if (letters.length >= 8) {
      var vowels = (letters.match(/[aeiou]/g) || []).length;
      if (vowels / letters.length < 0.1) return "not readable";
    }
    var rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
    for (var i = 0; i < rows.length; i++) {
      var rr = rows[i].split("").reverse().join("");
      if (s.indexOf(rows[i]) >= 0 || s.indexOf(rr) >= 0) return "a keyboard pattern";
    }
    if (/(.)\1{5,}/.test(s)) return "repeated characters";
    var words = s.split(/\s+/);
    if (words.length >= 4) {
      var uniq = {};
      words.forEach(function (w) { uniq[w] = 1; });
      if (Object.keys(uniq).length / words.length <= 0.3) return "repeated words";
    }
    for (var c = 2; c <= 8; c++) {
      var pat = s.slice(0, c);
      var reps = Math.floor(s.length / c);
      if (reps >= 3 && s.length - reps * c < c &&
          new Array(reps + 1).join(pat) === s.slice(0, reps * c)) return "a repeated pattern";
    }
    return null;
  }

  // ============================================================ AI-written answer check
  // Written answers are the part of a study most often faked: paste a chatbot reply into
  // the box and move on. So every text box watches HOW the answer arrives (keystrokes,
  // pastes, typing speed, time away from the tab) and asks the server to score WHAT it
  // says. /api/check_text runs exactly the rules the QC engine applies after the field
  // closes, so the warning a respondent sees and the flag on their record can never
  // disagree - and a client that skipped the call would still be scored on submit.
  var textMeta = {};        // qid -> telemetry collected in the browser
  var aiState = {};         // qid -> latest server verdict (with the text it scored)
  var proofreadSeen = false;

  function escHtml(t) {
    return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function metaFor(qid) {
    if (!textMeta[qid]) {
      textMeta[qid] = { keystrokes: 0, pastes: 0, pasted_chars: 0, input_events: 0,
                        typed_ms: 0, blur_ms: 0 };
    }
    return textMeta[qid];
  }

  // "off" | "warn" | "confirm" - mirrors core.ai_detect.ai_settings() on the server
  function aiActionOf(q) {
    var g = (SPEC && SPEC.ai_check) || {};
    if (g.enabled === false || (q && q.ai_check === false)) return "off";
    var a = (q && q.ai_action) || g.action || "confirm";
    return a === "off" ? "off" : (a === "warn" ? "warn" : "confirm");
  }

  // Counts real typing in one text box. Keystrokes push the pasted-character count back
  // down, so a respondent who pastes a draft and then rewrites it by hand is not still
  // carrying that paste on their record - the answer is judged on what they actually did.
  function trackKeys(meta, box) {
    var lastKey = 0, keysSinceInput = 0, lastLen = box.value.length, pasting = false;
    box.addEventListener("keydown", function (e) {
      if (!e.key || e.key.length !== 1) return;
      var now = Date.now();
      if (lastKey && now - lastKey < 3000) meta.typed_ms += now - lastKey;
      lastKey = now;
      meta.keystrokes++;
      keysSinceInput++;
      if (meta.pasted_chars > 0) meta.pasted_chars--;
    });
    box.addEventListener("paste", function (e) {
      var cd = e.clipboardData || window.clipboardData;
      meta.pastes++;
      meta.pasted_chars += cd ? String(cd.getData("text") || "").length : 0;
      pasting = true;
    });
    box.addEventListener("input", function () {
      meta.input_events++;
      var delta = box.value.length - lastLen;
      lastLen = box.value.length;
      if (pasting) { pasting = false; keysSinceInput = 0; return; }   // already counted above
      // text that grew by a big chunk with no keystrokes behind it - drag and drop, a
      // scripted insert, autofill of a whole answer - counts as pasted. The threshold
      // leaves room for predictive text and IME composition, which add a word at a time.
      if (delta - keysSinceInput >= 25) { meta.pasted_chars += delta; meta.pastes++; }
      keysSinceInput = 0;
    });
  }

  function checkText(qid, text, meta, cb) {
    fetch("/api/check_text", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ study: STUDY.slug, qid: qid, text: text, meta: meta })
    }).then(function (r) { return r.json(); }).then(function (res) {
      res.text = text;
      aiState[qid] = res;
      var prev = (answers[qid] || {})._ai || {};
      setAns(qid, "_ai", { score: res.score, verdict: res.verdict, ack: !!prev.ack,
                           checked: Date.now() });
      if (cb) cb(res);
    }).catch(function () { if (cb) cb(null); });
  }

  function aiReasons(res) {
    var out = [];
    (res && res.signals || []).forEach(function (s) { if (s.weight > 0) out.push(s.label); });
    return out;
  }

  // Wires one textarea: telemetry, live gibberish check, live AI check, confirm action.
  function wireTextWatch(q, ta, chip, actions) {
    var meta = metaFor(q.id);
    var action = aiActionOf(q);
    var deb = null, awayAt = 0, praised = false;

    function snapshot() {
      var m = {};
      for (var k in meta) if (meta.hasOwnProperty(k)) m[k] = meta[k];
      if (awayAt) m.blur_ms += Date.now() - awayAt;
      return m;
    }

    function paint(res, txt) {
      var acked = !!((answers[q.id] || {})._ai || {}).ack;
      if (!res || !res.scored || res.verdict === "human") {
        chip.className = "oq-chip" + (res && res.scored ? " ok" : "");
        chip.innerHTML = res && res.scored ? "&#10003; Reads like your own words - thank you." : "";
        actions.innerHTML = "";
        if (res && res.scored && !praised && txt.split(/\s+/).length >= Math.max(3, q.min_words || 3)) {
          praised = true;
          coachSay("That is exactly the kind of insight this study needs. Thank you!", "good");
        }
        return;
      }
      var bad = res.verdict === "likely_ai";
      chip.className = "oq-chip " + (bad ? "ai" : "warn");
      chip.innerHTML =
        "<strong>&#9888; " + (bad ? "This looks AI-written or pasted." :
                                     "This may be AI-written or pasted.") + "</strong> " +
        '<span class="ai-score">' + res.score + "/100</span><br>" +
        '<span class="ai-why">' + escHtml(aiReasons(res).slice(0, 3).join(" \u00b7 ")) + "</span><br>" +
        (acked
          ? "Thank you - noted as your own words. Our reviewers can still see the score."
          : "This study only works with your own words. Rough, short or unfinished is worth " +
            "far more here than polished text from a chatbot - please rewrite it, or confirm " +
            "below that you wrote it yourself.");
      if (res.proofread && res.proofread.length) {
        chip.innerHTML += '<br><span class="ai-why">Proofreading: ' +
          escHtml(res.proofread.slice(0, 2).map(function (n) { return n.note; }).join("; ")) +
          "</span>";
      }
      actions.innerHTML = "";
      if (acked || action === "off") return;
      if (action === "confirm") {
        var mine = el("button", "g-btn", "&#10003; I wrote this myself");
        mine.type = "button";
        mine.addEventListener("click", function () {
          var prev = (answers[q.id] || {})._ai || {};
          setAns(q.id, "_ai", { score: res.score, verdict: res.verdict, ack: true,
                                confirmed: Date.now() });
          paint(res, ta.value.trim());
          coachSay("Thank you for confirming - that is noted on your record.", "info");
        });
        actions.appendChild(mine);
      }
      var again = el("button", "g-btn ghost", "&#9998; I will rewrite it");
      again.type = "button";
      again.addEventListener("click", function () { ta.focus(); ta.select(); });
      actions.appendChild(again);
    }

    function runCheck() {
      var txt = ta.value.trim();
      setAns(q.id, "_meta", snapshot());
      if (txt.length < 20) {
        chip.className = "oq-chip"; chip.innerHTML = ""; actions.innerHTML = "";
        return;
      }
      var bad = textQuality(txt);            // instant, offline: keyboard mashes and filler
      if (bad) {
        chip.className = "oq-chip warn";
        chip.innerHTML = "&#9888; This reads as " + bad + ". A sentence or two in your own " +
          "words makes sure your insight counts - or record it with the microphone.";
        actions.innerHTML = "";
      }
      if (action === "off") return;
      checkText(q.id, txt, snapshot(), function (res) { if (res) paint(res, txt); });
    }

    trackKeys(meta, ta);
    ta.addEventListener("keydown", function () {
      if (meta.keystrokes % 20 === 0) setAns(q.id, "_meta", snapshot());
    });
    ta.addEventListener("paste", function () {
      clearTimeout(deb);
      deb = setTimeout(runCheck, 150);       // score a paste straight away
    });
    ta.addEventListener("drop", function () { meta.pastes++; meta.input_events++; });
    ta.addEventListener("input", function () {
      setAns(q.id, "_", ta.value); hideErr();
      clearTimeout(deb);
      deb = setTimeout(runCheck, 650);
    });
    ta.addEventListener("blur", function () {
      awayAt = Date.now();
      setAns(q.id, "_meta", snapshot());
      ansChanged();                          // screening on text waits until the box is left
    });
    ta.addEventListener("focus", function () {
      if (awayAt) { meta.blur_ms += Date.now() - awayAt; awayAt = 0; }
    });

    // coming back to an answered question: show the verdict we already have, or re-score
    var init = ta.value.trim();
    if (init.length >= 20 && action !== "off") {
      var cached = aiState[q.id];
      if (cached && cached.text === init) paint(cached, init);
      else setTimeout(runCheck, 80);
    }
  }

  // ============================================================ voice verbatims
  // Optional recorded answer via MediaRecorder; uploaded to /api/voice and referenced
  // from the answers payload by filename only.
  function recorderFor(q) {
    var row = el("div", "rec-row");
    var can = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
              ("MediaRecorder" in window);
    var rec = el("button", "g-btn rec-btn", '<span class="g-ico">&#127908;</span> Record voice answer');
    rec.type = "button";
    var note = el("span", "g-hint", "optional &middot; stored on the study server");
    row.appendChild(rec);
    row.appendChild(note);
    if (!can) {
      rec.disabled = true;
      rec.title = "Recording is not supported on this device - typing works fine.";
      return row;
    }

    var mrec = null, chunks = [], recMime = "", blobUrl = null, play = null, del = null;

    function clearPlay() {
      if (play) { play.remove(); play = null; }
      if (del) { del.remove(); del = null; }
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    }

    rec.addEventListener("click", function () {
      if (mrec) { try { mrec.stop(); } catch (e) {} return; }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        recMime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : (MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "");
        mrec = recMime ? new MediaRecorder(stream, { mimeType: recMime }) : new MediaRecorder(stream);
        chunks = [];
        mrec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        mrec.onstop = function () {
          stream.getTracks().forEach(function (tr) { tr.stop(); });
          mrec = null;
          rec.classList.remove("recording");
          rec.innerHTML = '<span class="g-ico">&#127908;</span> Record voice answer';
          var blob = new Blob(chunks, { type: recMime || "audio/webm" });
          attach(blob);
        };
        mrec.start();
        rec.classList.add("recording");
        rec.innerHTML = '<span class="g-ico">&#9724;</span> Stop &amp; attach';
      }).catch(function () {
        coachSay("Microphone access was blocked - you can still type your answer below.", "warn");
      });
    });

    function attach(blob) {
      clearPlay();
      blobUrl = URL.createObjectURL(blob);
      play = el("audio");
      play.controls = true;
      play.src = blobUrl;
      play.className = "rec-play";
      row.insertBefore(play, note);
      del = el("button", "g-btn", "Delete");
      del.type = "button";
      del.addEventListener("click", function () {
        clearPlay();
        setAns(q.id, "voice", null);
        save();
      });
      row.insertBefore(del, note);

      var fr = new FileReader();
      fr.onload = function () {
        var b64 = String(fr.result).split(",")[1] || "";
        var ext = recMime.indexOf("mp4") >= 0 ? "m4a"
                : recMime.indexOf("ogg") >= 0 ? "ogg" : "webm";
        fetch("/api/voice", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: SESSION.session_id, qid: q.id, data: b64, ext: ext })
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (res.ok) {
            setAns(q.id, "voice", res.file);
            save();
            coachSay("Voice answer attached - thank you.", "good");
          }
        }).catch(function () {});
      };
      fr.readAsDataURL(blob);
    }
    return row;
  }

  // ============================================================ gamification
  var RANKS = [[0, "Observer"], [100, "Clinical Explorer"], [250, "Evidence Analyst"],
               [400, "Insight Strategist"], [600, "KOL Partner"]];
  function rankFor(p) {
    var r = RANKS[0][1];
    for (var i = 0; i < RANKS.length; i++) if (p >= RANKS[i][0]) r = RANKS[i][1];
    return r;
  }
  function toast(html) {
    var t = el("div", "toast", html);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2750);
  }

  // Authors can switch the game layer off in Studio; the plain progress bar on top stays.
  function gamifyOn() { return !!(SPEC && SPEC.gamify !== false); }

  // A quiet bull's-eye: two target rings ripple out of an answer the moment it lands,
  // so picking feels like hitting the mark - no words, no noise, just feedback.
  function bullseye(node) {
    if (!node || node.classList.contains("hit")) return;
    node.classList.add("hit");
    setTimeout(function () { node.classList.remove("hit"); }, 800);
  }

  function addPoints(n) {
    if (PREVIEW || !gamifyOn()) return;
    var before = rankFor(points);
    points += n;
    var after = rankFor(points);
    var p = $("#points");
    if (!p) return;
    p.textContent = points;
    var badge = $("#rank-badge");
    if (badge) badge.textContent = after;
    var box = p.parentElement;
    box.classList.remove("bump");
    void box.offsetWidth;
    box.classList.add("bump");
    floatPoints(n);
    if (before !== after) {
      toast("&#9733; Rank up: " + after);
      confetti(18);
    }
  }

  // "+25" rises out of the points counter, so a reward is seen as it lands.
  function floatPoints(n) {
    var box = $("#points") && $("#points").parentElement;
    if (!box || !(n > 0)) return;
    var f = el("span", "pts-float", "+" + n);
    box.appendChild(f);
    setTimeout(function () { f.remove(); }, 1400);
  }

  function setProgress(pct) {
    var ring = $("#ring-fg");
    if (ring) ring.style.strokeDashoffset = String(100 - pct);
    var lab = $("#ring-label");
    if (lab) lab.textContent = pct + "%";
    var bar = $("#progress-fill");
    if (bar) bar.style.width = pct + "%";
  }

  function confetti(n) {
    if (!gamifyOn()) return;
    var colors = ["#0b4f6c", "#12789e", "#7fd4f0", "#ffd166", "#1a7f4b"];
    n = n || 40;
    for (var i = 0; i < n; i++) {
      (function (i) {
        setTimeout(function () {
          var d = el("div", "confetti");
          d.style.left = Math.random() * 100 + "vw";
          d.style.background = colors[i % colors.length];
          d.style.animationDuration = (1.6 + Math.random() * 1.4) + "s";
          d.style.transform = "rotate(" + Math.random() * 360 + "deg)";
          document.body.appendChild(d);
          setTimeout(function () { d.remove(); }, 3200);
        }, i * 28);
      })(i);
    }
  }

  // ============================================================ voice commands
  // Speak your answers: say an option (or its number), several options joined
  // with "and", then say "next". Runs on the browser's own speech recognition
  // (Web Speech API) - free to ship, nothing to configure server-side. Voice is
  // strictly optional: tapping always works, and on browsers without the API
  // every voice control simply stays hidden.
  var voice = null, voiceOn = false, voiceBar = null;

  function voiceSupported() {
    return !PREVIEW && window.BeaconVoice && window.BeaconVoice.supported();
  }

  var voiceField = 0, voiceExplicitField = false;
  function voiceControls() {
    return Array.prototype.filter.call(document.querySelectorAll('#app input, #app textarea, #app select, #app button, #app [role="button"], #app .alt-card, #app .optout-card, #app [role="slider"]'), function (n) {
      return !n.matches(".sp-thumb") && !n.disabled && n.type !== "hidden" && !n.closest('.nav, [hidden], .recorder') &&
        getComputedStyle(n).display !== "none" && getComputedStyle(n).visibility !== "hidden";
    });
  }
  function voiceFields() {
    return voiceControls().filter(function (n) { return n.getAttribute("role") === "slider" || n.tagName === "TEXTAREA" || n.tagName === "SELECT" ||
      (n.tagName === "INPUT" && !/^(radio|checkbox|button|submit|file)$/.test(n.type)); });
  }
  function highlightActiveVoiceRow(idx) {
    var rows = document.querySelectorAll('#app .grid-row, #app .gauge-row');
    rows.forEach(function (r, i) {
      var isActive = (i === idx) && voiceOn;
      r.classList.toggle("voice-active-row", isActive);
      var mic = r.querySelector(".voice-row-mic");
      if (isActive) {
        if (!mic) {
          var rl = r.querySelector(".rlabel, .gauge-label");
          if (rl) {
            mic = el("span", "voice-row-mic", "\uD83C\uDF99\uFE0F");
            mic.title = "Listening for this row";
            rl.appendChild(mic);
          }
        }
      } else if (mic) {
        mic.remove();
      }
    });
  }

  function animateRowHit(field, val) {
    if (!field) return;
    var row = field.closest(".grid-row, .gauge-row, .num-row, .rank-item");
    if (row) {
      row.classList.remove("row-rated-pop");
      void row.offsetWidth;
      row.classList.add("row-rated-pop");
      var badge = row.querySelector(".voice-row-status");
      if (!badge) {
        var labelEl = row.querySelector(".rlabel, .gauge-label");
        if (labelEl) {
          badge = el("span", "voice-row-status");
          labelEl.appendChild(badge);
        }
      }
      if (badge) {
        badge.textContent = " \u2713 " + (val !== undefined ? val : "");
        badge.classList.remove("pop");
        void badge.offsetWidth;
        badge.classList.add("pop");
      }
    }
  }

  function advanceVoiceField(fromIdx) {
    var fields = voiceFields();
    if (fields.length <= 1) return;
    var q = steps[cur] && steps[cur].q;
    var rows = (q && q.rows) || [];
    var nextIdx = -1;
    for (var i = fromIdx + 1; i < fields.length; i++) {
      var rCode = rows[i] ? rows[i].code : null;
      if (!rCode || getAns(q.id, rCode) === undefined) { nextIdx = i; break; }
    }
    if (nextIdx === -1) {
      for (var j = 0; j < fromIdx; j++) {
        var rCode = rows[j] ? rows[j].code : null;
        if (!rCode || getAns(q.id, rCode) === undefined) { nextIdx = j; break; }
      }
    }
    if (nextIdx !== -1) {
      voiceField = nextIdx;
      voiceExplicitField = true;
      highlightActiveVoiceRow(voiceField);
      if (fields[voiceField]) fields[voiceField].focus();
      var rLabel = rows[voiceField] ? (rows[voiceField].label || ("Row " + (voiceField + 1))) : ("Field " + (voiceField + 1));
      showVoiceBar("Saved \u2713 Now on Row " + (voiceField + 1) + " — \u201C" + rLabel + "\u201D — say 1\u20135, or \u2018row " + (voiceField + 1) + " is 4\u2019.");
      coachSay("Ready for Row " + (voiceField + 1) + ": " + rLabel, "info");
    } else {
      showVoiceBar("All rows rated! Say \u201Cnext\u201D to proceed, or say a row number to change.");
      coachSay("All rows completed! Say \u201Cnext\u201D to continue.", "info");
    }
  }

  function labelVoiceControls() {
    Array.prototype.forEach.call(document.querySelectorAll('.voice-control-tag'), function (n) { n.remove(); });
    if (!voiceOn) return;
    // Numbers on-screen were confusing — keep DOM for fallback but hide visually via CSS.
    // Only highlight the active row for multi-field/ rating questions.
    voiceControls().forEach(function (n, i) {
      var badge = el("span", "voice-control-tag", String(i + 1));
      badge.setAttribute("aria-hidden", "true");
      badge.style.display = "none";
      if (n.matches("button, [role=button], [role=slider], .alt-card, .optout-card")) n.appendChild(badge);
      else n.parentNode.insertBefore(badge, n);
    });
    highlightActiveVoiceRow(voiceField);
  }
  function voiceCtx() {
    var q = steps[cur] && steps[cur].q, fields = voiceFields();
    var field = fields[Math.min(voiceField, fields.length - 1)];
    // Picks follow the displayed order, including randomized/piped choices.
    var options = Array.prototype.map.call(document.querySelectorAll('#app .opt[data-code]'), function (n) {
      return {code: n.dataset.code, label: (n.querySelector("label") || n).textContent.trim(), exclusive: (q.options || []).some(function (o) { return String(o.code) === n.dataset.code && o.exclusive; })};
    });
    var rows = (q && q.rows) ? q.rows.map(function (r, i) {
      return { index: i, code: r.code, label: (r.label || "").trim() };
    }) : [];
    return {
      options: options,
      multi: q && q.type === "multi_select",
      type: q && q.type,
      activeFieldIndex: voiceField,
      fieldsCount: fields.length,
      rows: rows,
      scale: q && (q.scale || (q.min != null && q.max != null ? { min: q.min, max: q.max } : null)),
      inputType: (!options.length || voiceExplicitField) && field ? (field.getAttribute("role") === "slider" ? "number" : field.type || "text") : null
    };
  }
  function voiceSetValue(field, value) {
    if (!field) { showVoiceBar("Tap the field, or say its name, then say the value."); return; }
    if (/^(checkbox|radio)$/.test(field.type) || field.tagName === "BUTTON" || field.getAttribute("role") === "button" || field.matches(".alt-card, .optout-card")) {
      field.click(); labelVoiceControls(); return;
    }
    if (value === undefined) { field.focus(); voiceField = voiceFields().indexOf(field); voiceExplicitField = true; showVoiceBar("Field selected. Say its value."); return; }
    if (field.getAttribute("role") === "slider") {
      var rating = window.BeaconVoice.parseNumber(value);
      if (rating === null || !Number.isInteger(rating) || rating < Number(field.getAttribute("aria-valuemin")) || rating > Number(field.getAttribute("aria-valuemax"))) {
        showVoiceBar("Say a number shown under the scale (e.g. 1\u20135). Tap the row to change it highlight."); return;
      }
      field.dispatchEvent(new CustomEvent("voice-value", {detail:rating}));
      showVoiceBar("Rated \u2713 Say the next row\u2019s number (1\u20135), or \u2018next\u2019 to continue."); return;
    }
    if (/^(number|range)$/.test(field.type)) {
      value = window.BeaconVoice.parseNumber(value);
      if (value === null || (field.min !== "" && value < Number(field.min)) || (field.max !== "" && value > Number(field.max))) {
        showVoiceBar("Number not accepted. Use the displayed minimum and maximum."); return;
      }
    }
    if (field.tagName === "SELECT") {
      var option = Array.prototype.find.call(field.options, function (o) { return o.text.toLowerCase() === String(value).toLowerCase() || o.value === String(value); });
      if (!option) { showVoiceBar("Say a listed choice for this field."); return; }
      value = option.value;
    }
    if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      // Accept unambiguous spoken English dates as well as ISO; never guess numeric day/month order.
      var spokenDate = String(value).replace(/(\d+)(st|nd|rd|th)\b/gi, "$1");
      if (/january|february|march|april|may|june|july|august|september|october|november|december/i.test(spokenDate) && /\b\d{4}\b/.test(spokenDate)) {
        var parsed = new Date(spokenDate);
        if (!isNaN(parsed.getTime())) value = parsed.getFullYear() + "-" + String(parsed.getMonth() + 1).padStart(2, "0") + "-" + String(parsed.getDate()).padStart(2, "0");
      }
    }
    var previous = field.value;
    field.value = String(value);
    if (!field.value || !field.checkValidity()) {
      field.value = previous; showVoiceBar("Value not accepted. For dates, use YYYY-MM-DD; check the field limits."); return;
    }
    field.dispatchEvent(new Event("input", {bubbles:true}));
    field.dispatchEvent(new Event("change", {bubbles:true}));
    showVoiceBar("Answer entered. Say next field, next, or another value to correct it.");
  }

  function showVoiceBar(msg) {
    if (!voiceBar) {
      voiceBar = el("div", "voice-bar",
        '<span class="vb-mic" aria-hidden="true"><i></i></span>' +
        '<span class="vb-live">Listening\u2026</span>' +
        '<span class="vb-heard" aria-live="polite"></span>' +
        '<button type="button" class="vb-stop">Stop</button>');
      voiceBar.querySelector(".vb-stop").addEventListener("click", function () {
        setVoice(false);
        coachSay("Voice answering is off - tap your answers.", "info");
      });
      document.body.appendChild(voiceBar);
    }
    var live = voiceBar.querySelector(".vb-live");
    var heard = voiceBar.querySelector(".vb-heard");
    live.textContent = msg || "Listening — say an option name or number, \u2018next\u2019 to continue, \u2018back\u2019 to go back. For scales, just say the number for the highlighted row.";
    heard.textContent = "";
    voiceBar.classList.add("listening");
    voiceBar.hidden = false;
  }

  function hideVoiceBar() {
    if (voiceBar) voiceBar.hidden = true;
  }

  function voiceTranscript(text) {
    if (!voiceBar) return;
    var heard = voiceBar.querySelector(".vb-heard");
    heard.textContent = "\u201C" + text + "\u201D";
  }

  // Turn one finished utterance into survey actions and run them in order.
  function voiceHear(text) {
    if (!text || !voiceOn) return;
    voiceTranscript(text);
    var ctx = voiceCtx();
    showVoiceBar(); voiceTranscript(text);
    var acts = window.BeaconVoice.parseCommand(text, ctx);
    var picked = 0, spoken = false;
    acts.forEach(function (a) {
      if (a.act === "stop") { setVoice(false); }
      else if (a.act === "fieldValue") {
        var fields = voiceFields();
        var fIdx = a.index != null ? a.index : voiceField;
        if (fields[fIdx]) {
          voiceSetValue(fields[fIdx], a.value);
          animateRowHit(fields[fIdx], a.value);
          if (a.autoAdvance) {
            advanceVoiceField(fIdx);
          }
        }
      }
      else if (a.act === "fieldSelect") {
        var fields = voiceFields();
        var sIdx = Math.max(0, Math.min(fields.length - 1, a.index));
        if (fields[sIdx]) {
          voiceField = sIdx;
          voiceExplicitField = true;
          highlightActiveVoiceRow(voiceField);
          fields[voiceField].focus();
          var curQ = steps[cur] && steps[cur].q;
          var curRowLabel = (curQ && curQ.rows && curQ.rows[voiceField]) ? curQ.rows[voiceField].label : ("Field " + (voiceField + 1));
          showVoiceBar("On Row " + (voiceField + 1) + " — \u201C" + curRowLabel + "\u201D — say 1\u20135.");
        }
      }
      else if (a.act === "value") {
        var fields = voiceFields();
        var targetField = fields[voiceField] || fields[0];
        if (targetField) {
          voiceSetValue(targetField, a.value);
          animateRowHit(targetField, a.value);
          var curQ = steps[cur] && steps[cur].q;
          if (curQ && (curQ.type === "rating_scale" || curQ.type === "gauge_meter" || curQ.type === "numeric_matrix")) {
            advanceVoiceField(voiceField);
          }
        }
      }
      else if (a.act === "control") {
        var ctrl = voiceControls()[a.index - 1];
        if (ctrl) {
          voiceSetValue(ctrl, a.value);
          animateRowHit(ctrl, a.value);
        }
      }
      else if (a.act === "fieldMove") {
        var fields = voiceFields();
        voiceExplicitField = true;
        voiceField = Math.max(0, Math.min(fields.length - 1, voiceField + a.direction));
        highlightActiveVoiceRow(voiceField);
        if (fields[voiceField]) fields[voiceField].focus();
        showVoiceBar("On field " + (voiceField + 1) + " — say its value, or \u2018next\u2019.");
      }
      else if (a.act === "next") {
        if (spoken) coachSay("Next question coming up\u2026", "info");
        var forward = document.querySelector("#app .nav .primary");
        if (forward) forward.click(); else next();
      } else if (a.act === "back") {
        var pv = nextVisible(cur, -1); if (pv >= 0) go(pv);
      } else if (a.act === "clear") {
        voiceClear();
        coachSay("Selections cleared.", "info");
      } else if (a.act === "pick") {
        if (ctx.type !== "single_select" && ctx.type !== "multi_select") {
          if (!spoken) {
            coachSay("This one needs a quick tap \u2014 then say \u201Cnext\u201D when you\u2019re ready.", "info");
            spoken = true;
          }
          return;
        }
        var row = document.querySelector('#app .opt[data-code="' + String(a.code).replace(/"/g, '\\"') + '"]');
        if (row) { row.click(); picked++; }
      } else if (!spoken) {
        coachSay("I heard \u201C" + escHtml(a.text) + "\u201D \u2014 say an option name or number, or \u201Cnext\u201D.", "warn");
        spoken = true;
      }
    });
    if (picked) coachSay(picked === 1 ? "Locked in." : "Locked in " + picked + " answers.", "info");
    labelVoiceControls();
  }

  function voiceClear() {
    var q = steps[cur] && steps[cur].q;
    if (!q) return;
    answers[q.id] = {};
    go(cur);
  }

  // What a respondent hears when voice answering stops by itself: the microphone is blocked or
  // missing, or the speech service cannot be reached.  Every message ends with a way forward.
  var VOICE_ERRORS = {
    "not-allowed": "Microphone access is blocked. Allow it for this site, then turn voice on again.",
    "service-not-allowed": "This browser won\u2019t use its speech service here. Tap your answers to carry on.",
    "audio-capture": "No microphone was found. Connect one, then turn voice on again.",
    "network": "Couldn\u2019t reach the browser\u2019s speech service. Tap your answers to carry on.",
    "language-not-supported": "This browser can\u2019t listen in this survey\u2019s language. Tap your answers to carry on.",
    "no-audio": "Can\u2019t hear the microphone. Check that it is allowed and not muted, then turn voice on again.",
    "no-start": "Voice answering couldn\u2019t start in this browser. Tap your answers to carry on."
  };
  function voiceFailed(code) {
    if (!voiceOn) return;                              // a late report after we already stopped
    setVoice(false);
    coachSay(VOICE_ERRORS[code] || "Voice answering stopped. Tap your answers to carry on.", "warn", 9000);
  }

  function setVoice(on) {
    if (on && !voiceSupported()) return;
    if (on && !voice) {
      voice = window.BeaconVoice.create({
        onInterim: function (t) { voiceTranscript(t); },
        onFinal: function (t) { voiceHear(t); },
        onState: function (state, code) { if (state === "error") voiceFailed(code); }
      });
    }
    if (!voice) return;
    voiceOn = on;
    var btn = $("#voice-btn");
    if (on) {
      voice.start();                                   // may report a failure straight away
      if (voiceOn) {
        showVoiceBar();
        coachSay("Voice mode on — just say an option name or number. For scales, say the number for the highlighted row, e.g. \u201Cfour\u201D or \u201Crow 2 is 5\u201D. Say \u201Cnext\u201D when ready.", "info");
      }
    } else {
      voice.stop();
      hideVoiceBar();
    }
    if (btn) { btn.classList.toggle("on", voiceOn); btn.setAttribute("aria-pressed", voiceOn ? "true" : "false"); }
    document.body.classList.toggle("voice-on", voiceOn);
    labelVoiceControls();
  }

  // ============================================================ explainer
  var explainerOnDone = null;
  function dismissExplainer() {
    var ov = $("#explainer");
    if (ov.hidden) return;
    ov.hidden = true;
    if (explainer) { try { explainer.finish(); } catch (e) {} explainer = null; }
    var fn = explainerOnDone; explainerOnDone = null;
    if (fn) fn();
  }
  // reachable from the inline onclick in index.html, so the close button works even if
  // the rest of this file never finishes booting
  window.__beaconDismiss = dismissExplainer;

  // readable static profile so the overlay body is never empty on devices where the
  // animated walkthrough cannot start
  function staticProfileFallback() {
    var m = $("#ex-mount");
    if (!m || m.firstChild) return;
    m.innerHTML =
      '<div class="ex-fallback">' +
      "<p><strong>The animated walkthrough could not start on this device, so here is the " +
      "profile in text. The &times; button closes this at any time.</strong></p>" +
      "<ul>" +
      "<li><strong>Mechanism:</strong> novel mechanism of action; details blinded for this study.</li>" +
      "<li><strong>Pivotal trial:</strong> randomised, controlled, Phase III versus current standard of care.</li>" +
      "<li><strong>Efficacy:</strong> significant improvement in progression-free survival; overall survival data immature.</li>" +
      "<li><strong>Safety:</strong> treatment-related Grade 3+ adverse events in approximately 30% of patients.</li>" +
      "<li><strong>Companion diagnostic:</strong> broad NGS panel.</li>" +
      "</ul>" +
      '<p class="ex-fallback-note">This profile is a research construct, not an approved product.</p>' +
      "</div>";
  }

  function runExplainer(scenes, onDone) {
    var ov = $("#explainer");
    $("#ex-badge").textContent = scenes.length > 1 ? "Product profile" : "How the choices work";
    ov.hidden = false;
    explainerOnDone = onDone;
    var mounted = false;
    if (window.BeaconExplainer) {
      try {
        explainer = new window.BeaconExplainer($("#ex-mount"), {
          scenes: scenes,
          narration: NARR,
          muted: !soundOn,
          tts: !!SPEC.use_tts,
          onDone: function () { explainer = null; dismissExplainer(); }
        });
        explainer.start();
        mounted = !!$("#ex-mount").firstChild;
      } catch (e) { explainer = null; }
    }
    if (!mounted) staticProfileFallback();
    // auto-escape: if the walkthrough body somehow fails to render, do not lock the user out
    setTimeout(function () {
      if (!ov.hidden && !$("#ex-mount").firstChild) dismissExplainer();
    }, 1500);
  }

  // ============================================================ steps
  function seededOrder(items) {
    // Page Randomizer: keep the opening and closing sections fixed, shuffle the
    // middle section groups deterministically for this respondent's session.
    var groups = [];
    items.forEach(function (q) {
      var g = groups[groups.length - 1];
      if (!g || g.sec !== q.section) groups.push({ sec: q.section, qs: [q] });
      else g.qs.push(q);
    });
    if (groups.length < 3) return items;
    var mid = groups.slice(1, groups.length - 1);
    var seedStr = (SESSION && SESSION.session_id) || "preview";
    var h = 2166136261;
    for (var i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = (h * 16777619) >>> 0; }
    var st = h || 1;
    function rnd() {
      st ^= st << 13; st ^= st >>> 17; st ^= st << 5; st >>>= 0;
      return st / 4294967296;
    }
    for (var j = mid.length - 1; j > 0; j--) {
      var k = Math.floor(rnd() * (j + 1));
      var t = mid[j]; mid[j] = mid[k]; mid[k] = t;
    }
    var out = groups[0].qs.slice();
    mid.forEach(function (g) { out = out.concat(g.qs); });
    return out.concat(groups[groups.length - 1].qs);
  }

  function loopItemsFor(q){
    var items=[];
    if(q.loop_mode==="previous" && q.loop_source){
      var src=null; for(var si=0; si<SPEC.questions.length; si++){ if(SPEC.questions[si].id===q.loop_source){ src=SPEC.questions[si]; break; } }
      if(src){
        if(src.options && src.options.length) items = src.options.map(function(o){ return {code:String(o.code), label:String(o.label||o.code)}; });
        else if(src.rows && src.rows.length) items = src.rows.map(function(r){ return {code:String(r.code), label:String(r.label||r.code)}; });
        else if(src.cols && src.cols.length) items = src.cols.map(function(c){ return {code:String(c.code), label:String(c.label||c.code)}; });
        else if(src.items && src.items.length) items = src.items.map(function(it){ return {code:String(it.code), label:String(it.label||it.code)}; });
      }
    } else {
      items = (q.items||[]).map(function(it){ return {code:String(it.code), label:String(it.label||it.code)}; });
    }
    if(q.limit_loops && q.loop_limit){
      var lim = Number(q.loop_limit);
      if(lim>0 && lim < items.length) items = items.slice(0, lim);
    }
    if(q.loop_randomize){
      var seed = (SESSION && SESSION.session_id) || "preview";
      if(window.BeaconQ && window.BeaconQ.order){
        var wrapped = items.map(function(it){ return {code: it.code, label: it.label, _it: it}; });
        var ordered = window.BeaconQ.order(wrapped, {id: q.id, randomize: "shuffle"}, seed);
        items = ordered.map(function(o){ return o._it; });
      } else {
        var h = 2166136261; for(var i2=0;i2<seed.length;i2++){ h ^= seed.charCodeAt(i2); h = (h*16777619)>>>0; }
        var st = h||1; function rnd(){ st ^= st<<13; st ^= st>>>17; st ^= st<<5; st>>>=0; return st/4294967296; }
        for(var j=items.length-1;j>0;j--){ var k=Math.floor(rnd()*(j+1)); var t=items[j]; items[j]=items[k]; items[k]=t; }
      }
    }
    return items;
  }
  function conceptListFor(q){
    var concepts = (q.concepts || []).slice();
    if(!concepts.length && q.concept_concepts) concepts = (q.concept_concepts||[]).slice();
    var enabled = q.concept_concepts_per_enabled;
    if(enabled===undefined) enabled = q.concepts_per_enabled;
    var per = q.concept_concepts_per;
    if(per===undefined) per = q.concepts_per;
    if(enabled && per){
      var lim = Number(per);
      // if randomize, shuffle first then slice to get random subset
      if(q.concept_randomize){
        var seed = (SESSION && SESSION.session_id) || "preview";
        if(window.BeaconQ && window.BeaconQ.order){
          var wrapped = concepts.map(function(c){ return {code: c.id||c.label, label: c.label, _c: c}; });
          var ordered = window.BeaconQ.order(wrapped, {id: q.id, randomize: "shuffle"}, seed);
          concepts = ordered.map(function(o){ return o._c; });
        } else {
          var h = 2166136261; for(var i=0;i<seed.length;i++){ h ^= seed.charCodeAt(i); h = (h*16777619)>>>0; }
          var st = h||1; function rnd(){ st ^= st<<13; st ^= st>>>17; st ^= st<<5; st>>>=0; return st/4294967296; }
          for(var j=concepts.length-1;j>0;j--){ var k=Math.floor(rnd()*(j+1)); var t=concepts[j]; concepts[j]=concepts[k]; concepts[k]=t; }
        }
        if(lim>0 && lim < concepts.length) concepts = concepts.slice(0, lim);
      } else {
        if(lim>0 && lim < concepts.length) concepts = concepts.slice(0, lim);
        // then randomize if enabled? already handled
      }
    } else if(q.concept_randomize){
      var seed2 = (SESSION && SESSION.session_id) || "preview";
      if(window.BeaconQ && window.BeaconQ.order){
        var wrapped2 = concepts.map(function(c){ return {code: c.id||c.label, label: c.label, _c: c}; });
        var ordered2 = window.BeaconQ.order(wrapped2, {id: q.id, randomize: "shuffle"}, seed2);
        concepts = ordered2.map(function(o){ return o._c; });
      } else {
        var h2 = 2166136261; for(var i2=0;i2<seed2.length;i2++){ h2 ^= seed2.charCodeAt(i2); h2 = (h2*16777619)>>>0; }
        var st2 = h2||1; function rnd2(){ st2 ^= st2<<13; st2 ^= st2>>>17; st2 ^= st2<<5; st2>>>=0; return st2/4294967296; }
        for(var j2=concepts.length-1;j2>0;j2--){ var k2=Math.floor(rnd2()*(j2+1)); var t2=concepts[j2]; concepts[j2]=concepts[k2]; concepts[k2]=t2; }
      }
    }
    return concepts;
  }
  function buildSteps() {
    steps = [];
    var list = SPEC.questions.slice();
    if (SPEC.randomize_pages) list = seededOrder(list);
    list.forEach(function (q) {
      if (q.type === "choice_task") {
        var order = (SESSION.task_order && SESSION.task_order.length)
          ? SESSION.task_order
          : taskIds();
        order.forEach(function (tid, i) {
          steps.push({ kind: "task", taskId: tid, slot: i + 1, q: q, total: order.length });
        });
      } else if (q.type === "loop") {
        var items = loopItemsFor(q);
        if (q.loop_questions && q.loop_questions.length) {
          var qs = q.loop_questions.slice();
          if (q.loop_randomize && window.BeaconQ && window.BeaconQ.order) {
            var seed2 = (SESSION && SESSION.session_id) || "preview";
            var wrapped2 = qs.map(function(x,i){ return {code: String(x.id||i), label: x.stem, _orig: x}; });
            var ordered2 = window.BeaconQ.order(wrapped2, {id: q.id+"_qs", randomize: "shuffle"}, seed2);
            qs = ordered2.map(function(o){ return o._orig; });
          } else if (q.loop_randomize) {
            var s = (SESSION && SESSION.session_id) || "preview";
            var hh = 2166136261; for(var ii=0; ii<s.length; ii++){ hh ^= s.charCodeAt(ii); hh = (hh*16777619)>>>0; }
            var st2 = hh||1; function rr(){ st2 ^= st2<<13; st2 ^= st2>>>17; st2 ^= st2<<5; st2>>>=0; return st2/4294967296; }
            for(var j2=qs.length-1;j2>0;j2--){ var k2=Math.floor(rr()*(j2+1)); var t2=qs[j2]; qs[j2]=qs[k2]; qs[k2]=t2; }
          }
          if(items.length){
            items.forEach(function(it){
              qs.forEach(function(lq){
                var synth = JSON.parse(JSON.stringify(lq));
                synth.id = q.id + "_" + it.code + "_" + (lq.id || lq.type + "_" + qs.indexOf(lq));
                synth._loop_parent = q.id;
                synth._loop_item = it.code;
                synth._loop_label = it.label;
                synth.section = q.section;
                if(synth.stem) synth.stem = synth.stem.replace(/\{label\}/g, it.label).replace(/\{item\}/g, it.label);
                if(synth.stem_html) synth.stem_html = synth.stem_html.replace(/\{label\}/g, it.label).replace(/\{item\}/g, it.label);
                if(synth.help) synth.help = synth.help.replace(/\{label\}/g, it.label);
                if(synth.help_html) synth.help_html = synth.help_html.replace(/\{label\}/g, it.label);
                if(synth.required===undefined) synth.required = true;
                steps.push({ kind: "q", q: synth });
              });
            });
          } else {
            var q2 = JSON.parse(JSON.stringify(q)); q2._loop_items = items; steps.push({ kind: "q", q: q2 });
          }
        } else {
          var q3 = JSON.parse(JSON.stringify(q)); q3._loop_items = items; steps.push({ kind: "q", q: q3 });
        }
      } else if (q.type === "concept_test") {
        var concepts = conceptListFor(q);
        var cqs = (q.concept_questions && q.concept_questions.length) ? q.concept_questions.slice() : [];
        // legacy fallback: if no new structure, treat as single question
        if(!concepts.length && !cqs.length){
          steps.push({ kind: "q", q: q });
        } else if(concepts.length && cqs.length){
          concepts.forEach(function(concept){
            var cIdx = concepts.indexOf(concept);
            cqs.forEach(function(cq){
              var qIdx = cqs.indexOf(cq);
              var synth = JSON.parse(JSON.stringify(cq));
              synth.id = q.id + "_" + concept.id + "_" + (cq.id || cq.type);
              synth._concept_parent = q.id;
              synth._concept_id = concept.id;
              synth._concept_label = concept.label;
              synth._concept_text = concept.text;
              synth._concept_text_html = concept.text_html;
              synth._concept_media = concept.media;
              synth._concept_duration = concept.duration;
              synth._concept_allow_replay = concept.allow_replay;
              synth._concept_description_html = q.concept_description_html;
              synth._concept_show_desc_first_only = q.concept_show_desc_first_only;
              synth._concept_execution = q.concept_execution;
              synth._concept_cIdx = cIdx;
              synth._concept_qIdx = qIdx;
              synth._concept_is_first_overall = (cIdx===0 && qIdx===0);
              synth._concept_is_first_for_concept = (qIdx===0);
              synth.section = q.section;
              if(synth.stem) synth.stem = synth.stem.replace(/\{concept\}/g, concept.label).replace(/\{label\}/g, concept.label).replace(/\{item\}/g, concept.label);
              if(synth.stem_html) synth.stem_html = synth.stem_html.replace(/\{concept\}/g, concept.label).replace(/\{label\}/g, concept.label);
              if(synth.required===undefined) synth.required = false;
              steps.push({ kind: "q", q: synth });
            });
          });
        } else if(concepts.length){
          concepts.forEach(function(concept){
            var synth2 = JSON.parse(JSON.stringify(q));
            synth2.id = q.id + "_" + concept.id;
            synth2._concept_parent = q.id;
            synth2._concept_id = concept.id;
            synth2._concept_label = concept.label;
            synth2._concept_text = concept.text;
            synth2._concept_text_html = concept.text_html;
            synth2._concept_media = concept.media;
            synth2._concept_duration = concept.duration;
            synth2._concept_allow_replay = concept.allow_replay;
            synth2.type = "text_block";
            synth2.body_html = "<div class='concept-media'>" + (concept.media&&concept.media.src ? "<img src='"+concept.media.src+"' style='max-width:100%'>" : "") + "</div><h3>"+concept.label+"</h3><p>"+(concept.text_html||concept.text||"")+"</p>";
            synth2.section = q.section;
            steps.push({ kind: "q", q: synth2 });
          });
        } else {
          cqs.forEach(function(cq){
            var synth3 = JSON.parse(JSON.stringify(cq));
            synth3._concept_parent = q.id;
            synth3.section = q.section;
            steps.push({ kind: "q", q: synth3 });
          });
        }
      } else {
        steps.push({ kind: "q", q: q });
      }
    });
  }

  function sectionOf(q) {
    for (var i = 0; i < SPEC.sections.length; i++) {
      if (SPEC.sections[i].id === q.section) return SPEC.sections[i];
    }
    return { title: "", blurb: null };
  }

  var SECTION_NARRATION = { B: "section_practice", E: "section_access" };
  var SECTION_POINTS = { A: 50, B: 100, C: 100, D: 150, E: 100, F: 50 };

  // ============================================================ answers
  function setAns(qid, item, val) {
    if (!answers[qid]) answers[qid] = {};
    if (val === null || val === "") delete answers[qid][item];
    else answers[qid][item] = val;
  }
  function getAns(qid, item) { return answers[qid] ? answers[qid][item] : undefined; }

  function answered(q) {
    var a = answers[q.id] || {};
    switch (q.type) {
      case "single_select": case "numeric": case "slider": case "open_text":
        return a._ !== undefined && a._ !== "";
      case "rating_grid": case "semantic_diff": case "rating_scale":
        return q.rows.every(function (r) {
          var v = a[r.code];
          if (Array.isArray(v)) return v.length > 0;   // a multi-select grid row needs one tick
          return v !== undefined && v !== "";
        });
      case "gauge_meter":
        if (q.rows && q.rows.length) {
          return q.rows.every(function (r) {
            var v = a[r.code];
            return v !== undefined && v !== "";
          });
        }
        return a._ !== undefined && a._ !== "";
      case "sum_to_100":
        return q.rows.some(function (r) { return a[r.code] !== undefined && a[r.code] !== ""; });
      case "multi_select":
        return (a.codes || []).length > 0;
      case "date":
        return !!(a && a._);
      case "numeric_matrix": {
        var nmc = q.cols || [];
        if (nmc.length) {                            // a table: every cell, unless the row is N/A
          return (q.rows || []).length > 0 && (q.rows || []).every(function (r) {
            if (a[r.code] === "NA") return true;
            return nmc.every(function (c) {
              var v = a[r.code + "_" + c.code];
              return v !== undefined && v !== "";
            });
          });
        }
        return (q.rows || []).length > 0 && (q.rows || []).every(function (r) { return a[r.code] !== undefined && a[r.code] !== ""; });
      }
      case "delta":
        return !!(a && a.before !== undefined && a.before !== "" && a.after !== undefined && a.after !== "");
      case "concept_test": case "emoji_grid":
        return (q.rows || []).every(function (r) { return a[r.code] !== undefined; });
      case "heatmap":
        if (q.heatmap) {
          var minH = q.heatmap.min_clicks != null ? Number(q.heatmap.min_clicks) : 0;
          var maxH = q.heatmap.max_clicks != null ? Number(q.heatmap.max_clicks) : 99;
          var n = (a && Array.isArray(a.clicks) ? a.clicks.length : 0);
          if (n < minH || n > maxH) return false;
          // required comments are enforced per click at entry, but ensure any required reaction that was used has a comment
          if (q.heatmap.reactions) {
            for (var ri=0; ri<q.heatmap.reactions.length; ri++) { var rx=q.heatmap.reactions[ri]; if (rx.requireComments) { var used=(a.clicks||[]).some(function(c){ return String(c.reaction)===String(rx.code); }); if (used) { var hasComment=(a.clicks||[]).some(function(c){ return String(c.reaction)===String(rx.code) && c.comment && String(c.comment).trim(); }); if (!hasComment) return false; } } }
          }
          return true;
        }
        return (q.rows || []).some(function (r) {
          return (q.cols || []).some(function (c) {
            return [1, 2, 3].indexOf(Number(a[r.code + "_" + c.code])) >= 0;
          });
        });
      case "loop": {
        var its2 = q._loop_items || loopItemsFor(q);
        return its2.length > 0 && its2.every(function (it) { return a[it.code] !== undefined && String(a[it.code]).trim() !== ""; });
      }
      case "text_block":
        return true;
      case "rank":
        return (a.order || []).length === q.rows.length;
      case "choice_task":
        return Object.keys(CONJOINT.tasks).every(function (t) { return a["T" + t] !== undefined; });
    }
    return false;
  }

  // ============================================================ renderers
  // per-respondent, stable option order (randomisation is seeded by the session id)
  function orderedList(list, q, axis) {
    if (!window.BeaconQ || !q.randomize) return list;
    var seed = (SESSION && SESSION.session_id) || "preview";
    var out = window.BeaconQ.order(list, q, seed, axis);
    // remember what the respondent actually saw, for analysis
    var a = answers[q.id] || {};
    var shown = out.map(function (x) { return x.code !== undefined ? x.code : x.v; }).join(",");
    var key = axis === "cols" ? "_order_cols" : "_order";
    if (a[key] !== shown) setAns(q.id, key, shown);
    return out;
  }

  function renderOptions(q, multi) {
    var layout = q.layout || (multi ? "grid" : "list");
    var wrap = el("div", "opts" + (layout === "grid" ? " opt-multi" : layout === "inline" ? " opt-inline" : ""));
    var otherBox = null;
    var options = orderedList(q.options, q);

    options.forEach(function (o) {
      var row = el("div", "opt" + (o.exclusive ? " opt-excl" : ""));
      row.dataset.code = String(o.code);
      var input = el("input");
      input.type = multi ? "checkbox" : "radio";
      input.name = q.id;
      input.value = o.code;
      input.id = q.id + "_" + o.code;
      row.appendChild(input);
      if (q.hide_codes !== true) row.appendChild(el("span", "code", o.code + "."));
      var lab = el("label");
      lab.htmlFor = input.id;
      if (o.label_html && window.BeaconQ) window.BeaconQ.richInto(lab, o.label_html, logicCtx(), "…");
      else lab.textContent = pipeText(o.label);
      if (o.image) { var im = el("img", "opt-img"); im.src = o.image; im.alt = ""; lab.appendChild(im); }
      row.appendChild(lab);

      row.addEventListener("click", function (ev) {
        if (ev.target.tagName !== "INPUT") input.checked = !input.checked;
        if (input.checked) bullseye(row);
        var codes = getAns(q.id, "codes") || [];
        if (multi) {
          var i = codes.map(String).indexOf(String(o.code));
          if (input.checked && i < 0) {
            if (o.exclusive) {
              codes = [];                       // "None of these" clears everything else
            } else {
              codes = codes.filter(function (c) {
                var oc = q.options.filter(function (x) { return String(x.code) === String(c); })[0];
                return !(oc && oc.exclusive);   // picking a normal option drops the exclusive one
              });
              if (q.max_select && codes.length >= q.max_select) {
                input.checked = false;
                showErr("Please select no more than " + q.max_select + ".");
                return;
              }
            }
            codes.push(o.code);
          } else if (!input.checked && i >= 0) codes.splice(i, 1);
          setAns(q.id, "codes", codes);
        } else {
          setAns(q.id, "_", o.code);
        }
        ansChanged();                          // screening: fires immediately if this answer ends it
        paint();
        if (o.other && otherBox) {
          otherBox.classList.toggle("show", input.checked);
          if (input.checked) otherBox.focus();
        }
        if (!multi || (getAns(q.id, "codes") || []).length) hideErr();
      });
      wrap.appendChild(row);

      if (o.other) {
        otherBox = el("input", "other-input");
        otherBox.type = "text";
        otherBox.placeholder = "Please specify";
        otherBox.value = getAns(q.id, "other_text") || "";
        otherBox.addEventListener("input", function () { setAns(q.id, "other_text", otherBox.value); });
        wrap.appendChild(otherBox);
      }
    });

    function paint() {
      var sel = multi ? (getAns(q.id, "codes") || []).map(String)
                      : [String(getAns(q.id, "_"))];
      Array.prototype.forEach.call(wrap.querySelectorAll(".opt"), function (row, i) {
        var on = sel.indexOf(String(options[i].code)) >= 0;
        row.classList.toggle("checked", on);
        row.querySelector("input").checked = on;
        if (options[i].other && otherBox) otherBox.classList.toggle("show", on);
      });
    }
    paint();
    return wrap;
  }

  // Spectrum scale: a draggable gradient track with detents and a value bubble.
  // Same data contract as the old 1-7 button row (one integer per item), but the
  // interaction is continuous, visual and touch friendly instead of a button strip.
  // ============================================================ grids
  // A grid is a title, two axes and a scale.  The Studio gives every row, column and scale
  // point its own label, format, image / video / audio clip, comment box and place in the
  // order - everything below simply draws what the Studio stored.
  var EMOJI_FACES = ["\uD83D\uDE1E", "\uD83D\uDE15", "\uD83D\uDE10", "\uD83D\uDE42", "\uD83D\uDE0D"];   // frowning .. smiling

  // One entry for every value of the scale, each with its own label and attachment.
  function scalePointsOf(q) {
    var sc = q.scale || {}, min = sc.min != null ? Number(sc.min) : 1;
    var max = sc.max != null ? Number(sc.max) : 5, have = {};
    (sc.points || []).forEach(function (p) { have[Number(p.v)] = p; });
    var out = [];
    for (var v = min; v <= max; v++) {
      var p = have[v] || {}, label = p.label || "";
      if (!label && q.type === "emoji_grid") {
        label = sc.faces ? (sc.faces[v - min] || "")
          : (max - min + 1 === EMOJI_FACES.length ? EMOJI_FACES[v - min] : "");
      }
      out.push({ v: v, label: label, fmt: p.fmt, media: p.media,
                 tip: (q.type === "emoji_grid" && sc.face_labels ? sc.face_labels[v - min] : "") || "" });
    }
    return out;
  }
  // Plain / bold / italic / bold+italic - the little format choice in the Studio.
  function fmtNode(text, fmt) {
    if (fmt === "b" || fmt === "bi") {
      var b = el("b");
      if (fmt === "bi") { var bi = el("i"); bi.textContent = text; b.appendChild(bi); }
      else b.textContent = text;
      return b;
    }
    if (fmt === "i") { var ii = el("i"); ii.textContent = text; return ii; }
    var sp = el("span"); sp.textContent = text; return sp;
  }
  // A row, column or scale point label, with its attachment underneath when it carries one.
  function itemLabelNode(it, cls) {
    var box = el("div", cls || "rlabel");
    var line = el("div", "rlabel-line");
    if (it.label_html && window.BeaconQ) window.BeaconQ.richInto(line, it.label_html, logicCtx(), it.label || "");
    else line.appendChild(fmtNode(pipeText(it.label), it.fmt));
    box.appendChild(line);
    var m = it.media || (it.image ? { kind: "image", src: it.image } : null);
    if (m && m.src) box.appendChild(renderMedia(m, "qmedia-sm"));
    return box;
  }
  // The exclusive N/A on one row: ticking it clears the rating, rating clears the tick.
  function naCell(q, key, label, onRate) {
    var lab = el("label", "na-cell");
    var cb = el("input"); cb.type = "checkbox";
    cb.checked = (answers[q.id] || {})[key] === "NA";
    cb.addEventListener("change", function () {
      setAns(q.id, key, cb.checked ? "NA" : "");
      if (onRate) onRate(cb.checked);
      hideErr(); ansChanged();
    });
    lab.appendChild(cb);
    lab.appendChild(el("span", null, label));
    return lab;
  }
  function commentBox(qid, key, mode, placeholder) {
    var ta = el("textarea", "cmt-box" + (mode === "require" ? " req" : ""));
    ta.rows = 2;
    ta.placeholder = placeholder || "Add a comment";
    ta.value = getAns(qid, key) || "";
    ta.addEventListener("input", function () { setAns(qid, key, ta.value); if (ta.value.trim()) hideErr(); });
    return ta;
  }
  // One comment box under a row, spanning the whole grid.
  function gridCommentRow(q, r, span) {
    var row = el("div", "grid-row grid-cmtrow");
    var ta = commentBox(q.id, "c_" + r.code, r.comment,
      "Comment on " + pipeText(r.label) + (r.comment === "require" ? " (required)" : ""));
    if (span) ta.dataset.span = String(span);
    row.appendChild(ta);
    return row;
  }
  function questionComment(q) {
    var c = q.comments || {}, box = el("div", "q-comment");
    box.appendChild(el("label", "q-comment-lbl", pipeText(c.label || "Any other comments?") +
      (c.mode === "require" ? " *" : "")));
    box.appendChild(commentBox(q.id, "_comment", c.mode, c.label || "Any other comments?"));
    return box;
  }
  // The header: the row group name on the left, one caption per column on the right.
  function gridHead(q, pts, extra) {
    var g = q.grid || {}, na = q.na || {};
    var head = el("div", "grid-row grid-head");
    head.appendChild(el("div", "rlabel grid-rowname", pipeText(g.row_label || "")));
    var cells = el("div", "grid-cells");
    if (g.col_label) cells.appendChild(el("div", "grid-colname", pipeText(g.col_label)));
    var strip = el("div", "grid-plabels");
    pts.forEach(function (p) {
      var c = el("div", "grid-plabel");
      if (p.label) c.appendChild(fmtNode(pipeText(p.label), p.fmt));
      if (p.tip) c.title = p.tip;
      if (p.media && p.media.src) c.appendChild(renderMedia(p.media, "qmedia-xs"));
      strip.appendChild(c);
    });
    if (extra) extra(strip);
    cells.appendChild(strip);
    head.appendChild(cells);
    return head;
  }

  function renderScale(min, max, val, onPick, pts) {
    var box = el("div", "spectrum");
    box.setAttribute("role", "slider");
    box.setAttribute("aria-valuemin", String(min));
    box.setAttribute("aria-valuemax", String(max));
    box.tabIndex = 0;

    function pct(v) { return max === min ? 50 : ((v - min) / (max - min)) * 100; }

    var track = el("div", "sp-track");
    var fillEl = el("div", "sp-fill");
    track.appendChild(fillEl);
    var detents = [];
    for (var v = min; v <= max; v++) {
      var d = el("span", "sp-detent");
      d.style.left = pct(v) + "%";
      track.appendChild(d);
      detents.push(d);
    }
    // one caption per scale point, sitting under the matching detent
    if (pts && pts.some(function (p) { return p.label || (p.media && p.media.src); })) {
      var labs = el("div", "sp-labels");
      pts.forEach(function (p) {
        var c = el("div", "sp-label");
        c.style.left = pct(p.v) + "%";
        if (p.label) c.appendChild(fmtNode(pipeText(p.label), p.fmt));
        if (p.media && p.media.src) c.appendChild(renderMedia(p.media, "qmedia-xs"));
        labs.appendChild(c);
      });
      box.appendChild(labs);
      box.classList.add("has-labels");
    }
    var bubble = el("div", "sp-bubble", val === undefined ? "tap or drag" : String(val));
    var thumb = el("button", "sp-thumb" + (val === undefined ? " idle" : ""));
    thumb.type = "button";
    thumb.tabIndex = -1;
    track.appendChild(thumb);
    track.appendChild(bubble);
    box.appendChild(track);

    var cur = val;
    box.addEventListener("voice-value", function (e) { place(e.detail, true); });
    function place(nv, commit) {
      cur = nv;
      thumb.style.left = pct(nv) + "%";
      bubble.style.left = pct(nv) + "%";
      bubble.textContent = String(nv);
      bubble.classList.remove("pop");
      void bubble.offsetWidth;
      bubble.classList.add("pop");
      fillEl.style.width = pct(nv) + "%";
      thumb.classList.remove("idle");
      box.setAttribute("aria-valuenow", String(nv));
      detents.forEach(function (dd, i) { dd.classList.toggle("hit", min + i <= nv); });
      if (commit) onPick(nv);
    }
    if (val !== undefined) {
      thumb.style.left = pct(val) + "%";
      bubble.style.left = pct(val) + "%";
      fillEl.style.width = pct(val) + "%";
      detents.forEach(function (dd, i) { dd.classList.toggle("hit", min + i <= val); });
      box.setAttribute("aria-valuenow", String(val));
    }

    function fromEvent(ev) {
      var r = track.getBoundingClientRect();
      var f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      return Math.round(min + f * (max - min));
    }
    track.addEventListener("pointerdown", function (ev) {
      ev.preventDefault();
      try { track.setPointerCapture(ev.pointerId); } catch (e) {}
      place(fromEvent(ev), true);
      var move = function (e2) { place(fromEvent(e2), true); };
      var up = function () {
        track.removeEventListener("pointermove", move);
        track.removeEventListener("pointerup", up);
        track.removeEventListener("pointercancel", up);
      };
      track.addEventListener("pointermove", move);
      track.addEventListener("pointerup", up);
      track.addEventListener("pointercancel", up);
    });
    box.addEventListener("keydown", function (ev) {
      var v0 = cur === undefined ? Math.round((min + max) / 2) : cur;
      if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") { ev.preventDefault(); place(Math.max(min, v0 - 1), true); }
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp") { ev.preventDefault(); place(Math.min(max, v0 + 1), true); }
    });
    return box;
  }

  function renderDate(q) {
    var a = answers[q.id] || {};
    var wrap = el("div", "field");
    var input = el("input", "");
    input.type = "date";
    if (q.min) input.min = q.min;
    if (q.max) input.max = q.max;
    input.value = a._ || "";
    input.addEventListener("change", function () { setAns(q.id, "_", input.value); hideErr(); ansChanged(); });
    wrap.appendChild(input);
    return wrap;
  }

  // A numeric matrix: one number box per row, or a whole table of them once it has columns.
  function numInput(q, key, onType) {
    var inp = el("input", "nm-input");
    inp.type = "number";
    if (q.min !== undefined) inp.min = q.min;
    if (q.max !== undefined) inp.max = q.max;
    if (q.step !== undefined) inp.step = q.step;
    var v = (answers[q.id] || {})[key];
    if (v !== undefined && v !== "" && v !== "NA") inp.value = v;
    inp.addEventListener("input", function () {
      setAns(q.id, key, inp.value);
      if (onType) onType();
      hideErr(); ansChanged();
    });
    return inp;
  }
  function renderNumMatrix(q) {
    var wrap = el("div", "nummatrix");
    var g = q.grid || {}, na = q.na || {}, naLabel = na.label || "N/A";
    var cols = orderedList(q.cols || [], q, "cols");
    var anyNa = na.rows || na.col;
    if (g.title) wrap.appendChild(el("div", "grid-title", pipeText(g.title)));
    if (!cols.length) {                                   // one number box per row, as always
      orderedList(q.rows || [], q, "rows").forEach(function (r) {
        var row = el("div", "nm-row");
        row.appendChild(itemLabelNode(r, "nm-label"));
        row.appendChild(numInput(q, r.code));
        if (anyNa) row.appendChild(naCell(q, r.code, naLabel, null));
        wrap.appendChild(row);
        if (r.comment && r.comment !== "none") {
          wrap.appendChild(commentBox(q.id, "c_" + r.code, r.comment, "Comment on " + pipeText(r.label)));
        }
      });
    } else {                                              // rows x columns
      var tbl = el("div", "nm-table");
      tbl.style.setProperty("--nm-cols", "minmax(140px,1.6fr) repeat(" + cols.length + ", minmax(110px,1fr))" + (anyNa ? " 74px" : ""));
      var head = el("div", "nm-tr nm-head");
      head.appendChild(el("div", "nm-th nm-corner", pipeText(g.row_label || "")));
      cols.forEach(function (c) { head.appendChild(itemLabelNode(c, "nm-th")); });
      if (anyNa) head.appendChild(el("div", "nm-th nm-th-na", naLabel));
      tbl.appendChild(head);
      orderedList(q.rows || [], q, "rows").forEach(function (r) {
        var row = el("div", "nm-tr");
        row.appendChild(itemLabelNode(r, "nm-th nm-rowlabel"));
        // typing into any cell of the row lifts an N/A tick on that row
        var clearNa = (function (rowEl, rowCode) {
          return function () {
            if ((answers[q.id] || {})[rowCode] !== "NA") return;
            setAns(q.id, rowCode, "");
            var nb = rowEl.querySelector(".na-cell input");
            if (nb) nb.checked = false;
          };
        })(row, r.code);
        cols.forEach(function (c) {
          var cell = el("div", "nm-td");
          cell.appendChild(numInput(q, r.code + "_" + c.code, clearNa));
          row.appendChild(cell);
        });
        if (anyNa) {
          var nc = el("div", "nm-td nm-td-na");
          // N/A stands in for the whole row: ticking it empties the cells
          nc.appendChild(naCell(q, r.code, naLabel, function (checked) {
            if (!checked) return;
            cols.forEach(function (c) { setAns(q.id, r.code + "_" + c.code, ""); });
            row.querySelectorAll(".nm-input").forEach(function (ni) { ni.value = ""; });
          }));
          row.appendChild(nc);
        }
        tbl.appendChild(row);
        if (r.comment && r.comment !== "none") {
          var crow = el("div", "nm-tr nm-cmtrow");
          crow.appendChild(commentBox(q.id, "c_" + r.code, r.comment, "Comment on " + pipeText(r.label)));
          tbl.appendChild(crow);
        }
      });
      wrap.appendChild(tbl);
    }
    if ((q.comments || {}).mode && q.comments.mode !== "none") wrap.appendChild(questionComment(q));
    return wrap;
  }

  function renderDelta(q) {
    var wrap = el("div", "delta");
    var a = answers[q.id] || {};
    var out = el("div", "delta-out");
    function paint() {
      var d = NaN;
      if (before.value !== "" && after.value !== "") d = parseFloat(after.value) - parseFloat(before.value);
      out.textContent = isFinite(d) ? (d >= 0 ? "+" : "") + d : "\u2014";
    }
    function sync() {
      setAns(q.id, "before", before.value);
      setAns(q.id, "after", after.value);
      var d = NaN;
      if (before.value !== "" && after.value !== "") d = parseFloat(after.value) - parseFloat(before.value);
      setAns(q.id, "delta", isFinite(d) ? d : "");
      paint(); hideErr(); ansChanged();
    }
    function cell(label, node, val) {
      var box = el("div", "delta-cell");
      var l = el("label", ""); l.textContent = label;
      node.value = val;
      node.addEventListener("input", sync);
      box.appendChild(l); box.appendChild(node);
      return box;
    }
    var before = el("input", ""); before.type = "number";
    var after = el("input", ""); after.type = "number";
    [before, after].forEach(function (i) {
      if (q.min !== undefined) i.min = q.min;
      if (q.max !== undefined) i.max = q.max;
    });
    wrap.appendChild(cell(q.before_label || "Before", before, a.before !== undefined ? a.before : ""));
    wrap.appendChild(cell(q.after_label || "After", after, a.after !== undefined ? a.after : ""));
    var outBox = el("div", "delta-cell");
    var ol = el("label", ""); ol.textContent = "Change";
    outBox.appendChild(ol); outBox.appendChild(out);
    wrap.appendChild(outBox);
    paint();
    return wrap;
  }

  function renderConceptTest(q) {
    var wrap = el("div", "concept-test");
    if(q.concepts && q.concepts.length || q.concept_questions && q.concept_questions.length){
      var concepts = conceptListFor(q);
      var cqs = q.concept_questions || [];
      if(!concepts.length || !cqs.length){
        wrap.appendChild(el("div","st-note","Add at least one concept and one question to preview."));
        return wrap;
      }
      var total = concepts.length * cqs.length;
      var curC = 0, curQ = 0, curIdx = 0;
      var stage = el("div");
      var nav = el("div","nav");
      var prevBtn = el("button","btn","Prev");
      var nextBtn = el("button","btn primary","Next");
      prevBtn.type = "button"; nextBtn.type = "button";
      nav.appendChild(prevBtn); nav.appendChild(nextBtn);
      wrap.appendChild(stage);
      wrap.appendChild(nav);
      function synthFor(cIdx, qIdx){
        var concept = concepts[cIdx];
        var cq = cqs[qIdx];
        var synth = JSON.parse(JSON.stringify(cq));
        synth.id = q.id + "_" + concept.id + "_" + cq.id;
        synth._concept_parent = q.id;
        synth._concept_id = concept.id;
        synth._concept_label = concept.label;
        synth._concept_text = concept.text;
        synth._concept_text_html = concept.text_html;
        synth._concept_media = concept.media;
        synth._concept_duration = concept.duration;
        synth._concept_allow_replay = concept.allow_replay;
        synth._concept_description_html = q.concept_description_html;
        synth._concept_show_desc_first_only = q.concept_show_desc_first_only;
        synth._concept_execution = q.concept_execution;
        synth._concept_cIdx = cIdx;
        synth._concept_qIdx = qIdx;
        synth._concept_is_first_overall = (cIdx===0 && qIdx===0);
        synth._concept_is_first_for_concept = (qIdx===0);
        synth.section = q.section;
        if(synth.stem) synth.stem = synth.stem.replace(/\{concept\}/g, concept.label).replace(/\{label\}/g, concept.label);
        if(synth.stem_html) synth.stem_html = synth.stem_html.replace(/\{concept\}/g, concept.label).replace(/\{label\}/g, concept.label);
        return synth;
      }
      function render(){
        stage.innerHTML = "";
        var synth = synthFor(curC, curQ);
        var card = renderQuestion(synth);
        stage.appendChild(card);
        prevBtn.disabled = curIdx===0;
        nextBtn.textContent = curIdx===total-1 ? "Done" : "Next \u00BB";
      }
      prevBtn.addEventListener("click", function(){
        if(curIdx>0){ curIdx--; curQ--; if(curQ<0){ curC--; curQ=cqs.length-1; } render(); }
      });
      nextBtn.addEventListener("click", function(){
        if(curIdx<total-1){ curIdx++; curQ++; if(curQ>=cqs.length){ curC++; curQ=0; } render(); }
        else {
          stage.innerHTML = '<div class="st-note">You have seen all '+total+' screens. In the live survey each screen is one page: Concept '+concepts.map(function(c){return c.label;}).join(", ")+' each shows Q1..Q'+cqs.length+' on separate screens with Next.</div>';
          nav.hidden = true;
        }
      });
      render();
      return wrap;
    }
    if (q.concept_html && window.BeaconQ) {
      var c = el("div", "concept-html");
      window.BeaconQ.richInto(c, q.concept_html, logicCtx(), q.concept || "\u2026");
      wrap.appendChild(c);
    } else if (q.concept) {
      var p = el("p", "concept"); p.textContent = q.concept;
      wrap.appendChild(p);
    }
    if (q.media && q.media.src) wrap.appendChild(renderMedia(q.media));
    var grid = renderGrid(q, false);
    if (grid) wrap.appendChild(grid);
    return wrap;
  }

  function renderLoop(q) {
    var wrap = el("div", "loopq");
    var a = answers[q.id] || {};
    var items = q._loop_items || q.items || loopItemsFor(q);
    if(q.loop_questions && q.loop_questions.length){
      var limTxt = q.limit_loops ? " limited to "+q.loop_limit : "";
      var randTxt = q.loop_randomize ? " \u00B7 randomized per respondent" : "";
      var srcTxt = q.loop_mode==="previous" && q.loop_source ? " from "+q.loop_source : "";
      wrap.appendChild(el("div","st-note","This loop repeats "+q.loop_questions.length+" question(s) for each of "+items.length+" item(s) ("+(items.length*q.loop_questions.length)+" steps)"+limTxt+randTxt+srcTxt+". Each item repeats this card."));
      q.loop_questions.forEach(function(lq, idx){
        var prow = el("div","loop-row");
        prow.appendChild(el("div","loop-label", (idx+1)+". ["+lq.type+"] "+(lq.stem||"").replace("{label}", items[0] ? items[0].label : "item")));
        if(lq.type==="single_select"||lq.type==="multi_select"){
          var olist = el("div","st-note"); olist.textContent = (lq.options||[]).map(function(o){return o.label;}).join(" \u00B7 "); prow.appendChild(olist);
        }
        wrap.appendChild(prow);
      });
      if(items.length){
        var ilist = el("div","st-note"); ilist.textContent = "Items: "+items.map(function(it){return it.label;}).join(", "); wrap.appendChild(ilist);
      }
      return wrap;
    }
    if(!items.length){
      wrap.appendChild(el("div","st-note","No items to loop over - configure the source in Studio."));
      return wrap;
    }
    items.forEach(function (it) {
      var row = el("div", "loop-row");
      var lbl = el("div", "loop-label");
      lbl.textContent = (q.prompt_template || "{label}").replace("{label}", it.label);
      row.appendChild(lbl);
      var inp;
      if (q.child === "numeric") {
        inp = el("input", ""); inp.type = "number";
        if (q.min !== undefined) inp.min = q.min;
        if (q.max !== undefined) inp.max = q.max;
      } else {
        inp = el("textarea", "");
        inp.rows = q.text_rows || 2;
        inp.placeholder = q.placeholder || "";
      }
      inp.value = a[it.code] !== undefined ? a[it.code] : "";
      inp.addEventListener("input", function () { setAns(q.id, it.code, inp.value); hideErr(); });
      row.appendChild(inp);
      wrap.appendChild(row);
    });
    return wrap;
  }

  function renderTextBlock(q) {
    var wrap = el("div", "textblock");
    if (q.body_html && window.BeaconQ) window.BeaconQ.richInto(wrap, q.body_html, logicCtx(), q.body || "");
    else { var p = el("p", ""); p.textContent = q.body || ""; wrap.appendChild(p); }
    return wrap;
  }

  // A choice grid: rows x columns, and every row picks one column (single select) or
  // several of them (multi select).  One value per row is stored - the column's code.
  function renderChoiceGrid(q) {
    var wrap = el("div", "grid choice-grid");
    var g = q.grid || {}, na = q.na || {}, naLabel = na.label || "N/A";
    var multi = q.select === "multi";
    var cols = orderedList(q.cols || [], q, "cols");
    var rows = orderedList(q.rows || [], q, "rows");
    wrap.style.setProperty("--cg-tmpl", "minmax(140px, 1.4fr) repeat(" + cols.length +
      ", minmax(44px, 1fr))" + (na.rows ? " minmax(64px, auto)" : ""));
    if (g.title) wrap.appendChild(el("div", "grid-title", pipeText(g.title)));

    var head = el("div", "cg-row cg-head");
    head.appendChild(el("div", "cg-corner", pipeText(g.row_label || "")));
    cols.forEach(function (c) { head.appendChild(itemLabelNode(c, "cg-col")); });
    if (na.rows) head.appendChild(el("div", "cg-col cg-col-na", ""));
    wrap.appendChild(head);

    rows.forEach(function (r) {
      var row = el("div", "cg-row");
      row.appendChild(itemLabelNode(r, "rlabel cg-rlabel"));
      var cur = (answers[q.id] || {})[r.code];
      var on = Array.isArray(cur) ? cur.map(String) : (cur === undefined || cur === "" ? [] : [String(cur)]);
      var isNa = cur === "NA";
      cols.forEach(function (c) {
        var cell = el("label", "cg-cell");
        var inp = el("input");
        inp.type = multi ? "checkbox" : "radio";
        inp.name = q.id + "_" + r.code;
        inp.checked = !isNa && on.indexOf(String(c.code)) >= 0;
        inp.addEventListener("change", function () {
          if (multi) {
            var have = getAns(q.id, r.code);
            have = Array.isArray(have) ? have.map(String) : [];
            var at = have.indexOf(String(c.code));
            if (inp.checked && at < 0) have.push(c.code);
            if (!inp.checked && at >= 0) have.splice(at, 1);
            setAns(q.id, r.code, have);
          } else {
            setAns(q.id, r.code, c.code);
          }
          var tick = row.querySelector(".cg-na input"); if (tick) tick.checked = false;
          if (inp.checked) bullseye(cell);
          hideErr(); ansChanged(); checkPattern(q, wrap);
        });
        cell.appendChild(inp);
        if (c.media && c.media.src) cell.title = pipeText(c.label);
        row.appendChild(cell);
      });
      if (na.rows) {
        var holder = el("div", "cg-cell cg-na");
        var nl = el("label", "na-cell");
        var ncb = el("input"); ncb.type = "checkbox";
        ncb.checked = isNa;
        ncb.addEventListener("change", function () {
          setAns(q.id, r.code, ncb.checked ? "NA" : "");
          Array.prototype.forEach.call(row.querySelectorAll(".cg-cell input"), function (x) {
            if (x !== ncb) x.checked = false;              // N/A clears every pick on the row
          });
          hideErr(); ansChanged();
        });
        nl.appendChild(ncb);
        nl.appendChild(el("span", null, naLabel));
        holder.appendChild(nl);
        row.appendChild(holder);
      }
      wrap.appendChild(row);
      if (r.comment && r.comment !== "none") wrap.appendChild(gridCommentRow(q, r, cols.length + 1));
    });
    if ((q.comments || {}).mode && q.comments.mode !== "none") wrap.appendChild(questionComment(q));
    return wrap;
  }

  function renderGrid(q, semantic) {
    if (q.cols && q.cols.length && !semantic) return renderChoiceGrid(q);   // rows x columns
    var wrap = el("div", "grid");
    var g = q.grid || {}, na = q.na || {}, naLabel = na.label || "N/A";
    var sc = q.scale || {}, min = sc.min != null ? Number(sc.min) : 1;
    var max = sc.max != null ? Number(sc.max) : 5;
    var pts = orderedList(scalePointsOf(q), q, "cols");
    if (g.title) wrap.appendChild(el("div", "grid-title", pipeText(g.title)));
    if (g.row_label || g.col_label || na.col || pts.some(function (p) { return p.label; })) {
      wrap.appendChild(gridHead(q, pts, na.col ? function (strip) {
        strip.appendChild(el("div", "grid-plabel grid-plabel-na", naLabel));
      } : null));
    }
    orderedList(q.rows || [], q, "rows").forEach(function (r) {
      var row = el("div", "grid-row");
      row.appendChild(itemLabelNode(r, "rlabel"));
      var cells = el("div", "grid-cells");
      if (semantic) {
        cells.style.cssText = "display:flex;align-items:center;gap:9px";
        cells.appendChild(el("span", "sem-left", String(r.left || "")));
      }
      var naTick = null;
      cells.appendChild(renderScale(min, max, getAns(q.id, r.code), function (v) {
        setAns(q.id, r.code, v);
        if (naTick) naTick.checked = false;              // a rating clears the N/A
        hideErr(); ansChanged(); checkPattern(q, wrap);
      }, pts));
      if (semantic) cells.appendChild(el("span", "sem-right", String(r.right || "")));
      if (na.rows || na.col) {
        var holder = el("div", "grid-nacell"), cell = naCell(q, r.code, naLabel, null);
        naTick = cell.querySelector("input");
        holder.appendChild(cell); cells.appendChild(holder);
      }
      row.appendChild(cells);
      wrap.appendChild(row);
      if (r.comment && r.comment !== "none") wrap.appendChild(gridCommentRow(q, r));
    });
    var allLabelled = pts.length && pts.every(function (p) { return p.label; });
    if (!allLabelled || sc.min_label || sc.max_label) {
      var ends = el("div", "scale-ends");
      ends.appendChild(el("span", null, String(sc.min_label || (pts[0] || {}).label || min)));
      ends.appendChild(el("span", null, String(sc.max_label || (pts[pts.length - 1] || {}).label || max)));
      wrap.appendChild(ends);
    }
    if ((q.comments || {}).mode && q.comments.mode !== "none") wrap.appendChild(questionComment(q));
    return wrap;
  }

  // A rating scale: rows rated on one scale, labelled at the low end, the middle and the
  // high end.  The three anchor labels sit under the scale once, below all the rows.
  function renderRatingScale(q) {
    var wrap = el("div", "grid rating-scale");
    var sc = q.scale || {}, min = sc.min != null ? Number(sc.min) : 1;
    var max = sc.max != null ? Number(sc.max) : 5;
    orderedList(q.rows || [], q, "rows").forEach(function (r, rIndex) {
      var row = el("div", "grid-row");
      row.dataset.rowIndex = String(rIndex);
      row.appendChild(itemLabelNode(r, "rlabel"));
      var cells = el("div", "grid-cells");
      cells.appendChild(renderScale(min, max, getAns(q.id, r.code), function (v) {
        setAns(q.id, r.code, v);
        hideErr(); ansChanged(); checkPattern(q, wrap);
      }, null));
      row.appendChild(cells);
      row.addEventListener("pointerdown", function () {
        voiceField = rIndex;
        voiceExplicitField = true;
        highlightActiveVoiceRow(voiceField);
      });
      wrap.appendChild(row);
    });
    var ends = el("div", "scale-ends rs-ends");
    ends.appendChild(el("span", "rs-end-low", pipeText(sc.min_label) || String(min)));
    if (sc.mid_label) ends.appendChild(el("span", "rs-end-mid", pipeText(sc.mid_label)));
    ends.appendChild(el("span", "rs-end-high", pipeText(sc.max_label) || String(max)));
    wrap.appendChild(ends);
    // Voice hint — only visible when Answer by Voice is on, makes rating effortless
    try {
      var vh = el("div", "voice-rating-hint", "🎙 Voice: say <b>" + min + "–" + max + "</b> for the highlighted row. Try “<b>four</b>”, “<b>row 2 is 4</b>” or tap a row to move it.");
      wrap.insertBefore(vh, wrap.firstChild);
    } catch(e) {}
    return wrap;
  }

  // ============================================================ Gauge Meter Question Type
  function renderGaugeComponent(min, max, step, unit, target, val, minLabel, midLabel, maxLabel, onPick) {
    var box = el("div", "gauge-box");
    box.setAttribute("role", "slider");
    box.tabIndex = 0;
    box.setAttribute("aria-valuemin", String(min));
    box.setAttribute("aria-valuemax", String(max));
    if (val !== undefined && val !== "") box.setAttribute("aria-valuenow", String(val));

    var cx = 130, cy = 130, r = 95;
    function valueToAngle(v) {
      var frac = max === min ? 0.5 : Math.max(0, Math.min(1, (v - min) / (max - min)));
      return 180 + frac * 180;
    }
    function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
      var angleInRadians = (angleInDegrees - 180) * Math.PI / 180.0;
      return {
        x: centerX + (radius * Math.cos(angleInRadians)),
        y: centerY + (radius * Math.sin(angleInRadians))
      };
    }
    function describeArc(x, y, radius, startAngle, endAngle) {
      var start = polarToCartesian(x, y, radius, endAngle);
      var end = polarToCartesian(x, y, radius, startAngle);
      var arcSweep = endAngle - startAngle <= 180 ? "0" : "1";
      return ["M", start.x, start.y, "A", radius, radius, 0, arcSweep, 0, end.x, end.y].join(" ");
    }

    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "gauge-svg");
    svg.setAttribute("viewBox", "0 0 260 155");

    // Track background
    var bgArc = document.createElementNS("http://www.w3.org/2000/svg", "path");
    bgArc.setAttribute("d", describeArc(cx, cy, r, 180, 360));
    bgArc.setAttribute("fill", "none");
    bgArc.setAttribute("stroke", "#e2e8f0");
    bgArc.setAttribute("stroke-width", "16");
    bgArc.setAttribute("stroke-linecap", "round");
    svg.appendChild(bgArc);

    // Zone 1: Low (180deg to 250deg)
    var z1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    z1.setAttribute("d", describeArc(cx, cy, r, 182, 250));
    z1.setAttribute("fill", "none");
    z1.setAttribute("stroke", "#ef4444");
    z1.setAttribute("stroke-width", "14");
    z1.setAttribute("opacity", "0.85");
    svg.appendChild(z1);

    // Zone 2: Mid (254deg to 304deg)
    var z2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    z2.setAttribute("d", describeArc(cx, cy, r, 254, 304));
    z2.setAttribute("fill", "none");
    z2.setAttribute("stroke", "#f59e0b");
    z2.setAttribute("stroke-width", "14");
    z2.setAttribute("opacity", "0.85");
    svg.appendChild(z2);

    // Zone 3: High (308deg to 358deg)
    var z3 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    z3.setAttribute("d", describeArc(cx, cy, r, 308, 358));
    z3.setAttribute("fill", "none");
    z3.setAttribute("stroke", "#10b981");
    z3.setAttribute("stroke-width", "14");
    z3.setAttribute("opacity", "0.85");
    svg.appendChild(z3);

    // Target marker
    if (target != null && target >= min && target <= max) {
      var tAngle = valueToAngle(target);
      var pt1 = polarToCartesian(cx, cy, r - 12, tAngle);
      var pt2 = polarToCartesian(cx, cy, r + 12, tAngle);
      var tLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
      tLine.setAttribute("x1", String(pt1.x)); tLine.setAttribute("y1", String(pt1.y));
      tLine.setAttribute("x2", String(pt2.x)); tLine.setAttribute("y2", String(pt2.y));
      tLine.setAttribute("stroke", "#0f2b48"); tLine.setAttribute("stroke-width", "3");
      svg.appendChild(tLine);
    }

    // Needle group
    var needleGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    needleGroup.setAttribute("class", "gauge-needle");
    var curVal = val !== undefined && val !== "" ? Number(val) : Math.round((min + max) / 2);
    needleGroup.style.transform = "rotate(" + (valueToAngle(curVal) - 90) + "deg)";

    var needle = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    needle.setAttribute("class", "gauge-needle-poly");
    needle.setAttribute("points", (cx - 4) + "," + cy + " " + (cx + 4) + "," + cy + " " + cx + "," + (cy - r + 14));
    needleGroup.appendChild(needle);

    var pivot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    pivot.setAttribute("cx", String(cx)); pivot.setAttribute("cy", String(cy));
    pivot.setAttribute("r", "10"); pivot.setAttribute("fill", "#0f2b48");
    needleGroup.appendChild(pivot);
    var pivotDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    pivotDot.setAttribute("cx", String(cx)); pivotDot.setAttribute("cy", String(cy));
    pivotDot.setAttribute("r", "3.5"); pivotDot.setAttribute("fill", "#ffffff");
    needleGroup.appendChild(pivotDot);

    svg.appendChild(needleGroup);
    box.appendChild(svg);

    // Readout & status pill
    var readout = el("div", "gauge-readout");
    var valEl = el("strong", "gauge-val", val !== undefined && val !== "" ? String(val) : "\u2013");
    var unitEl = el("span", "gauge-unit", unit || "");
    readout.appendChild(valEl); readout.appendChild(unitEl);
    box.appendChild(readout);

    function getZone(v) {
      var frac = max === min ? 0.5 : (v - min) / (max - min);
      if (frac < 0.4) return { cls: "low", text: minLabel || "Low" };
      if (frac < 0.7) return { cls: "mid", text: midLabel || "Moderate" };
      return { cls: "high", text: maxLabel || "High" };
    }
    var zInfo = getZone(curVal);
    var pill = el("div", "gauge-zone-pill " + zInfo.cls, zInfo.text);
    box.appendChild(pill);

    var ends = el("div", "gauge-ends");
    ends.appendChild(el("span", "g-min", (minLabel || String(min))));
    ends.appendChild(el("span", "g-mid", (midLabel || String(Math.round((min + max) / 2)))));
    ends.appendChild(el("span", "g-max", (maxLabel || String(max))));
    box.appendChild(ends);

    function place(nv, commit) {
      nv = Math.max(min, Math.min(max, Math.round(nv / step) * step));
      curVal = nv;
      needleGroup.style.transform = "rotate(" + (valueToAngle(nv) - 90) + "deg)";
      valEl.textContent = String(nv);
      box.setAttribute("aria-valuenow", String(nv));
      var zi = getZone(nv);
      pill.className = "gauge-zone-pill " + zi.cls;
      pill.textContent = zi.text;
      if (commit) onPick(nv);
    }

    box.addEventListener("voice-value", function (e) { place(e.detail, true); });

    function fromPointerEvent(ev) {
      var rect = svg.getBoundingClientRect();
      var svgX = ev.clientX - rect.left;
      var svgY = ev.clientY - rect.top;
      var scaleX = 260 / (rect.width || 260);
      var scaleY = 155 / (rect.height || 155);
      var px = svgX * scaleX;
      var py = svgY * scaleY;
      var dx = px - cx;
      var dy = cy - py;
      var rad = Math.atan2(dy, dx);
      var deg = rad * 180 / Math.PI;
      if (deg < 0) { deg = dx >= 0 ? 0 : 180; }
      var frac = 1 - (deg / 180);
      return min + frac * (max - min);
    }

    svg.addEventListener("pointerdown", function (ev) {
      ev.preventDefault();
      try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
      place(fromPointerEvent(ev), true);
      var move = function (e2) { place(fromPointerEvent(e2), true); };
      var up = function () {
        svg.removeEventListener("pointermove", move);
        svg.removeEventListener("pointerup", up);
        svg.removeEventListener("pointercancel", up);
      };
      svg.addEventListener("pointermove", move);
      svg.addEventListener("pointerup", up);
      svg.addEventListener("pointercancel", up);
    });

    box.addEventListener("keydown", function (ev) {
      var v0 = curVal === undefined ? Math.round((min + max) / 2) : curVal;
      if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") { ev.preventDefault(); place(Math.max(min, v0 - step), true); }
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp") { ev.preventDefault(); place(Math.min(max, v0 + step), true); }
    });

    return box;
  }

  function renderGaugeMeter(q) {
    var min = q.min != null ? Number(q.min) : 0;
    var max = q.max != null ? Number(q.max) : 100;
    var step = q.step != null ? Number(q.step) : 1;
    var unit = q.unit != null ? String(q.unit) : "%";
    var target = q.target != null ? Number(q.target) : null;
    var minLabel = pipeText(q.min_label || (q.scale && q.scale.min_label) || "Low");
    var midLabel = pipeText(q.mid_label || (q.scale && q.scale.mid_label) || "Moderate");
    var maxLabel = pipeText(q.max_label || (q.scale && q.scale.max_label) || "High");

    if (q.rows && q.rows.length) {
      var wrap = el("div", "grid gauge-grid");
      orderedList(q.rows || [], q, "rows").forEach(function (r, rIndex) {
        var row = el("div", "grid-row gauge-row");
        row.dataset.rowIndex = String(rIndex);
        row.appendChild(itemLabelNode(r, "rlabel"));
        var cells = el("div", "grid-cells");
        cells.appendChild(renderGaugeComponent(min, max, step, unit, target, getAns(q.id, r.code), minLabel, midLabel, maxLabel, function (v) {
          setAns(q.id, r.code, v);
          hideErr(); ansChanged();
        }));
        row.appendChild(cells);
        row.addEventListener("pointerdown", function () {
          voiceField = rIndex;
          voiceExplicitField = true;
          highlightActiveVoiceRow(voiceField);
        });
        wrap.appendChild(row);
      });
      try {
        var vh2 = el("div", "voice-rating-hint", "🎙 Voice: say a number for the highlighted gauge, e.g. “<b>" + min + "–" + max + "</b>”, or “<b>row 2 is 75</b>”.");
        wrap.insertBefore(vh2, wrap.firstChild);
      } catch(e2) {}
      return wrap;
    }

    var singleWrap = el("div", "single-gauge-wrap");
    singleWrap.appendChild(renderGaugeComponent(min, max, step, unit, target, getAns(q.id, "_"), minLabel, midLabel, maxLabel, function (v) {
      setAns(q.id, "_", v);
      hideErr(); ansChanged();
    }));
    return singleWrap;
  }

  // An emoji grid: the same shape as a rating grid, but each scale point is a face to tap.

  function renderEmojiGrid(q) {
    var wrap = el("div", "grid emoji-grid");
    var g = q.grid || {}, na = q.na || {}, naLabel = na.label || "N/A";
    var pts = orderedList(scalePointsOf(q), q, "cols");
    if (g.title) wrap.appendChild(el("div", "grid-title", pipeText(g.title)));
    if (g.row_label || g.col_label || na.col) {
      wrap.appendChild(gridHead(q, pts, na.col ? function (strip) {
        strip.appendChild(el("div", "grid-plabel grid-plabel-na", naLabel));
      } : null));
    }
    orderedList(q.rows || [], q, "rows").forEach(function (r) {
      var row = el("div", "grid-row");
      row.appendChild(itemLabelNode(r, "rlabel"));
      var cells = el("div", "grid-cells emoji-cells");
      var faces = [];
      pts.forEach(function (p) {
        var b = el("button", "emoji-btn");
        b.type = "button";
        b.appendChild(el("span", "emoji-face", pipeText(p.label || String(p.v))));
        if (p.media && p.media.src) b.appendChild(renderMedia(p.media, "qmedia-xs"));
        if (p.tip) b.title = p.tip;
        b.classList.toggle("on", String(getAns(q.id, r.code)) === String(p.v));
        b.addEventListener("click", function () {
          setAns(q.id, r.code, p.v);
          faces.forEach(function (x) { x.classList.remove("on"); });
          b.classList.add("on");
          var tick = row.querySelector(".na-cell input"); if (tick) tick.checked = false;
          hideErr(); ansChanged();
        });
        faces.push(b);
        cells.appendChild(b);
      });
      if (na.rows || na.col) {
        var holder = el("div", "grid-nacell");
        holder.appendChild(naCell(q, r.code, naLabel, null));
        cells.appendChild(holder);
      }
      row.appendChild(cells);
      wrap.appendChild(row);
      if (r.comment && r.comment !== "none") wrap.appendChild(gridCommentRow(q, r));
    });
    if ((q.comments || {}).mode && q.comments.mode !== "none") wrap.appendChild(questionComment(q));
    return wrap;
  }

  // A heat map: rows x columns, tap a cell to raise how strongly it applies (0 - 3).

  function renderHeatmap(q) {
    // New image-click heatmap (Title/Reference + Description + Image + Reactions + Min/Max)
    var hm = q.heatmap || null;
    if (hm) {
      var wrap = el("div", "heatmap heatmap-img");
      if (hm.title) wrap.appendChild(el("div", "hm-title", pipeText(hm.title)));
      if (hm.description_html) { var desc = el("div", "hm-desc"); desc.innerHTML = hm.description_html; wrap.appendChild(desc); }
      if (hm.image_title) wrap.appendChild(el("div", "hm-image-title", pipeText(hm.image_title)));
      if (hm.instructions) wrap.appendChild(el("div", "hm-instructions", pipeText(hm.instructions)));
      var reactions = hm.reactions || [];
      var minC = hm.min_clicks != null ? Number(hm.min_clicks) : 0;
      var maxC = hm.max_clicks != null ? Number(hm.max_clicks) : 99;
      var ans = answers[q.id] || {};
      if (!Array.isArray(ans.clicks)) ans.clicks = [];
      var selected = reactions.length ? reactions[0].code : null;
      if (ans._selected && reactions.some(function(r){ return String(r.code)===String(ans._selected); })) selected = ans._selected;
      function saveAns(){ answers[q.id]=ans; if (!PREVIEW && SESSION && SESSION.session_id){ store("answers", answers); save(); } hideErr(); ansChanged(); }
      var picker = el("div", "hm-reactions-picker");
      var pickerLabel = el("div", "hm-picker-label", "Select a reaction then click the image:");
      picker.appendChild(pickerLabel);
      var pillRow = el("div", "hm-pills");
      reactions.forEach(function(r){
        var btn = el("button", "hm-pill" + (String(r.code)===String(selected) ? " on" : ""));
        btn.type="button";
        btn.textContent = r.label || r.code;
        btn.title = (r.onlyOnce ? "Only once. " : "") + (r.allowComments ? "Comment allowed." : "") + (r.requireComments ? "Comment required." : "");
        btn.addEventListener("click", function(){ selected = r.code; ans._selected = selected; Array.prototype.forEach.call(pillRow.querySelectorAll(".hm-pill"), function(b){ b.classList.remove("on"); }); btn.classList.add("on"); saveAns(); });
        pillRow.appendChild(btn);
      });
      picker.appendChild(pillRow);
      wrap.appendChild(picker);
      if (!hm.image_src) {
        wrap.appendChild(el("div", "hm-legend", "No image has been uploaded for this heatmap yet. Please contact the survey owner."));
        if ((q.comments || {}).mode && q.comments.mode !== "none") wrap.appendChild(questionComment(q));
        return wrap;
      }
      var canvas = el("div", "hm-canvas");
      var img = el("img", "hm-image"); img.src = hm.image_src; img.alt = hm.image_title || "Heatmap image"; img.draggable=false;
      img.addEventListener("error", function(){ canvas.classList.add("hm-error"); showErr("Image failed to load - check the uploaded file."); });
      img.addEventListener("load", function(){ hideErr(); canvas.classList.remove("hm-error"); });
      canvas.appendChild(img);
      var overlay = el("div", "hm-overlay");
      canvas.appendChild(overlay);
      function renderMarkers(){
        overlay.innerHTML="";
        (ans.clicks||[]).forEach(function(cl, idx){
          var dot = el("button", "hm-dot");
          dot.type="button";
          dot.style.left = (cl.x*100) + "%"; dot.style.top = (cl.y*100) + "%";
          var rx = reactions.filter(function(r){ return String(r.code)===String(cl.reaction); })[0];
          dot.textContent = rx ? (rx.label||rx.code).slice(0,2) : "?";
          dot.title = (rx? rx.label : cl.reaction) + " at " + Math.round(cl.x*100) + "%, " + Math.round(cl.y*100) + "% - click to remove";
          dot.addEventListener("click", function(ev){ ev.stopPropagation(); ans.clicks.splice(idx,1); renderMarkers(); saveAns(); updateCounter(); });
          overlay.appendChild(dot);
        });
      }
      var counter = el("div", "hm-counter");
      function updateCounter(){
        var n = (ans.clicks||[]).length;
        counter.textContent = n + " of " + maxC + " clicks" + (minC ? " (min " + minC + ")" : "");
        counter.className = "hm-counter" + (n < minC ? " warn" : n > maxC ? " bad" : " ok");
      }
      canvas.addEventListener("click", function(ev){
        if (!selected) { showErr("Pick a reaction first, then click the image."); return; }
        var r = reactions.filter(function(x){ return String(x.code)===String(selected); })[0];
        if (r && r.onlyOnce && (ans.clicks||[]).some(function(c){ return String(c.reaction)===String(selected); })) { showErr("This reaction can only be used once - pick another or remove the existing mark."); return; }
        if ((ans.clicks||[]).length >= maxC) { showErr("You have reached the maximum of " + maxC + " clicks. Remove one to add another."); return; }
        var rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.width < 5 || rect.height < 5) { showErr("Image is still loading - please wait a moment and try again."); return; }
        var x = (ev.clientX - rect.left)/rect.width;
        var y = (ev.clientY - rect.top)/rect.height;
        x = Math.max(0, Math.min(0.98, x)); y = Math.max(0, Math.min(0.98, y));
        var entry = { x: Math.round(x*1000)/1000, y: Math.round(y*1000)/1000, reaction: selected };
        if (r && (r.allowComments || r.requireComments)) {
          var txt = window.prompt(r.requireComments ? "Add a comment for this reaction (required):" : "Add a comment (optional) - leave blank to skip:");
          if (r.requireComments && (!txt || !txt.trim())) { showErr("A comment is required for this reaction."); return; }
          if (txt) entry.comment = txt;
        }
        ans.clicks.push(entry); renderMarkers(); updateCounter(); saveAns(); hideErr();
      });
      wrap.appendChild(canvas);
      wrap.appendChild(counter);
      renderMarkers(); updateCounter();
      wrap.appendChild(el("div", "hm-legend", "Click the image to place your selected reaction. Need " + minC + " to " + maxC + " marks. Click a mark to remove it." + (reactions.some(function(r){return r.onlyOnce;}) ? " Some reactions can only be used once." : "")));
      if ((q.comments || {}).mode && q.comments.mode !== "none") wrap.appendChild(questionComment(q));
      return wrap;
    }
    // Legacy grid heatmap (rows x cols intensity 1-3)
    var wrap2 = el("div", "heatmap");
    var g = q.grid || {};
    var cols = orderedList(q.cols || [], q, "cols");
    if (g.title) wrap2.appendChild(el("div", "grid-title", pipeText(g.title)));
    if (!(q.rows || []).length || !cols.length) {
      wrap2.appendChild(el("p", "hm-legend", "This heatmap needs at least one row and one column. Please contact the survey owner."));
      return wrap2;
    }
    var scroll = el("div", "hm-scroll");
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Heatmap \u2014 scroll horizontally to reach all columns");
    var tbl = el("div", "hm-table");
    tbl.style.minWidth = (140 + cols.length * 90) + "px";
    tbl.style.setProperty("--hm-cols", "minmax(120px,1.5fr) repeat(" + cols.length + ", minmax(74px,1fr))");
    var head = el("div", "hm-tr hm-head");
    head.appendChild(el("div", "hm-th hm-corner", pipeText(g.row_label || "")));
    cols.forEach(function (c) { head.appendChild(itemLabelNode(c, "hm-th")); });
    tbl.appendChild(head);
    orderedList(q.rows || [], q, "rows").forEach(function (r) {
      var row = el("div", "hm-tr");
      row.appendChild(itemLabelNode(r, "hm-th hm-rowlabel"));
      cols.forEach(function (c) {
        var key = r.code + "_" + c.code;
        var lvl = Number((answers[q.id] || {})[key]);
        if ([1, 2, 3].indexOf(lvl) < 0) lvl = 0;
        var cell = el("button", "hm-cell");
        cell.type = "button";
        var rowName = itemLabelNode(r, "").textContent;
        var colName = itemLabelNode(c, "").textContent;
        var mark = el("span", "hm-mark");
        cell.appendChild(mark);
        function paint(value) {
          cell.dataset.lvl = String(value);
          mark.textContent = value ? String(value) : "\u2014";
          cell.title = rowName + " \u00D7 " + colName + ": " + ["Not selected", "1 \u2014 Weak", "2 \u2014 Moderate", "3 \u2014 Strong"][value];
          cell.setAttribute("aria-label", cell.title + ". Activate to cycle; keys 1\u20133 to set, Delete to clear.");
          cell.setAttribute("aria-pressed", value ? "true" : "false");
        }
        function select(value) {
          paint(value);
          if (!answers[q.id]) answers[q.id] = {};
          answers[q.id][key] = value || "";
          hideErr(); ansChanged();
          if (!PREVIEW && SESSION && SESSION.session_id) {
            store("answers", answers);
            save();
          }
        }
        paint(lvl);
        cell.addEventListener("click", function () {
          select((Number(cell.dataset.lvl || 0) + 1) % 4);
        });
        cell.addEventListener("keydown", function (event) {
          if (/^[1-3]$/.test(event.key)) { event.preventDefault(); select(Number(event.key)); }
          else if (["0", "Delete", "Backspace"].indexOf(event.key) >= 0) { event.preventDefault(); select(0); }
        });
        row.appendChild(cell);
      });
      tbl.appendChild(row);
      if (r.comment && r.comment !== "none") {
        var crow = el("div", "hm-tr hm-cmtrow");
        crow.appendChild(commentBox(q.id, "c_" + r.code, r.comment, "Comment on " + pipeText(r.label)));
        tbl.appendChild(crow);
      }
    });
    scroll.appendChild(tbl);
    wrap2.appendChild(scroll);
    wrap2.appendChild(el("div", "hm-legend",
      "Tap a cell to cycle: 1 Weak \u2192 2 Moderate \u2192 3 Strong \u2192 clear. Keyboard: 1\u20133 to set, Delete to clear. Scroll sideways for more columns. Unselected cells are not zero ratings."));
    if ((q.comments || {}).mode && q.comments.mode !== "none") wrap2.appendChild(questionComment(q));
    return wrap2;
  }


  // A numeric matrix: one number box per row, or a whole table of them once it has columns.

  // Gentle, in-the-moment nudge when every row carries the same rating.
  // Never blocks, never penalises - it just asks for a second look.
  function checkPattern(q, wrap) {
    var a = answers[q.id] || {};
    var vals = q.rows.map(function (r) { return a[r.code]; })
                     .filter(function (v) { return v !== undefined; });
    if (vals.length < q.rows.length || vals.length < 5) return;
    var uniq = {};
    vals.forEach(function (v) { uniq[v] = 1; });
    if (Object.keys(uniq).length === 1 && !wrap.dataset.nudged) {
      wrap.dataset.nudged = "1";
      wrap.classList.remove("ripple");
      void wrap.offsetWidth;
      wrap.classList.add("ripple");
      coachSay("Every row currently carries the same rating. If that is your true view, " +
        "perfect - otherwise a quick second look keeps your input accurate.", "warn");
    }
  }

  function renderSum100(q) {
    var wrap = el("div", "grid");
    var total = el("div", "s100-total");
    var totalVal = el("strong", null, "0");
    var inputs = [];
    var isPoints = q.help && q.help.indexOf("points") >= 0;

    function recompute() {
      var s = 0;
      inputs.forEach(function (i) { s += parseInt(i.value, 10) || 0; });
      totalVal.textContent = s + (isPoints ? " pts" : "%");
      total.className = "s100-total " + (s === 100 ? "ok" : "bad");
      if (s === 100) hideErr();
      return s;
    }

    orderedList(q.rows, q).forEach(function (r) {
      var row = el("div", "s100-row");
      row.appendChild(itemLabelNode(r, "rlabel"));
      var inp = el("input");
      inp.type = "number"; inp.min = 0; inp.max = 100; inp.step = 1;
      var v = getAns(q.id, r.code);
      inp.value = (v === undefined) ? "" : v;
      inp.addEventListener("input", function () {
        setAns(q.id, r.code, inp.value === "" ? "" : parseInt(inp.value, 10));
        ansChanged();
        recompute();
      });
      inputs.push(inp);
      row.appendChild(inp);
      wrap.appendChild(row);
    });
    total.appendChild(el("span", null, "Total (must equal 100)"));
    total.appendChild(totalVal);
    wrap.appendChild(total);
    recompute();
    return wrap;
  }

  function renderRank(q) {
    var order = getAns(q.id, "order") || orderedList(q.rows, q).map(function (r) { return r.code; });
    var wrap = el("div", "rank-list");
    var top = q.rank_count || 3;

    function paint() {
      wrap.innerHTML = "";
      order.forEach(function (code, i) {
        var r = q.rows.filter(function (x) { return x.code === code; })[0];
        var item = el("div", "rank-item" + (i < top ? " top" : ""));
        item.appendChild(el("span", "pos", String(i + 1)));
        item.appendChild(itemLabelNode(r, "rank-label"));
        var ar = el("div", "arrows");
        var up = el("button", null, "&#9650;"), dn = el("button", null, "&#9660;");
        up.type = dn.type = "button";
        up.disabled = i === 0; dn.disabled = i === order.length - 1;
        up.addEventListener("click", function () { move(i, -1); });
        dn.addEventListener("click", function () { move(i, 1); });
        ar.appendChild(up); ar.appendChild(dn);
        item.appendChild(ar);
        wrap.appendChild(item);
      });
      setAns(q.id, "order", order.slice());
      ansChanged();
      hideErr();
    }
    function move(i, d) {
      var j = i + d;
      if (j < 0 || j >= order.length) return;
      var t = order[i]; order[i] = order[j]; order[j] = t;
      paint();
    }
    paint();
    return wrap;
  }

  // ---- conjoint as cards, with a minimum dwell gate ----
  var ATTR_ICON = { OS: "\u23F3", PFS12: "\uD83D\uDCC8", AE: "\u26A0\uFE0F", ROUTE: "\uD83D\uDC89",
                    CDX: "\uD83E\uDDEC", COST: "\uD83D\uDCB2", ACCESS: "\uD83C\uDFE5" };
  // The design may carry its own labels (an author-defined attribute); fall back to the
  // wording the seeded BEACON instrument uses, then to the raw id.
  var ATTR_LABEL = { OS: "Median OS vs standard of care", PFS12: "12-month PFS",
                     AE: "Grade 3+ adverse events", ROUTE: "Administration",
                     CDX: "Companion diagnostic", COST: "Net 12-month cost",
                     ACCESS: "Payer access at month 1" };
  function attrLabel(attr) {
    var id = typeof attr === "string" ? attr : (attr && attr.id);
    var own = typeof attr === "object" && attr && String(attr.label || "").trim();
    if (own && own !== id) return own;
    return ATTR_LABEL[id] || id;
  }
  // A generated design stores tasks as a list; the seeded one keys them by task number.
  function taskAt(tid) {
    if (!CONJOINT || !CONJOINT.tasks) return [];
    var t = CONJOINT.tasks;
    if (Array.isArray(t)) return t[Number(tid)] || [];
    return t[String(tid)] || [];
  }
  function taskIds() {
    var t = (CONJOINT && CONJOINT.tasks) || [];
    return Array.isArray(t) ? t.map(function (_, i) { return i; }) : Object.keys(t).map(Number);
  }
  // The level an alternative shows for one attribute. Designs store levels positionally
  // (aligned to CONJOINT.attributes, null when a group-inclusion attribute is hidden in this
  // task) or keyed by attribute id; both are read here so a design always renders.
  function altLevel(alt, attr, ai) {
    var lv = (alt && alt.levels) || alt || [];
    if (!Array.isArray(lv) && typeof lv === "object") return lv[attr.id];
    return lv[ai];
  }
  // kept in step with profile_levels() in core/conjoint.py

  function renderConjoint(step) {
    var q = step.q;
    var tid = step.taskId;
    var alts = taskAt(tid);
    var positions = (SESSION.alt_positions && SESSION.alt_positions[String(tid)]) ||
                    [1, 2, 3];
    var chosen = getAns(q.id, "T" + tid);

    var wrap = el("div");
    wrap.appendChild(el("div", "task-count", "Choice task " + step.slot + " of " + step.total));
    wrap.appendChild(el("div", "vignette", "<strong>Patient:</strong> " + q.vignette));
    wrap.appendChild(guideBar(function () { return taskSpeechText(step); }));

    var cards = el("div", "alt-cards");
    positions.forEach(function (altId) {
      var alt = alts[altId - 1];
      var card = el("div", "alt-card" + (String(chosen) === String(altId) ? " sel" : ""));
      var head = el("div", "alt-head");
      head.appendChild(el("span", "alt-tick", "&#10003;"));
      head.appendChild(el("span", null, "Treatment " + altId));
      card.appendChild(head);

      var rows = el("div", "alt-rows");
      CONJOINT.attributes.forEach(function (attr, ai) {
        // a group-inclusion attribute is absent from some tasks - the design stores null for it
        var lv = altLevel(alt, attr, ai);
        if (lv === null || lv === undefined) return;
        var r = el("div", "alt-row");
        r.appendChild(el("span", "ico", ATTR_ICON[attr.id] || "\u2022"));
        var t = el("span", "txt");
        t.appendChild(el("span", "lbl", attrLabel(attr)));
        var val = (attr.levels || [])[lv];
        var pic = (attr.images || [])[lv];
        if (pic) {
          var im = el("img", "alt-level-img");
          im.src = pic; im.alt = "";
          r.appendChild(im);
        }
        t.appendChild(document.createTextNode(val == null ? "" : String(val)));
        r.appendChild(t);
        rows.appendChild(r);
      });
      card.appendChild(rows);

      card.addEventListener("click", function () {
        setAns(q.id, "T" + tid, altId);
        cards.querySelectorAll(".alt-card").forEach(function (c) { c.classList.remove("sel"); });
        card.classList.add("sel");
        if (optout) optout.classList.remove("sel");   // there is no opt-out card when Allow "none" is off
        hideErr();
      });
      cards.appendChild(card);
    });
    wrap.appendChild(cards);

    // "None of these" is only offered when the experiment allows it (Allow "none" in Studio)
    if (CONJOINT.has_opt_out !== false) {
      var optout = el("div", "optout-card" + (String(chosen) === "0" ? " sel" : ""));
      optout.appendChild(el("span", "alt-tick", "&#10003;"));
      optout.appendChild(el("span", null, String(q.opt_out_label || CONJOINT.none_label || "None of these")));
      optout.addEventListener("click", function () {
        setAns(q.id, "T" + tid, 0);
        optout.classList.add("sel");
        cards.querySelectorAll(".alt-card").forEach(function (c) { c.classList.remove("sel"); });
        hideErr();
      });
      wrap.appendChild(optout);
    }

    // dwell gate: the respondent must actually look at the profiles. Started by render()
    // after the nav exists, otherwise there is a brief window where Next is still clickable.
    var dwell = el("div", "dwell");
    dwell.innerHTML =
      '<svg class="dwell-ring" viewBox="0 0 22 22">' +
      '<circle class="bg" cx="11" cy="11" r="9"/>' +
      '<circle class="fg" cx="11" cy="11" r="9"/></svg>' +
      '<span class="dwell-txt"></span>';
    wrap.appendChild(dwell);
    pendingDwell = dwell;

    return wrap;
  }

  function startDwell(node) {
    var fg = node.querySelector(".fg");
    var txt = node.querySelector(".dwell-txt");
    dwellStart = Date.now();
    if (dwellTimer) clearInterval(dwellTimer);

    // returns true while the gate is still closed
    function frame() {
      var spent = (Date.now() - dwellStart) / 1000;
      var left = Math.max(0, MIN_DWELL - spent);
      var pct = Math.min(1, spent / MIN_DWELL);
      fg.style.strokeDashoffset = String(56.5 * (1 - pct));
      if (left > 0) {
        txt.textContent = "Take a moment to weigh the options \u2014 " +
          Math.ceil(left) + "s before you can continue";
        node.classList.remove("done");
        lockNext(true);
        return true;
      }
      txt.textContent = "Ready when you are.";
      node.classList.add("done");
      lockNext(false);
      return false;
    }

    if (frame()) {
      dwellTimer = setInterval(function () {
        if (!frame()) { clearInterval(dwellTimer); dwellTimer = null; }
      }, 250);
    }
  }

  function lockNext(locked) {
    var b = document.querySelector(".nav .btn.primary");
    if (b) { b.disabled = locked; b.title = locked ? "Please review the options" : ""; }
  }
  function unlockNext() { lockNext(false); }

  function pipeText(t) { return window.BeaconQ ? window.BeaconQ.pipe(t, logicCtx(), "…") : String(t == null ? "" : t); }

  function renderStem(q) {
    var h = el("h2", "stem");
    var hideNum = q.hide_number===true || !!q._concept_parent || q.type==="concept_test";
    if (!hideNum) h.appendChild(el("span", "qnum", q.id + ". "));
    var body = el("span", "stem-text");
    // for Concept Test, also strip leading "Q1:" style number from the human text so only the question content shows
    if (q.stem_html && window.BeaconQ) {
      var html = q.stem_html;
      if(q._concept_parent){
        // strip a leading Q-number from rich html by converting to text first, but keep markup: simple regex on html string
        html = html.replace(/^\s*Q\s*\d+\s*[:.]\s*/i, "");
      }
      window.BeaconQ.richInto(body, html, logicCtx(), "…");
    } else {
      var txt = pipeText(q.stem);
      if(q._concept_parent) txt = txt.replace(/^\s*Q\s*\d+\s*[:.]\s*/i, "");
      body.textContent = txt;
    }
    h.appendChild(body);
    if (q.style) {
      var st = q.style;
      if (st.font) h.style.fontFamily = st.font;
      if (st.size) h.style.fontSize = st.size;
      if (st.align) h.style.textAlign = st.align;
      if (st.color) h.style.color = st.color;
    }
    return h;
  }

  function renderMedia(m, cls) {
    var box = el("div", "qmedia" + (cls ? " " + cls : "") + (m.align ? " qmedia-" + m.align : ""));
    var node;
    if (m.kind === "video") {
      node = el("video"); node.controls = true; node.src = m.src; node.preload = "metadata";
      if (m.autoplay) { node.autoplay = true; node.muted = true; }
    } else if (m.kind === "audio") {
      node = el("audio"); node.controls = true; node.src = m.src; node.preload = "metadata";
    } else {
      node = el("img"); node.src = m.src; node.alt = m.alt || "";
    }
    if (m.width) node.style.maxWidth = /%|px/.test(String(m.width)) ? String(m.width) : m.width + "px";
    box.appendChild(node);
    if (m.caption) box.appendChild(el("div", "qmedia-cap", null)).textContent = pipeText(m.caption);
    return box;
  }

  function questionBodyFor(q){
    var body;
    switch (q.type) {
      case "single_select": body = renderOptions(q, false); break;
      case "multi_select": body = renderOptions(q, true); break;
      case "date": body = renderDate(q); break;
      case "numeric_matrix": body = renderNumMatrix(q); break;
      case "heatmap": body = renderHeatmap(q); break;
      case "emoji_grid": body = renderEmojiGrid(q); break;
      case "delta": body = renderDelta(q); break;
      case "concept_test": body = renderConceptTest(q); break;
      case "loop": body = renderLoop(q); break;
      case "text_block": body = renderTextBlock(q); break;
      case "rating_grid": body = renderGrid(q, false); break;
      case "semantic_diff": body = renderGrid(q, true); break;
      case "rating_scale": body = renderRatingScale(q); break;
      case "gauge_meter": body = renderGaugeMeter(q); break;
      case "sum_to_100": body = renderSum100(q); break;
      case "rank": body = renderRank(q); break;
      case "numeric": {
        var row = el("div", "num-row");
        if (q.prefix) row.appendChild(el("span", "pre", String(q.prefix)));
        var inp = el("input");
        inp.type = "number"; inp.min = q.min; inp.max = q.max; inp.step = 1;
        var v = getAns(q.id, "_");
        inp.value = v === undefined ? "" : v;
        inp.addEventListener("input", function () {
          setAns(q.id, "_", inp.value === "" ? "" : Number(inp.value)); hideErr(); ansChanged();
        });
        row.appendChild(inp);
        if (q.suffix) row.appendChild(el("span", "suf", String(q.suffix)));
        body = row;
        break;
      }
      case "slider": {
        body = el("div");
        var val = getAns(q.id, "_");
        if (val === undefined) val = Math.round((q.min + q.max) / 2);
        var out = el("div", "slider-val", String(val) + (q.suffix || ""));
        var rng = el("input");
        rng.type = "range"; rng.min = q.min; rng.max = q.max; rng.step = q.step || 1;
        rng.value = val;
        setAns(q.id, "_", Number(val));
        ansChanged();
        rng.addEventListener("input", function () {
          out.textContent = rng.value + (q.suffix || "");
          setAns(q.id, "_", Number(rng.value)); hideErr(); ansChanged();
        });
        var ends = el("div", "slider-ends");
        ends.appendChild(el("span", null, String(q.min_label || q.min)));
        ends.appendChild(el("span", null, String(q.max_label || q.max)));
        body.appendChild(out); body.appendChild(rng); body.appendChild(ends);
        break;
      }
      case "open_text": {
        var ta = el("textarea");
        ta.placeholder = q.placeholder || "Type your answer here...";
        ta.value = getAns(q.id, "_") || "";
        var chip = el("div", "oq-chip");
        var aiBox = el("div", "ai-actions");
        body = el("div");
        body.appendChild(ta);
        body.appendChild(chip);
        body.appendChild(aiBox);
        body.appendChild(recorderFor(q));
        wireTextWatch(q, ta, chip, aiBox);
        break;
      }
    }
    return body;
  }
  function renderConceptHeader(q){
    var cctx = el("div", "concept-ctx");
    var descEl = null;
    var showConcept = null;
    var startTimer = null;
    // description handling: show per first-only flag using synthetic indices
    if(q._concept_description_html){
      var showDesc = true;
      if(q._concept_show_desc_first_only!==false){
        showDesc = !!q._concept_is_first_overall;
        if(showDesc===false && q._concept_is_first_overall===undefined){
          var firstConceptId = null;
          try{ for(var si=0; si<steps.length; si++){ var sq = steps[si].q; if(sq._concept_parent===q._concept_parent){ firstConceptId = sq._concept_id; break; } } }catch(e){}
          if(!firstConceptId && q._concept_parent){
            try{ var parentQ=null; for(var pi=0; pi<SPEC.questions.length; pi++){ if(SPEC.questions[pi].id===q._concept_parent){ parentQ=SPEC.questions[pi]; break; } } if(parentQ&&parentQ.concepts&&parentQ.concepts.length) firstConceptId=parentQ.concepts[0].id; }catch(e2){}
          }
          if(firstConceptId && q._concept_id !== firstConceptId) showDesc = false;
        }
      } else {
        if(q._concept_is_first_for_concept!==undefined) showDesc = !!q._concept_is_first_for_concept;
        else {
          var idx=-1; try{ for(var si2=0; si2<steps.length; si2++){ if(steps[si2].q.id===q.id){ idx=si2; break; } } }catch(e){}
          if(idx>0){
            try{ if(steps[idx-1].q._concept_id===q._concept_id) showDesc=false; }catch(e){}
          }
        }
      }
      if(showDesc){
        descEl = el("div","concept-desc"); if(window.BeaconQ) window.BeaconQ.richInto(descEl, q._concept_description_html, logicCtx(), "…"); else descEl.textContent = pipeText(q._concept_description_html); cctx.appendChild(descEl);
      }
    }
    var exec = q._concept_execution ? el("div","concept-exec", pipeText(q._concept_execution)) : null;
    if(exec) cctx.appendChild(exec);
    var ch = el("div","concept-header");
    // top bar: label left, timer+replay right top (small, not covering image)
    var topBar = el("div","concept-topbar"); topBar.setAttribute("style","display:flex;align-items:center;justify-content:space-between;gap:8px");
    var clabel = el("div","concept-label"); clabel.textContent = q._concept_label || "Concept"; clabel.setAttribute("style","font-size:11px;font-weight:800;color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:999px;padding:2px 7px;width:max-content;flex:none");
    topBar.appendChild(clabel);
    var mediaWrap = null;
    var durStr = q._concept_duration || "no-limit";
    var secs = null;
    (function(){ var d=String(durStr).toLowerCase().trim(); if(d==="no-limit"||d==="no limit"||d==="no_limit"||d==="") secs=null; else if(d.indexOf("min")>=0) secs=60; else { var m=d.match(/(\d+)/); secs=m?parseInt(m[1],10):null; } })();
    var hasTimedMedia = !!(q._concept_media && q._concept_media.src && secs!==null && secs>0);
    var timerEl = null, fill = null, replayBtn = null, timerGroup = null;
    // PIP helper – defined early so description Continue can use it
    function openPip(){
        var overlay = el("div","concept-pip-overlay");
        var box = el("div","concept-pip-box");
        var title = el("div","concept-pip-title"); title.textContent = q._concept_label || "Concept";
        var close = el("button","concept-pip-close"); close.type="button"; close.textContent="\u00d7";
        box.appendChild(title); box.appendChild(close);
        try{
          var mc = renderMedia(q._concept_media, "concept-media");
          box.appendChild(mc);
        }catch(e){}
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        function closePip(){ overlay.remove(); document.removeEventListener("keydown", onKey); }
        function onKey(e){ if(e.key==="Escape") closePip(); }
        document.addEventListener("keydown", onKey);
        overlay.addEventListener("click", function(e){ if(e.target===overlay) closePip(); });
        close.addEventListener("click", closePip);
      }
    if(hasTimedMedia || (q._concept_allow_replay && q._concept_media && q._concept_media.src)){
      timerGroup = el("div","concept-timer-group"); timerGroup.setAttribute("style","display:flex;align-items:center;gap:5px;flex:none");
      if(secs!==null && secs>0){
        var timerPill = el("div","concept-timer-pill"); timerPill.setAttribute("style","display:inline-flex;align-items:center;gap:4px;background:#0b4f6c;color:#fff;border-radius:999px;padding:2px 6px 2px 5px;font-size:10px;font-weight:700;min-width:58px;justify-content:center;line-height:1");
        timerPill.innerHTML = '<svg class="concept-timer-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l2 2"></path><path d="M9 2h6"></path><path d="M12 2v2"></path></svg>';
        timerEl = el("span","concept-timer"); timerEl.textContent = secs+"s"; timerEl.setAttribute("style","min-width:18px;text-align:center;font-variant-numeric:tabular-nums;color:#fff;font-size:10px");
        timerPill.appendChild(timerEl);
        var bar = el("div","concept-timer-bar"); bar.setAttribute("style","width:22px;height:2.5px;background:rgba(255,255,255,.32);border-radius:999px;overflow:hidden;flex:none"); fill = el("div","concept-timer-fill"); fill.setAttribute("style","height:100%;background:linear-gradient(90deg,#7fd4f0,#5eead4);width:100%;transition:width 1s linear"); bar.appendChild(fill);
        timerPill.appendChild(bar);
        timerGroup.appendChild(timerPill);
      }
      if(q._concept_allow_replay){
        replayBtn = el("button","concept-replay-btn");
        replayBtn.type="button"; replayBtn.setAttribute("style","display:inline-flex;align-items:center;gap:3px;background:linear-gradient(135deg,#ff6b35 0%,#f7931e 100%);color:#fff;border:1px solid #e05a2a;border-radius:999px;padding:2px 7px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;line-height:1"); replayBtn.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="concept-replay-icon"><path d="M21 12a9 9 0 1 1-2.6-6.3"></path><path d="M21 3v6h-6"></path></svg> Replay';
        timerGroup.appendChild(replayBtn);
      }
      if(timerGroup.children.length) topBar.appendChild(timerGroup);
    }
    ch.appendChild(topBar);
    if(q._concept_media && q._concept_media.src){
      mediaWrap = el("div","concept-media-wrap");
      var mediaEl = renderMedia(q._concept_media, "concept-media");
      mediaWrap.appendChild(mediaEl);
      // Initially hidden until Continue clicked – timer only starts then
      mediaWrap.style.display = "none";
      ch.appendChild(mediaWrap);
      // Click on media itself also opens PIP (zoom)
      mediaWrap.style.cursor = "pointer"; mediaWrap.title = "Click to view enlarged";
      mediaWrap.addEventListener("click", function(e){ if(e.target.tagName==="VIDEO") return; openPip(); });
      if(secs!==null && secs>0){
        var remaining = secs, total = secs, timerId = null;
        function updateTimer(){
          if(timerEl) timerEl.textContent = remaining+"s";
          if(fill) fill.style.width = (remaining/total*100)+"%";
          if(remaining<=0){
            clearInterval(timerId);
            if(timerEl) timerEl.textContent = "0s";
            if(fill) fill.style.width="0%";
            mediaWrap.style.opacity="0.35"; mediaWrap.style.filter="grayscale(0.7)";
            var hiddenMsg = el("div","concept-hidden-msg");
            hiddenMsg.setAttribute("style","font-size:11px;color:var(--muted);text-align:center;margin-top:6px;font-style:italic");
            hiddenMsg.innerHTML = 'Concept hidden – <a href="#" class="concept-view-link" style="color:var(--accent-2);font-weight:700;text-decoration:underline">view the concept</a> again';
            var vl = hiddenMsg.querySelector(".concept-view-link");
            if(vl) vl.addEventListener("click", function(e){ e.preventDefault(); e.stopPropagation(); openPip(); });
            if(!mediaWrap.querySelector(".concept-hidden-msg")) mediaWrap.appendChild(hiddenMsg);
          }
        }
        startTimer = function(){
          remaining = total; 
          mediaWrap.style.display = "block";
          mediaWrap.style.opacity="1"; mediaWrap.style.filter="none";
          var hm = mediaWrap.querySelector(".concept-hidden-msg"); if(hm) hm.remove();
          updateTimer(); clearInterval(timerId); timerId = setInterval(function(){ remaining--; updateTimer(); if(remaining<=0) clearInterval(timerId); }, 1000);
        }
        showConcept = function(){
          startTimer();
          // disable the Continue link after first use
          if(descEl){
            var l = descEl.querySelector(".concept-view-link");
            if(l){ l.style.opacity="0.6"; l.style.pointerEvents="none"; }
          }
        }
        if(replayBtn) replayBtn.addEventListener("click", function(){ startTimer(); });
        mediaWrap._timerId = timerId;
      } else {
        // no-limit: no timer, but showConcept just reveals media
        showConcept = function(){
          mediaWrap.style.display = "block";
          mediaWrap.style.opacity="1"; mediaWrap.style.filter="none";
        }
      }
    } else if(q._concept_text_html || q._concept_text){
      var cbody = el("div","concept-body");
      if(q._concept_text_html && window.BeaconQ) window.BeaconQ.richInto(cbody, q._concept_text_html, logicCtx(), "…");
      else cbody.textContent = pipeText(q._concept_text);
      ch.appendChild(cbody);
    }
    // After media/timer are set up, hyperlink the Continue in the description (only one instance)
    if(descEl){
      try{
        var html = descEl.innerHTML;
        if(html.indexOf("Continue")!==-1 && !descEl.querySelector(".concept-view-link")){
          descEl.innerHTML = html.replace(/Continue/, '<a href="#" class="concept-view-link" style="color:var(--accent-2);font-weight:700;text-decoration:underline">Continue</a>');
        }
        var dlink = descEl.querySelector(".concept-view-link");
        if(dlink && showConcept){
          dlink.addEventListener("click", function(e){ e.preventDefault(); e.stopPropagation(); showConcept(); });
        } else if(dlink && q._concept_media && q._concept_media.src){
          // if no timer (no-limit), clicking Continue should just reveal media
          dlink.addEventListener("click", function(e){ e.preventDefault(); e.stopPropagation(); if(mediaWrap) mediaWrap.style.display="block"; });
        }
      }catch(e){}
    }
    // If no Continue link exists (e.g., description hidden for this concept), show concept immediately
    if(mediaWrap && mediaWrap.style.display==="none" && !cctx.querySelector(".concept-view-link")){
      mediaWrap.style.display = "block";
      if(startTimer) startTimer();
    }
    cctx.appendChild(ch);
    return cctx;
  }
  function renderQuestion(q) {
    // Which section a question sits in (screeners, main, ...) is research-team information and
    // is never shown to the respondent - not on the card, not in the progress strip. Section
    // titles stay visible in the Studio outline, where the team needs them.
    var card = el("div", "card");
    if (q._concept_parent) { card.appendChild(renderConceptHeader(q)); }
    if (q._loop_parent) {
      var ctx = el("div", "loop-ctx");
      ctx.textContent = "For " + (q._loop_label || q._loop_item) + " \u2014 " + q._loop_parent;
      ctx.title = "Loop from " + q._loop_parent + " for item " + q._loop_item;
      card.appendChild(ctx);
    }
    if (q.comprehension) {
      card.appendChild(el("div", "cc-banner",
        "\uD83D\uDCA1 Quick check \u2014 this confirms the profile was clear. " +
        "It does not affect your participation."));
    }
    card.appendChild(renderStem(q));
    if (q.help_html || q.help) {
      var hp = el("div", "help");
      if (q.help_html && window.BeaconQ) window.BeaconQ.richInto(hp, q.help_html, logicCtx(), "…");
      else hp.textContent = pipeText(q.help);
      card.appendChild(hp);
    }
    if (q.media && q.media.src) card.appendChild(renderMedia(q.media));
    card.appendChild(guideBar(function () { return qSpeechText(q); }));

    var body = questionBodyFor(q);
    if (body) card.appendChild(body);

    if (q.comprehension) card.appendChild(buildCcFeedback(q));
    return card;
  }

  function buildCcFeedback(q) {
    var box = el("div", "cc-feedback");
    var correct = q.comprehension.correct;
    var prev = getAns(q.id, "_");
    if (prev !== undefined) showCc(prev);
    return box;

    function showCc(val) {
      var ok = String(val) === String(correct);
      box.className = "cc-feedback show " + (ok ? "ok" : "retry");
      box.innerHTML = ok
        ? "<strong>That is right.</strong> The profile is clear \u2014 let's carry on."
        : "<strong>Worth another look.</strong> That is not quite what the profile said. " +
          "You can replay the walkthrough before answering the rest.";
      if (!ok) {
        var b = el("button", "btn", "\u25B6 Replay the product walkthrough");
        b.type = "button";
        b.addEventListener("click", function () { runExplainer(SCENES, function () {}); });
        box.appendChild(b);
      } else if (!box.dataset.awarded) {
        box.dataset.awarded = "1";
        addPoints(25);
      }
    }
    // re-check whenever the answer changes
    var poll = setInterval(function () {
      if (!document.body.contains(box)) { clearInterval(poll); return; }
      var v = getAns(q.id, "_");
      if (v !== undefined && String(v) !== box.dataset.seen) {
        box.dataset.seen = String(v);
        showCc(v);
      }
    }, 400);
  }

  // ============================================================ validation
  function showErr(msg) { var e = $(PREVIEW ? ".prev-err" : "#err"); if (e) { e.textContent = msg; e.classList.add("show"); } }
  function hideErr() { var e = $(PREVIEW ? ".prev-err" : "#err"); if (e) e.classList.remove("show"); }

  // A comment box can be required outright, required when named rows are answered, or
  // required on a row of its own.  Nothing else is blocked - only the box itself.
  function missingComment(q) {
    var a = answers[q.id] || {}, c = q.comments || {}, need = [];
    function blank(v) { return !String(v || "").trim(); }
    var wanted = c.mode === "require";
    if (!wanted && (c.require_when || []).length) {
      wanted = (c.require_when || []).some(function (code) {
        var v = a[code];
        return v !== undefined && v !== "" && v !== "NA";
      });
    }
    if (wanted && blank(a._comment)) return "Please add a comment before continuing.";
    (q.rows || []).forEach(function (r) {
      if (a[r.code] === "NA") return;               // N/A rows carry nothing to comment on
      if (r.comment === "require" && blank(a["c_" + r.code])) need.push(pipeText(r.label));
    });
    if (need.length) return "Please add a comment for " + need.join(", ") + ".";
    return null;
  }

  function validateStep() {
    var st = steps[cur];
    if (st.kind === "task") {
      if (getAns(st.q.id, "T" + st.taskId) === undefined) {
        showErr("Please choose one of the treatments, or choose to continue current standard of care.");
        return false;
      }
      if (dwellTimer) {
        showErr("Please take a moment to review the options before continuing.");
        return false;
      }
      return true;
    }
    var q = st.q;
    if (q.required && !answered(q)) {
      showErr("This question is required.");
      return false;
    }
    if (q.type === "sum_to_100") {
      var a = answers[q.id] || {}, s = 0;
      q.rows.forEach(function (r) { s += parseInt(a[r.code], 10) || 0; });
      if (s !== 100) { showErr("The total must equal 100 (currently " + s + ")."); return false; }
    }
    if (q.type === "numeric" && q.required) {
      var n = Number(getAns(q.id, "_"));
      if (isNaN(n) || n < q.min || n > q.max) {
        showErr("Please enter a value between " + q.min + " and " + q.max + "."); return false;
      }
    }
    if (q.type === "numeric_matrix") {
      var na = answers[q.id] || {}, nmCells = [], nmCols = q.cols || [];
      (q.rows || []).forEach(function (rr) {
        if (nmCols.length) nmCols.forEach(function (cc) {
          nmCells.push([rr.label + " \u00D7 " + cc.label, rr.code + "_" + cc.code]); });
        else nmCells.push([rr.label, rr.code]);
      });
      for (var ri = 0; ri < nmCells.length; ri++) {
        var rv = na[nmCells[ri][1]], rname = nmCells[ri][0];
        if (rv === undefined || rv === "" || rv === "NA") continue;
        if (!isNum(rv)) { showErr(rname + ": please enter a number."); return false; }
        if (q.min !== undefined && parseFloat(rv) < q.min) { showErr(rname + " must be at least " + q.min + "."); return false; }
        if (q.max !== undefined && parseFloat(rv) > q.max) { showErr(rname + " must be at most " + q.max + "."); return false; }
      }
    }
    var cmtErr = missingComment(q);
    if (cmtErr) { showErr(cmtErr); return false; }
    if (q.type === "delta") {
      var da = answers[q.id] || {}, need = ["before", "after"];
      for (var di = 0; di < 2; di++) {
        var dv = da[need[di]];
        if (dv === undefined || dv === "") continue;
        if (!isNum(dv)) { showErr("Please enter numbers only."); return false; }
        if (q.min !== undefined && parseFloat(dv) < q.min) { showErr("Values must be at least " + q.min + "."); return false; }
        if (q.max !== undefined && parseFloat(dv) > q.max) { showErr("Values must be at most " + q.max + "."); return false; }
      }
    }
    if (q.type === "loop" && q.child === "numeric") {
      var la = answers[q.id] || {};
      var itsL = q._loop_items || loopItemsFor(q);
      for (var li = 0; li < itsL.length; li++) {
        var lv = la[itsL[li].code];
        if (lv !== undefined && lv !== "" && !isNum(lv)) { showErr(itsL[li].label + ": please enter a number."); return false; }
      }
    }
    if (q.type === "open_text" && q.required && q.min_words) {
      var words = String(getAns(q.id, "_") || "").trim().split(/\s+/).filter(Boolean);
      if (words.length < q.min_words) {
        showErr("Please write at least " + q.min_words + " words."); return false;
      }
    }
    if (q.type === "open_text" && aiActionOf(q) === "confirm") {
      var ai = (answers[q.id] || {})._ai;
      if (ai && ai.verdict === "likely_ai" && !ai.ack) {
        showErr("Our quality check reads this answer as AI-written or pasted. Please write it " +
                "in your own words, or confirm that you wrote it yourself.");
        return false;
      }
    }
    return true;
  }

  // ============================================================ screening
  // Screening is data, never code: every question can carry its own screen-in /
  // screen-out rules (see BeaconQ.screening in qlogic.js).  Nothing about a study's
  // quotas is hard-coded here any more - the rules travel with the questionnaire.
  function screenOut(v) {
    stopNarration();
    var qid = v.qid || (steps[cur] && steps[cur].q.id) || "";
    save({ screened_out: true, screen_out_reason: v.reason, screen_out_at: qid });
    var card = el("div", "card");
    card.appendChild(el("div", "done-icon stop", "&#10005;"));
    card.appendChild(el("h1", null, "End of survey"));
    card.appendChild(el("p", null, String(v.message || SPEC.terminate_text)));
    card.appendChild(el("div", "summary", "Screened out at <code>" + qid +
      "</code> &middot; reference <code>" + SESSION.respondent_code + "</code>"));
    show(card, true);
    setAnswering(false);                           // project bar returns on the closing screen
    $("#progress-wrap").style.display = "none";
    $("#hud").hidden = true;
    $("#tpp-panel").hidden = true;
  }

  // Evaluate every screening rule in the study.  phase "live" only looks at the rules
  // marked to fire the moment they match; the Next button checks everything.
  function evaluateScreening(phase) {
    if (!window.BeaconQ || !window.BeaconQ.screeningVerdict) return null;
    // questions, not steps: every conjoint task belongs to the same question
    var idx = SPEC.questions.indexOf(steps[cur].q);
    return window.BeaconQ.screeningVerdict(
      SPEC.questions, answers,
      { phase: phase, upto: idx < 0 ? SPEC.questions.length - 1 : idx });
  }
  function screeningHit(phase) {
    if (window.BEACON_PREVIEW_MODE) return null;   // the Studio test view never ends the survey
    var v = evaluateScreening(phase);
    if (v) screenOut(v);
    return v;
  }
  // Fires after every answer the respondent gives.  Rules set to "as soon as it matches"
  // end the survey there and then; the rest wait for Next.
  function ansChanged() { return screeningHit("live"); }

  // ============================================================ navigation
  // ============================================================ respondent chrome
  // The project information (brand, study name, respondent code, timer), the gamification HUD and
  // the progress strip are shown on the welcome and closing screens only.  They are hidden for as
  // long as a question is on screen, so nothing competes with it.  See `.answering` in survey.css.
  function setAnswering(on) { document.body.classList.toggle("answering", !!on); }

  function show(node, replace) {
    var app = $("#app");
    app.innerHTML = "";
    app.appendChild(node);
    if (!replace) {
      var nav = el("div", "nav");
      var back = el("button", "btn ghost", "&larr; Back");
      back.type = "button";
      back.disabled = nextVisible(cur, -1) < 0;
      back.addEventListener("click", function () { var pv = nextVisible(cur, -1); if (pv >= 0) go(pv); });
      var last = nextVisible(cur, 1) < 0;
      var fwd = el("button", "btn primary", last ? "Submit survey" : "Next &rarr;");
      fwd.type = "button";
      fwd.addEventListener("click", next);
      nav.appendChild(back);
      if (IS_TEST) {
        var jumpWrap = el("label", "test-jump-inline");
        jumpWrap.innerHTML = '<span>Jump to</span>';
        var jump = el("select"); jump.setAttribute("aria-label", "Jump to any survey question");
        steps.forEach(function (s, i) {
          var o = document.createElement("option"), done = answers[s.q.id] && Object.keys(answers[s.q.id]).some(function(k){ return k.charAt(0) !== "_"; });
          o.value = i; o.selected = i === cur;
          o.textContent = (done ? "✓ " : "") + s.q.id + " · " + String(s.q.stem || "Choice task").slice(0, 46);
          jump.appendChild(o);
        });
        jump.addEventListener("change", function () { save(); go(Number(this.value)); });
        jumpWrap.appendChild(jump); nav.appendChild(jumpWrap);
      }
      nav.appendChild(fwd);
      app.appendChild(nav);
      var err = el("div", "err"); err.id = "err";
      app.appendChild(err);
    }
    voiceField = 0; voiceExplicitField = false; labelVoiceControls();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // When the respondent is on a translated (child) survey, they can flip any single
  // question back to the original wording - or back again - with the chip in the header.
  function locQ(q) {
    var dt = SPEC.default_text;
    if (!dt || !ORIG[q.id]) return q;
    var c = JSON.parse(JSON.stringify(q));
    function g(k) { return dt["q:" + q.id + ":" + k]; }
    ["stem", "stem_html", "help", "help_html", "placeholder", "vignette", "concept", "concept_html",
     "body", "body_html", "before_label", "after_label"].forEach(function (k) {
      var t = g(k);
      if (t !== undefined) c[k] = t;
    });
    if (g("stem_html")) c.stem = (window.BeaconQ ? window.BeaconQ.stripTags(g("stem_html")) : g("stem_html"));
    (c.options || []).forEach(function (o) { var t = g("opt:" + o.code); if (t !== undefined) o[o.label_html ? "label_html" : "label"] = t; });
    (c.rows || []).forEach(function (r) { var t = g("row:" + r.code); if (t !== undefined) r[r.label_html ? "label_html" : "label"] = t; });
    (c.cols || []).forEach(function (r) { var t = g("col:" + r.code); if (t !== undefined) r[r.label_html ? "label_html" : "label"] = t; });
    (c.items || []).forEach(function (it) { var t = g("loopitem:" + it.code); if (t !== undefined) it.label = t; });
    if (c.scale) {
      ["min_label", "max_label"].forEach(function (k) { var t = g(k); if (t !== undefined) c.scale[k] = t; });
      (c.scale.face_labels || []).forEach(function (f, i) { var t = g("face:" + i); if (t !== undefined) c.scale.face_labels[i] = t; });
    }
    return c;
  }

  function langChip(q) {
    var dt = SPEC.default_text;
    if (!dt || !Object.keys(dt).length || SPEC.render_language === SPEC.default_language) return null;
    var meta = null;
    (SPEC.languages || []).forEach(function (l) { if (l.code === SPEC.render_language) meta = l; });
    var chip = el("button", "i18n-chip");
    chip.type = "button";
    chip.title = "Switch just this question between " + (meta ? meta.native : SPEC.render_language) + " and the original";
    chip.textContent = ORIG[q.id] ? "\u21C4 " + (meta ? meta.native : "translated") : "\u21C4 original";
    chip.addEventListener("click", function () {
      ORIG[q.id] = !ORIG[q.id];
      render();
    });
    return chip;
  }

  function renderTestConsole() {
    if (!IS_TEST) return;
    var box = document.getElementById("test-console"); if (!box || !steps.length) return;
    box.hidden = false;
    var opts = steps.map(function(s,i){ var done = answers[s.q.id] && Object.keys(answers[s.q.id]).some(function(k){return k.charAt(0)!=='_';}); return '<option value="'+i+'"'+(i===cur?' selected':'')+'>'+ (done?'✓ ':'') + escHtml(s.q.id + ' · ' + String(s.q.stem || 'Choice task').slice(0,55)) + '</option>';}).join('');
    var qid = steps[cur].q.id;
    // screening: the rules on this question and what they do to this respondent right now
    var scrBits = "";
    if (window.BeaconQ && window.BeaconQ.screenSummary) {
      var scrLines = window.BeaconQ.screenSummary(steps[cur].q, SPEC.questions);
      if (scrLines.length) {
        var scrV = window.BeaconQ.screeningVerdict(SPEC.questions, answers,
                     { upto: SPEC.questions.indexOf(steps[cur].q) });
        scrBits = '<div class="tc-screen"><b>Screening</b>' + scrLines.map(function (l) {
          return "<span>" + escHtml(l.text) + " <em>" + (l.when === "live" ? "on the spot" : "on Next") + "</em></span>";
        }).join("") + "<i>" + (scrV
          ? "This respondent would be screened out here - " + escHtml(scrV.reason)
          : "This respondent continues.") + "</i></div>";
      }
    }
    box.innerHTML = '<div class="tc-head"><b>Test workspace</b><span>Not shown to respondents</span><button id="tc-collapse">−</button></div><div class="tc-current">Reviewing <b>'+escHtml(qid)+'</b> · use <i>Jump to</i> beside Next to navigate</div>' + scrBits + '<div class="tc-actions"><button id="tc-ai">✦ AI fill test answers</button><a href="/studio/#'+encodeURIComponent(STUDY.slug)+'" target="_blank">Edit in Studio ↗</a></div><label>Review note for '+escHtml(qid)+'<textarea id="tc-note" placeholder="Describe an error, wording issue or logic discrepancy…">'+escHtml(testNotes[qid] || '')+'</textarea></label><button class="tc-save" id="tc-share">Save notes & copy review link</button><small id="tc-state">The link preserves answers, position and notes for your team.</small>';
    $("#tc-note").oninput=function(){ testNotes[qid]=this.value; store('test_notes',testNotes); };
    $("#tc-ai").onclick=aiFillTest;
    $("#tc-share").onclick=saveTestReview;
    $("#tc-collapse").onclick=function(){box.classList.toggle('collapsed'); this.textContent=box.classList.contains('collapsed')?'+':'−';};
  }
  function escHtml(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function aiFillTest(){
    steps.forEach(function(s){ var q=s.q, a=answers[q.id]=answers[q.id]||{}; if(q.options&&q.options.length)a._=String(q.options[0].code); else if(q.type==='open_text')a._='Test response generated for survey validation only.'; else if(q.type==='numeric'||q.type==='slider'||q.type==='nps')a._=q.min||5; else if(q.type==='heatmap'){ if(q.heatmap){ var rc=(q.heatmap.reactions||[])[0]; if(rc) a.clicks=[{x:0.5,y:0.5,reaction:rc.code}]; } else (q.rows||[]).forEach(function(r){(q.cols||[]).forEach(function(c){a[r.code+'_'+c.code]=1;});}); } else if(q.rows)(q.rows||[]).forEach(function(r){a[r.code]=(q.scale&&q.scale.min)||1;}); });
    store('answers',answers); save(); render(); toastTest('AI populated test-only sample answers. Review before using navigation.');
  }
  function toastTest(msg){var s=$("#tc-state");if(s)s.textContent=msg;}
  function saveTestReview(){
    fetch('/api/test-review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({study:STUDY.slug,token:reviewToken,answers:answers,notes:testNotes,current:cur})}).then(function(r){return r.json();}).then(function(d){reviewToken=d.token;var url=location.origin+d.url;if(navigator.clipboard)navigator.clipboard.writeText(url);toastTest('Review saved and share link copied: '+url);});
  }

  function render() {
    var st = steps[cur];
    setAnswering(true);
    stopNarration();
    pendingDwell = null;
    if (dwellTimer) { clearInterval(dwellTimer); dwellTimer = null; }

    var node = st.kind === "task" ? renderConjoint(st) : renderQuestion(locQ(st.q));
    var chip = st.kind === "task" ? null : langChip(st.q);
    if (chip && node.insertBefore) {
      var stemH = node.querySelector(".stem");
      if (stemH) node.insertBefore(chip, stemH); else node.appendChild(chip);
    }
    show(node);
    renderTestConsole();
    if (audioPref === "all" && soundOn) setTimeout(function(){ speak(st.kind === "task" ? taskSpeechText(st) : qSpeechText(st.q)); }, 250);
    if (pendingDwell) { startDwell(pendingDwell); pendingDwell = null; }

    // the bar fills silently: no section name, no step counter next to it
    setProgress(Math.round((cur / steps.length) * 100));

    var inTPP = st.q.section === "C" || st.q.section === "D";
    $("#tpp-panel").hidden = !inTPP;
  }

  // Fires once per section: narration, milestone, points.
  function onEnterSection(sec) {
    if (seenSections[sec.id]) return;
    seenSections[sec.id] = true;

    if (sec.id === "C") {
      // the product profile is shown as a narrated animation before any opinion is sought
      runExplainer(SCENES, function () {
        if (audioPref === "all" && SECTION_NARRATION[sec.id]) playClip(SECTION_NARRATION[sec.id]);
        coachSay("Keep the profile fresh in mind - the questions ahead refer back to it. " +
          "Replay it any time from the panel at the bottom right.", "info");
      });
      return;
    }
    if (sec.id === "D") {
      runExplainer([window.BEACON_CONJOINT_SCENE], function () {
        coachSay("Nine choice tasks ahead - you earn insight points with every one.", "info");
      });
      return;
    }
    if (audioPref === "all" && SECTION_NARRATION[sec.id]) playClip(SECTION_NARRATION[sec.id]);
  }

  function onLeaveSection(prevSec, nextSec) {
    if (!prevSec || prevSec.id === nextSec.id) return;
    // The section bonus is still earned and the HUD still ticks up, but there is no between-section
    // popup any more: once a section ends the respondent goes straight on to the next question.
    addPoints(SECTION_POINTS[prevSec.id] || 50);
  }

  // show-if logic: a step is visible when its question's rules pass against current answers
  function logicCtx() { return { answers: answers, questions: SPEC.questions }; }
  function stepVisible(i) {
    var st = steps[i];
    if (!st || !window.BeaconQ) return true;
    return window.BeaconQ.showIf(st.q, logicCtx());
  }
  function nextVisible(i, dir) {
    for (var j = i + dir; j >= 0 && j < steps.length; j += dir) if (stepVisible(j)) return j;
    return -1;
  }

  function go(i) {
    if (i < 0 || i >= steps.length) return;
    if (!stepVisible(i)) { var alt = nextVisible(i, i < cur ? -1 : 1); if (alt < 0) return; i = alt; }
    cur = i;
    render();
  }

  function next() {
    if (!validateStep()) return;
    if (screeningHit()) return;                // screen-out rules, both live and on-Next

    var prevSec = sectionOf(steps[cur].q);
    var nx = nextVisible(cur, 1);
    if (nx < 0) return finish();
    // answers to questions that are now hidden are dropped so logic and exports stay consistent
    for (var h = cur + 1; h < nx; h++) delete answers[steps[h].q.id];
    cur = nx;
    var nextSec = sectionOf(steps[cur].q);
    render();
    if (prevSec.id !== nextSec.id) onLeaveSection(prevSec, nextSec);
    onEnterSection(nextSec);
    if (steps[cur].kind === "task") addPoints(5);
    save();
  }

  function finish() {
    stopNarration();
    // every written answer gets one last quality pass before it leaves the browser
    if (!proofreadSeen && freeTextAnswers().length) { showProofread(); return; }
    submitSurvey();
  }

  function submitSurvey() {
    stopNarration();
    var secs = (Date.now() - t0) / 1000;
    save({}, function () {
      fetch("/api/submit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: SESSION.session_id, answers: answers, elapsed_seconds: secs })
      }).then(function (r) { return r.json(); }).then(function (res) {
        var card = el("div", "card");
        card.appendChild(el("div", gamifyOn() ? "done-icon done-target" : "done-icon",
          gamifyOn()
            ? '<svg viewBox="0 0 72 72" aria-hidden="true">' +
              '<circle cx="36" cy="36" r="32" fill="#e8f2f7"/>' +
              '<circle cx="36" cy="36" r="22" fill="#fff" stroke="#12789e" stroke-width="3"/>' +
              '<circle cx="36" cy="36" r="12.5" fill="#e8f2f7" stroke="#12789e" stroke-width="3"/>' +
              '<circle cx="36" cy="36" r="4.5" fill="#0b4f6c"/>' +
              '<path d="M36 36 L60 12" stroke="#0b4f6c" stroke-width="3.5" stroke-linecap="round"/>' +
              '<path d="M60 12 l-9 2.2 M60 12 l-2.2 9" stroke="#0b4f6c" stroke-width="3.5" stroke-linecap="round"/>' +
              '</svg>'
            : "&#10003;"));
        card.appendChild(el("h1", null, SPEC.thanks_title || "Thank you"));
        card.appendChild(el("p", null, SPEC.thanks_text || "Your responses have been recorded. Thank you for the " +
          "time and clinical insight you have given this study."));
        var flags = res.flags || [];
        card.appendChild(el("div", "summary",
          gamifyOn()
            ? "Reference <code>" + res.respondent_code + "</code> &middot; " +
              Math.round(secs / 60) + " min &middot; <strong>" + points +
              "</strong> insight points &middot; rank <strong>" + rankFor(points) +
              "</strong> &middot; quality control: <code>" +
              (flags.length ? flags.join(", ") : "clean") + "</code>"
            : "Reference <code>" + res.respondent_code + "</code> &middot; " +
              Math.round(secs / 60) + " min"));
        if (flags.indexOf("ai_generated_verbatim") >= 0) {
          card.appendChild(el("div", "ai-note",
            "One or more written answers were flagged as possibly AI-generated. They stay on " +
            "your record marked for review - the rest of your answers are unaffected."));
        }
        show(card, true);
        setAnswering(false);                     // project bar returns on the closing screen
        $("#progress-wrap").style.display = "none";
        $("#hud").hidden = true;
        $("#tpp-panel").hidden = true;
        setProgress(100);
        confetti();
        playClip("complete");
        ["session_id", "answers", "cur"].forEach(function (k) { store(k); });
      }).catch(function () {
        show(el("div", "card", "<h1>Connection problem</h1><p>Your answers are held in this " +
          "browser. Please try submitting again.</p>"), true);
      });
    });
  }

  // ============================================================ final proofreading pass
  // Before the survey is submitted, every written answer is scored once more and anything
  // that reads as AI-generated, pasted in, or simply broken is put back in front of the
  // respondent with the reasons and a chance to fix it. Answers stay flagged on the record
  // either way - this is a nudge, not a way to scrub a flag.
  var SERIOUS_NOTES = ["placeholder", "lorem", "doubled_word", "run_on", "markdown",
                       "all_caps", "assistant_tone"];

  function freeTextAnswers() {
    var out = [];
    (SPEC.questions || []).forEach(function (q) {
      if (q.type !== "open_text" || aiActionOf(q) === "off") return;
      var txt = String((answers[q.id] || {})._ || "").trim();
      if (txt.length >= 20) out.push({ q: q, text: txt });
    });
    return out;
  }

  function flaggedFor(item) {
    var res = aiState[item.q.id];
    if (!res || res.text !== item.text) return null;           // not scored (yet)
    if (((answers[item.q.id] || {})._ai || {}).ack) return null;   // already confirmed
    var notes = (res.proofread || []).filter(function (n) {
      return SERIOUS_NOTES.indexOf(n.key) >= 0;
    });
    if (res.verdict === "human" && !notes.length) return null;
    return { res: res, notes: notes };
  }

  function proofRow(row) {
    var q = row.item.q, res = row.res;
    var box = el("div", "proof-row");
    box.appendChild(el("div", "proof-head", "<b>" + q.id + ".</b> " + escHtml(pipeText(q.stem))));
    var chips = el("div", "proof-chips");
    var head = res.verdict === "likely_ai" ? "Looks AI-written"
             : res.verdict === "possible_ai" ? "May be AI-written" : "Worth a fix";
    chips.appendChild(el("span", "pr-chip" + (res.verdict === "human" ? "" : " warn"),
      head + " &middot; " + res.score + "/100"));
    aiReasons(res).slice(0, 4).forEach(function (r) { chips.appendChild(el("span", "pr-chip", escHtml(r))); });
    row.notes.slice(0, 3).forEach(function (n) {
      chips.appendChild(el("span", "pr-chip", "Proofreading: " + escHtml(n.note)));
    });
    box.appendChild(chips);

    var ta = el("textarea", "proof-text");
    ta.value = row.item.text;
    trackKeys(metaFor(q.id), ta);            // rewriting here counts as typing
    box.appendChild(ta);
    row.ta = ta;

    var acts = el("div", "proof-acts");
    var mine = el("button", "g-btn", "&#10003; I wrote this myself");
    mine.type = "button";
    mine.addEventListener("click", function () {
      row.mine = true;
      mine.disabled = true;
      mine.textContent = "Confirmed - thank you";
    });
    var re = el("button", "g-btn ghost", "&#8635; Re-check this answer");
    re.type = "button";
    re.addEventListener("click", function () {
      row.item.text = ta.value.trim();
      row.mine = false;
      mine.disabled = false;
      mine.innerHTML = "&#10003; I wrote this myself";
      re.disabled = true;
      re.textContent = "Checking\u2026";
      setAns(q.id, "_meta", metaFor(q.id));
      checkText(q.id, row.item.text, metaFor(q.id), function (fresh) {
        re.disabled = false;
        re.innerHTML = "&#8635; Re-check this answer";
        if (!fresh) return;
        row.res = fresh;
        var f = flaggedFor(row.item);
        if (!f) {
          box.parentNode.removeChild(box);       // fixed - it now reads clean
        } else {
          // rebuild the row in place, keeping the same entry so Submit stores the new score
          row.notes = f.notes;
          row.mine = false;
          box.parentNode.replaceChild(proofRow(row), box);
        }
      });
    });
    acts.appendChild(mine);
    acts.appendChild(re);
    box.appendChild(acts);
    return box;
  }

  function stepIndexOf(q) {
    for (var i = 0; i < steps.length; i++) if (steps[i].q && steps[i].q.id === q.id) return i;
    return cur;
  }

  function showProofread() {
    var items = freeTextAnswers();
    var card = el("div", "card proof-card");
    card.appendChild(el("div", "done-icon note", "&#9998;"));
    card.appendChild(el("h1", null, "One last look at your written answers"));
    card.appendChild(el("p", null,
      "Before your answers reach the researchers we run a quality check on everything you " +
      "wrote. Text that looks generated by an AI tool, pasted in from somewhere else, or in " +
      "need of a quick fix is listed below with the reason. Your own words - short, rough or " +
      "unfinished - are worth far more to this study than polished text from a chatbot."));
    var hold = el("div", "proof-list", "Checking your written answers\u2026");
    card.appendChild(hold);
    show(card, true);

    var waiting = 0;
    items.forEach(function (it) {
      var cached = aiState[it.q.id];
      if (cached && cached.text === it.text) return;
      waiting++;
      checkText(it.q.id, it.text, metaFor(it.q.id), function () {
        if (--waiting === 0) draw();
      });
    });
    if (!waiting) draw();

    function draw() {
      var rows = items.map(function (it) {
        var f = flaggedFor(it);
        return f ? { item: it, res: f.res, notes: f.notes } : null;
      }).filter(Boolean);
      proofreadSeen = true;
      if (!rows.length) { submitSurvey(); return; }

      hold.innerHTML = "";
      hold.appendChild(el("p", "proof-note",
        rows.length + " of your " + items.length + " written answers need a look:"));
      rows.forEach(function (r) { hold.appendChild(proofRow(r)); });

      var nav = el("div", "nav");
      var back = el("button", "btn ghost", "&larr; Back to the survey");
      back.type = "button";
      back.addEventListener("click", function () {
        proofreadSeen = false;
        go(stepIndexOf(rows[0].item.q));
      });
      var done = el("button", "btn primary", "Submit survey &rarr;");
      done.type = "button";
      done.addEventListener("click", function () {
        rows.forEach(function (r) {
          setAns(r.item.q.id, "_", r.ta.value);
          setAns(r.item.q.id, "_ai", { score: r.res.score, verdict: r.res.verdict,
                                       ack: !!r.mine, reviewed: Date.now() });
        });
        submitSurvey();
      });
      nav.appendChild(back);
      nav.appendChild(done);
      card.appendChild(nav);
      voiceField = 0; voiceExplicitField = false; labelVoiceControls();
    }
  }

  // ============================================================ persistence
  var saveTimer = null;
  function save(extra, cb) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var body = { session_id: SESSION.session_id, answers: answers,
                   elapsed_seconds: (Date.now() - t0) / 1000 };
      if (extra) for (var k in extra) body[k] = extra[k];
      fetch("/api/save", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) throw new Error('Save failed');
        var status = document.getElementById('survey-save-status'); if (status) status.textContent = 'Answers saved';
        if (cb) cb();
      }).catch(function () {
        var status = document.getElementById('survey-save-status'); if (status) status.textContent = 'Not saved — check your connection. Your answers remain in this browser.';
        store('answers', answers); store('cur', cur);
        coachSay('Could not save. Check your connection and try Next or Submit again.', 'warn');
      });
    }, 40);
  }

  function tickClock() {
    var s = Math.floor((Date.now() - t0) / 1000);
    var m = Math.floor(s / 60);
    $("#elapsed").textContent = m + "m " + String(s % 60).padStart(2, "0") + "s";
  }

  // ============================================================ boot
  function boot() {
    // ?new=1 / ?reset=1 / ?fresh=1 - wipe this browser's saved session and start over
    try {
      if (/[?&](new|reset|fresh)=1/.test(location.search)) {
        ["session_id", "answers", "cur"].forEach(function (k) { store(k); });
      }
    } catch (e) {}
    try {
      LANG = new URLSearchParams(location.search).get("lang") || recall("lang") || "";
    } catch (e) {}
    loadSpec();
  }

  function loadSpec() {
    fetch("/api/spec/" + STUDY.slug + "?lang=" + encodeURIComponent(LANG) + (IS_TEST ? "&preview=1" : "") + (recall("session_id") ? "&sid=" + encodeURIComponent(recall("session_id")) : "")).then(function (r) { return r.json(); }).then(function (spec) {
      SPEC = spec;
      CONJOINT = spec.conjoint;
      NARR = spec.narration;
      SCENES = spec.explainer_scenes;
      document.body.classList.toggle("gamified", gamifyOn());
      // 0 is a valid setting (no gate) - only an absent value falls back to the default
      MIN_DWELL = spec.conjoint_min_dwell === undefined || spec.conjoint_min_dwell === null
                  ? 12 : Number(spec.conjoint_min_dwell);
      window.BEACON_CONJOINT_SCENE = spec.conjoint_scene;

      // Default is silent; a previous explicit preference may be restored.
      audioPref = recall("audio_pref") || "manual";
      setSound(audioPref !== "off" && recall("sound") === true);
      $("#sound-btn").addEventListener("click", function () {
        setSound(!soundOn);
        if (soundOn && $("#welcome") && $("#welcome").parentElement) playClip("welcome");
      });

      // Voice answering is always listed on the welcome page, so respondents can see it.  Where the
      // browser has no speech recognition the option stays there, disabled, with the reason given.
      var vRadio = document.querySelector('input[name="voice-pref"][value="voice"]');
      if (vRadio && !voiceSupported()) {
        vRadio.disabled = true;
        if (vRadio.closest("label")) vRadio.closest("label").classList.add("is-off");
        var vnote = $(".voice-note");
        if (vnote) vnote.textContent = "Not available in this browser. Open this survey in Chrome, Edge or Safari to answer by voice.";
      }
      var vb = $("#voice-btn");
      if (vb && voiceSupported()) {
        vb.hidden = false;
        vb.addEventListener("click", function () { setVoice(!voiceOn); });
      }
      wireWelcomeAudio();
      setupLangPicker();
      applyWelcomeCopy();

      var savedSid = recall("session_id");
      var resume = savedSid
        ? fetch("/api/progress?sid=" + encodeURIComponent(savedSid)).then(function (r) { return r.json(); })
        : Promise.resolve({ exists: false });

      resume.then(function (prog) {
        if (prog.exists && prog.status === "complete") {
          ["session_id", "answers", "cur"].forEach(function (k) { store(k); });
          location.reload(); return;
        }
        if (prog.exists) {
          SESSION = { session_id: savedSid, respondent_code: prog.respondent_code,
                      task_order: prog.task_order, alt_positions: prog.alt_positions };
          answers = prog.answers || {};
          if (prog.elapsed_seconds) t0 = Date.now() - prog.elapsed_seconds * 1000;
          // Nothing answered yet: show the welcome page again so the choice of how to answer
          // (tap or voice) is offered before Q1.  The saved session itself is kept.
          afterSession(Object.keys(answers).length === 0);
        } else if (STUDY.paused) {
          showPaused();                      // nobody new starts while the study is paused
        } else {
          startFresh();
        }
      }).catch(startFresh);
    }).catch(function () {
      $("#app").innerHTML = '<div class="card"><h1>Unable to load</h1>' +
        "<p>The survey definition could not be retrieved. Please reload.</p></div>";
    });
  }

  function wireWelcomeAudio() {
    var btn = $("#welcome-play");
    var wave = $("#welcome-wave");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (narrator && !narrator.paused) { stopNarration(); return; }
      btn.classList.add("playing");
      wave.hidden = false;
      var a = playClip("welcome", function () {
        btn.classList.remove("playing");
        wave.hidden = true;
      });
      if (!a) { btn.classList.remove("playing"); wave.hidden = true; }
    });
  }

  function startFresh() {
    return fetch("/api/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_test: IS_TEST, study: STUDY.slug,
                             language: SPEC.render_language || LANG || "",
                             embedded: readEmbedded(), survey_version: SPEC.survey_version })
    }).then(function (r) { return r.json(); }).then(function (s) {
      if (s && s.paused) { showPaused(); return; }
      if (!s || !s.session_id) {
        $("#app").innerHTML = '<div class="card"><h1>Unable to start</h1><p>' +
          (s && s.error ? s.error : "The survey could not be started. Please reload.") + "</p></div>";
        return;
      }
      SESSION = s;
      answers = {};
      store("session_id", s.session_id);
      afterSession(true);
    });
  }

  // A paused study keeps its door closed to new respondents, but someone already answering
  // can reload this page and resume from their saved progress.
  function showPaused() {
    document.body.classList.remove("answering");
    $("#app").innerHTML =
      '<div class="card paused-card"><h1>This study is paused</h1>' +
      "<p>The research team has temporarily stopped new responses. Thank you for your interest - " +
      "please try again later.</p>" +
      '<p class="paused-resume">Already taking part? <a href="' + location.pathname +
      '">Continue where you left off</a>.</p>' +
      '<p class="paused-team">Part of the team? <a href="/survey/' + STUDY.slug +
      '/test">Open it in test mode</a> or find it in the <a href="/studio/#' + STUDY.slug +
      '">Studio</a>.</p></div>';
  }

  function afterSession(waitForClick) {
    buildSteps();
    testNotes = recall("test_notes") || {};
    if (IS_TEST) { try { reviewToken = new URLSearchParams(location.search).get("review") || ""; } catch(e) {}
      if (reviewToken) fetch('/api/test-review/'+encodeURIComponent(reviewToken)).then(function(r){return r.json();}).then(function(d){if(d.payload){answers=d.payload.answers||{};testNotes=d.payload.notes||{};cur=Math.min(Number(d.payload.current||0),steps.length-1);store('answers',answers);render();toastTest('Shared review loaded — answers and team notes restored.');}});
    }
    $("#respondent-code").textContent = (IS_TEST ? "TEST " : "") + SESSION.respondent_code;

    // the welcome facts and the always-available TPP card follow the active study
    var facts = document.querySelectorAll("#welcome .facts div strong");
    if (facts.length >= 2) {
      facts[0].textContent = String(SPEC.questions.length);
      facts[1].textContent = String(SPEC.conjoint ? SPEC.conjoint.n_tasks : 0);
    }
    var tpt = $("#tpp-body table");
    if (tpt && STUDY.slug !== "beacon") {
      // the reference panel mirrors the walkthrough scenes exactly (custom scenes included)
      var rows = (SCENES || []).filter(function (sc) { return (sc.caption || "").trim(); })
        .map(function (sc) { return [sc.title || "", sc.caption]; });
      if (!rows.length && SPEC.tpp) {
        var tp = SPEC.tpp;
        rows = [["Mechanism", tp.mechanism], ["Pivotal trial", tp.trial],
          ["Headline efficacy", tp.efficacy], ["Safety", tp.safety],
          ["Administration", tp.administration], ["Companion diagnostic", tp.cdx]];
      }
      tpt.innerHTML = "";
      rows.forEach(function (r) {
        var tr = document.createElement("tr");
        var th = document.createElement("th"); th.textContent = r[0];
        var td = document.createElement("td"); td.textContent = r[1] || "";
        tr.appendChild(th); tr.appendChild(td); tpt.appendChild(tr);
      });
    }
    if (IS_TEST) document.body.classList.add("testmode");
    $("#hud").hidden = !gamifyOn();
    $("#points").textContent = String(points);
    var rb = $("#rank-badge");
    if (rb) rb.textContent = rankFor(points);
    setInterval(tickClock, 1000); tickClock();

    $("#tpp-toggle").addEventListener("click", function () {
      var b = $("#tpp-body");
      b.hidden = !b.hidden;
      $("#tpp-toggle").innerHTML = "Target product profile " + (b.hidden ? "&#9662;" : "&#9652;");
    });
    $("#tpp-replay").addEventListener("click", function () { runExplainer(SCENES, function () {}); });
    $("#ex-close").addEventListener("click", dismissExplainer);

    window.addEventListener("beforeunload", function () {
      store("answers", answers); store("cur", cur);
    });
    setInterval(function () { store("answers", answers); store("cur", cur); }, 8000);

    var privacy = document.getElementById('study-privacy');
    if (privacy) {
      privacy.innerHTML = '<p>Estimated time: ' + escHtml(SPEC.estimated_minutes || '—') + ' minutes.</p>' +
        (SPEC.privacy_notice ? '<p>' + escHtml(SPEC.privacy_notice) + '</p>' : '') +
        (SPEC.research_contact ? '<p>Research contact: ' + escHtml(SPEC.research_contact) + '</p>' : '') +
        (SPEC.require_consent ? '<label class="survey-consent"><input id="consent-choice" type="checkbox"> ' + escHtml(SPEC.consent_statement) + '</label>' : '');
    }
    if (waitForClick) {
      if (!steps.length) { $('#start-btn').disabled = true; $('#start-btn').textContent = 'No questions yet — add questions in Studio'; return; }
      $("#start-btn").addEventListener("click", async function () {
        if (SPEC.require_consent) {
          if (!$('#consent-choice') || !$('#consent-choice').checked) { coachSay('Please read the notice and confirm your consent before continuing.', 'warn'); return; }
          this.disabled = true;
          try {
            var consentResponse = await fetch('/api/consent', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({session_id:SESSION.session_id,accepted:true})});
            if (!consentResponse.ok) throw new Error('Consent could not be saved');
          } catch(e) { this.disabled = false; coachSay('Could not record consent. Check your connection and try again.', 'warn'); return; }
        }
        var pref = document.querySelector('input[name="audio-pref"]:checked');
        audioPref = pref ? pref.value : "manual";
        store("audio_pref", audioPref); setSound(audioPref !== "off");
        var vpref = document.querySelector('input[name="voice-pref"]:checked');
        store("voice_pref", vpref ? vpref.value : "manual");
        if (vpref && vpref.value === "voice") setVoice(true);
        t0 = Date.now();
        $("#welcome").remove();
        stopNarration();
        cur = 0;
        render();
        onEnterSection(sectionOf(steps[0].q));
      });
    } else {
      $("#welcome").remove();
      var last = recall("cur");
      cur = (typeof last === "number" && last < steps.length) ? last : 0;
      // mark earlier sections as seen so a resumed session does not replay their narration
      for (var i = 0; i < cur; i++) seenSections[steps[i].q.section] = true;
      render();
    }
  }

  // ============================================================ Studio preview hook
  // Renders one question with the very same code respondents get. `ctx.answers` supplies
  // earlier answers for piping / show-if; nothing is persisted.
  window.BeaconSurveyPreview = {
    render: function (host, q, ctx, seed) {
      SPEC = { questions: ctx.questions || [q], sections: ctx.sections || [], narration: {}, use_tts: false };
      SESSION = { session_id: seed || "preview", respondent_code: "PREVIEW" };
      NARR = {}; SCENES = [];
      answers = JSON.parse(JSON.stringify(ctx.answers || {}));
      delete answers[q.id];
      host.innerHTML = "";
      var card;
      try { card = renderQuestion(q); }
      catch (e) { card = el("div", "card"); card.textContent = "Cannot render: " + e.message; }
      host.appendChild(card);
      var err = el("div", "err prev-err"); host.appendChild(err);
      var check = el("button", "btn primary", "Check answer &rarr;"); check.type = "button";
      check.addEventListener("click", function () {
        steps = [{ kind: "q", q: q }]; cur = 0;
        if (validateStep()) { hideErr(); err.textContent = "\u2713 Valid - respondent could continue. Stored: " + JSON.stringify(answers[q.id] || {}); err.classList.add("show", "ok"); }
        else err.classList.remove("ok");
      });
      host.appendChild(check);
      // report unresolved piping tokens
      var un = (host.textContent.match(/\u2026/g) || []).length;
      var toks = [];
      JSON.stringify(q).replace(/\{([A-Za-z0-9_]+)(?:\.[A-Za-z0-9_:]+)?\}/g, function (m, qid) {
        if (window.BeaconQ && window.BeaconQ.pipe(m, { answers: answers, questions: SPEC.questions }, "") === "") toks.push(m); return m; });
      return { unresolved: toks, ellipses: un };
    }
  };

  if (PREVIEW) return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
