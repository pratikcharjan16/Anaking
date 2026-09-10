/* BEACON Studio - multi-study survey builder. */
(function () {
  "use strict";
  // Auth: signed-in session cookie (see /login). A ?token= in the URL is still honoured
  // for bookmarks and is appended to every request when present.
  var TOKEN = (location.search.match(/token=([^&]+)/) || [])[1] || "";
  var TQ = TOKEN ? "&token=" + encodeURIComponent(TOKEN) : "";     // query-string suffix
  var root = document.getElementById("st-root");
  var drawer = document.getElementById("st-drawer");
  var cur = null;          // {slug,title,status,cfg}
  var tab = "questions";

  function needSignIn() {
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search + location.hash);
  }
  function api(path, body) {
    return fetch(path + (TQ ? (path.indexOf("?") < 0 ? "?" : "&") + TQ.slice(1) : ""), {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 403) { needSignIn(); throw new Error("not signed in"); }
      return r.json();
    });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function toast(msg) {
    var t = document.getElementById("st-toast");
    t.textContent = msg;
    t.hidden = false;
    setTimeout(function () { t.hidden = true; }, 2600);
  }
  // ------------------------------------------------------------ question templates
  var TYPES = ["single_select", "multi_select", "numeric", "slider", "open_text",
    "rating_grid", "semantic_diff", "sum_to_100", "rank", "nps", "emoji_grid",
    "heatmap", "maxdiff", "choice_task"];

  function qTemplate(type, id, secId) {
    var q = { id: id, section: secId, type: type, required: true,
              stem: "New " + type.replace(/_/g, " ") + " question" };
    if (type === "single_select" || type === "multi_select") {
      q.options = [{ code: 1, label: "Option one" }, { code: 2, label: "Option two" },
                   { code: 3, label: "Option three" }];
      if (type === "multi_select") q.max_select = 3;
    }
    if (type === "numeric") { q.min = 0; q.max = 100; }
    if (type === "slider") { q.min = 0; q.max = 100; q.step = 5; }
    if (type === "open_text") { q.min_words = 3; }
    if (type === "rating_grid") {
      q.scale = { min: 1, max: 7, min_label: "Not at all", max_label: "Extremely" };
      q.rows = [{ code: "a", label: "First item" }, { code: "b", label: "Second item" }];
    }
    if (type === "semantic_diff") {
      q.scale = { min: 1, max: 7 };
      q.rows = [{ code: "a", label: "First item", left: "Poor", right: "Excellent" }];
    }
    if (type === "sum_to_100") {
      q.rows = [{ code: "a", label: "First item" }, { code: "b", label: "Second item" }];
    }
    if (type === "rank") {
      q.rank_count = 3;
      q.rows = [{ code: "a", label: "First item" }, { code: "b", label: "Second item" },
                { code: "c", label: "Third item" }];
    }
    if (type === "nps") { q.scale = { min: 0, max: 10 }; }
    if (type === "emoji_grid") {
      q.scale = { min: 1, max: 5, faces: ["😞", "", "😐", "🙂", "😍"],
                  face_labels: ["Very negative", "Negative", "Neutral", "Positive", "Delighted"] };
      q.rows = [{ code: "a", label: "First impression" }];
    }
    if (type === "heatmap") {
      q.rows = [{ code: "a", label: "First row" }];
      q.cols = [{ code: "c1", label: "Column one" }, { code: "c2", label: "Column two" }];
      q.heat_max = 3;
    }
    if (type === "maxdiff") {
      q.rounds = [{ items: ["a", "b", "c", "d"] }];
    }
    if (type === "choice_task") { q.vignette = "Describe the patient here."; }
    return q;
  }

  function blankCfg() {
    return {
      title: "New study",
      sections: [{ id: "S1", title: "Introduction", blurb: null },
                 { id: "S2", title: "Main questions", blurb: null }],
      questions: [
        qTemplate("single_select", "N1", "S1"),
        qTemplate("rating_grid", "N2", "S2"),
        qTemplate("nps", "N3", "S2"),
        qTemplate("open_text", "N4", "S2")
      ],
      tpp: { patient: "", mechanism: "", trial: "", efficacy: "", safety: "",
             administration: "", cdx: "" },
      narration: {},
      explainer_scenes: [],
      conjoint_scene: null,
      conjoint: null,
      conjoint_min_dwell: 10,
      use_tts: true,
      metrics: {},
      qc: { min_seconds: 300, verbatim_qs: [] }
    };
  }

  // ------------------------------------------------------------ list view
  function loadList() {
    api("/api/studio/list").then(function (list) {
      cur = null;
      var html = '<div class="st-grid">';
      list.forEach(function (s) {
        html += '<div class="st-card">' +
          '<div style="display:flex;justify-content:space-between;gap:8px;align-items:start">' +
          "<h3>" + esc(s.title) + '</h3><span class="st-pill ' + s.status + '">' + s.status +
          "</span></div>" +
          '<div class="st-meta">/' + esc(s.slug) + " &middot; " + s.started + " started, " +
          s.complete + " complete &middot; updated " + esc(s.updated_at || "") + "</div>" +
          '<div class="st-card-actions">' +
          '<button class="st-btn" data-act="open" data-slug="' + esc(s.slug) + '">Open builder</button>' +
          (s.status === "live"
            ? '<button class="st-btn bad" data-act="status" data-status="closed" data-slug="' + esc(s.slug) + '">Close</button>'
            : '<button class="st-btn good" data-act="status" data-status="live" data-slug="' + esc(s.slug) + '">Launch live</button>') +
          '<button class="st-btn" data-act="dup" data-slug="' + esc(s.slug) + '">Duplicate</button>' +
          (s.slug !== "beacon"
            ? '<button class="st-btn bad" data-act="del" data-slug="' + esc(s.slug) + '">Delete</button>'
            : "") +
          "</div>" +
          '<div class="st-link">live: /survey/' + esc(s.slug) + " &middot; test: /survey/" + esc(s.slug) +
          "/test</div></div>";
      });
      html += "</div>";
      root.innerHTML = html;
    });
  }

  // ------------------------------------------------------------ editor
  function openEditor(slug) {
    api("/api/studio/study?slug=" + encodeURIComponent(slug))
      .then(function (s) {
        if (s.error) { toast("Study not found: /" + slug); loadList(); return; }
        cur = s; tab = "questions"; renderEditor();
        if (location.hash !== "#" + slug) history.replaceState(null, "", location.pathname + location.search + "#" + slug);
      });
  }

  function saveStudy(cb) {
    api("/api/studio/save", { slug: cur.slug, title: cur.title, cfg: cur.cfg })
      .then(function (r) {
        if (r.error) toast("Save failed: " + r.error);
        else {
          toast("Saved");
          var d = document.getElementById("tpp-dirty"); if (d) d.hidden = true;
          if (cb) cb();
        }
      });
  }

  function renderEditor() {
    var c = cur.cfg;
    var html = '<div class="st-edhead">' +
      '<button class="st-btn" data-act="back">&larr; Studies</button>' +
      '<input type="text" id="ed-title" value="' + esc(cur.title) + '">' +
      '<select id="ed-status" class="st-btn">' +
      ["draft", "live", "closed"].map(function (s) {
        return '<option value="' + s + '"' + (s === cur.status ? " selected" : "") + ">" + s +
          "</option>";
      }).join("") + "</select>" +
      '<button class="st-btn on" data-act="save">Save study</button>' +
      '<button class="st-btn" data-act="viewlive">Open respondent link</button>' +
      "</div>" +
      '<div class="st-tabs">' +
      [["questions", "Questions (" + c.questions.length + ")"],
       ["tpp", "TPP & walkthrough"], ["conjoint", "Conjoint"],
       ["settings", "Settings & QC"], ["responses", "Responses"],
       ["analysis", "Analysis"]].map(function (t) {
        return '<button class="st-tab' + (tab === t[0] ? " on" : "") + '" data-tab="' + t[0] +
          '">' + t[1] + "</button>";
      }).join("") + "</div>" +
      '<div class="st-panel" id="st-panel"></div>';
    root.innerHTML = html;
    renderTab();
  }

  function renderTab() {
    var p = document.getElementById("st-panel");
    if (tab === "questions") p.innerHTML = questionsTab();
    if (tab === "tpp") { p.innerHTML = tppTab(); renderScenePrev(); }
    if (tab === "conjoint") p.innerHTML = conjointTab();
    if (tab === "settings") p.innerHTML = settingsTab();
    if (tab === "responses") { p.innerHTML = "<p>Loading responses…</p>"; responsesTab(p); }
    if (tab === "analysis") { p.innerHTML = "<p>Computing analysis…</p>"; analysisTab(p); }
  }

  // ------------------------------------------------------------ questions tab
  function lines(rows, extra) {
    return (rows || []).map(function (r) {
      return r.code + "|" + r.label + (extra ? "|" + (r.left || "") + "|" + (r.right || "") : "");
    }).join("\n");
  }
  function parseLines(txt, four) {
    return String(txt || "").split("\n").map(function (l) { return l.trim(); })
      .filter(Boolean).map(function (l, i) {
        var p = l.split("|");
        var o = { code: (p[0] || "").trim() || String(i + 1), label: (p[1] || p[0] || "").trim() };
        if (four) { o.left = (p[2] || "").trim(); o.right = (p[3] || "").trim(); }
        return o;
      });
  }

  function questionsTab() {
    var c = cur.cfg;
    var html = "";
    c.sections.forEach(function (sec, si) {
      html += '<div class="st-sec"><div class="st-sec-head">' +
        '<input value="' + esc(sec.title) + '" data-sec-title="' + si + '">' +
        '<span class="st-meta">' + esc(sec.id) + "</span>" +
        '<button class="st-ibtn" title="Delete section" data-act="delsec" data-i="' + si +
        '">&#10005;</button></div>';
      c.questions.forEach(function (q, qi) {
        if (q.section !== sec.id) return;
        html += '<div class="st-qrow"><span class="qid">' + esc(q.id) + "</span>" +
          '<span class="qtype">' + esc(q.type) + "</span>" +
          '<span class="qstem">' + esc(q.stem) + "</span>" +
          (q.show_if && q.show_if.rules && q.show_if.rules.length ? '<span class="st-badge" title="Has show-if logic">logic</span>' : "") +
          (q.randomize && q.randomize !== "none" ? '<span class="st-badge" title="Randomised">rnd</span>' : "") +
          (q.media && q.media.src ? '<span class="st-badge" title="Has image/video">media</span>' : "") +
          ((q.options || []).some(function (o) { return o.exclusive; }) ? '<span class="st-badge" title="Has an exclusive option">excl</span>' : "") +
          '<button class="st-ibtn" data-act="qtest" data-i="' + qi + '" title="Test view">&#9654;</button>' +
          '<button class="st-ibtn" data-act="qup" data-i="' + qi + '" title="Move up">&#9650;</button>' +
          '<button class="st-ibtn" data-act="qdown" data-i="' + qi + '" title="Move down">&#9660;</button>' +
          '<button class="st-ibtn" data-act="qedit" data-i="' + qi + '" title="Edit">&#9998;</button>' +
          '<button class="st-ibtn" data-act="qdel" data-i="' + qi + '" title="Delete">&#10005;</button>' +
          "</div>";
      });
      html += '<div style="padding:10px 12px;display:flex;gap:8px;align-items:center">' +
        '<select id="addtype-' + si + '" class="st-btn">' +
        TYPES.map(function (t) { return "<option>" + t + "</option>"; }).join("") +
        "</select>" +
        '<button class="st-btn" data-act="qadd" data-sec="' + esc(sec.id) + '" data-si="' + si +
        '">+ Add question</button></div></div>';
    });
    html += '<button class="st-btn" data-act="addsec">+ Add section</button>';
    return html;
  }

  // ------------------------------------------------------------ question editor (drawer)
  // The editor works on a deep copy (`ed`) of the question; the copy is written back to the
  // study only when "Apply" is pressed. The right-hand pane renders the question exactly as a
  // respondent would see it, from the same copy, so every change previews live.
  var ed = null, edQi = -1, edTab = "content";
  var Q = window.BeaconQ;

  var OPS = [["selected", "has selected"], ["not_selected", "has not selected"],
    ["any_of", "selected any of (codes a,b)"], ["none_of", "selected none of (codes a,b)"],
    ["eq", "equals"], ["ne", "does not equal"], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"],
    ["contains", "answer text contains"], ["answered", "was answered"], ["not_answered", "was skipped"],
    ["row_eq", "row rating equals (row=value)"]];
  var FONTS = [["", "Default"], ["Georgia, serif", "Georgia (serif)"], ["'Times New Roman', serif", "Times New Roman"],
    ["Arial, Helvetica, sans-serif", "Arial"], ["Verdana, sans-serif", "Verdana"], ["'Trebuchet MS', sans-serif", "Trebuchet"],
    ["'Courier New', monospace", "Courier (mono)"]];
  var SIZES = [["", "Default"], ["15px", "Small"], ["19px", "Normal"], ["22px", "Large"], ["26px", "X-Large"], ["32px", "Huge"]];

  function hasOptions(t) { return t === "single_select" || t === "multi_select"; }
  function hasRows(t) { return ["rating_grid", "semantic_diff", "sum_to_100", "rank", "emoji_grid", "heatmap"].indexOf(t) >= 0; }

  function openQuestionDrawer(qi) {
    var c = cur.cfg;
    edQi = qi;
    ed = JSON.parse(JSON.stringify(qi === -1 ? qTemplate("single_select", "N" + (c.questions.length + 1), c.sections[0].id)
                                              : c.questions[qi]));
    if (!ed.stem_html) ed.stem_html = esc(ed.stem || "");
    edTab = "content";
    drawer.classList.add("wide");
    renderDrawer();
    drawer.hidden = false;
    requestAnimationFrame(function () { drawer.classList.add("open"); });
  }

  function renderDrawer() {
    var tabs = [["content", "Content"], ["answers", hasOptions(ed.type) ? "Answers" : hasRows(ed.type) ? "Rows" : "Settings"],
                ["logic", "Show-if logic" + (ed.show_if && ed.show_if.rules && ed.show_if.rules.length ? " ●" : "")],
                ["media", "Image / video" + (ed.media && ed.media.src ? " ●" : "")], ["advanced", "Advanced"]];
    drawer.innerHTML =
      '<div class="st-ed">' +
        '<div class="st-ed-form">' +
          '<div class="st-ed-head"><h3>' + (edQi === -1 ? "New question" : "Edit " + esc(ed.id)) + "</h3>" +
            '<span class="st-pill draft">' + esc(ed.type) + "</span></div>" +
          '<div class="st-tabs st-tabs-sm">' + tabs.map(function (t) {
            return '<button class="st-tab' + (edTab === t[0] ? " on" : "") + '" data-edtab="' + t[0] + '">' + t[1] + "</button>";
          }).join("") + "</div>" +
          '<div id="st-pipe-pop" class="st-pipe-pop" hidden></div>' +
          '<div id="st-ed-body">' + drawerBody() + "</div>" +
          '<div class="st-draw-actions"><button class="st-btn on" data-act="qsave" data-qi="' + edQi + '">Apply to study</button>' +
            '<button class="st-btn" data-act="qclose">Cancel</button>' +
            '<span class="st-meta" style="margin-left:auto">Then press <b>Save study</b> to publish</span></div>' +
        "</div>" +
        '<div class="st-ed-prev"><div class="st-ed-prev-head"><span>Test view - what respondents see</span>' +
          '<label class="st-inline"><input type="checkbox" id="prev-sample" checked> sample answers for piping</label>' +
          '<button class="st-btn sm" data-act="prev-reshuffle" title="New random order">&#8635; reshuffle</button></div>' +
          '<div id="st-ed-prev-body" class="survey-skin"></div>' +
          '<div id="st-ed-prev-note" class="st-note"></div></div>' +
      "</div>";
    renderPreview();
  }

  function drawerBody() {
    var c = cur.cfg, t = ed.type;
    if (edTab === "content") return contentTab(c, t);
    if (edTab === "answers") return answersTab(t);
    if (edTab === "logic") return logicTab(c);
    if (edTab === "media") return mediaTab();
    return advancedTab();
  }

  // ---- Content tab: rich text toolbar + piping ---------------------------------------
  function contentTab(c, t) {
    var st = ed.style || {};
    return '<div class="st-grid2">' +
      '<div class="st-field"><label>Question id</label><input id="f-id" value="' + esc(ed.id) + '"></div>' +
      '<div class="st-field"><label>Section</label><select id="f-section">' +
        c.sections.map(function (s) { return '<option value="' + esc(s.id) + '"' + (ed.section === s.id ? " selected" : "") + ">" + esc(s.title) + "</option>"; }).join("") +
      "</select></div>" +
      (edQi === -1 ? '<div class="st-field"><label>Type</label><select id="f-type">' + TYPES.map(function (x) {
        return "<option" + (x === t ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></div>" : "") +
      "</div>" +
      '<div class="st-field"><label>Question text</label>' + richToolbar("f-stem-rich") +
        '<div class="st-rich" id="f-stem-rich" contenteditable="true" data-rich="stem_html">' + chipify(Q.sanitize(ed.stem_html || "")) + "</div>" +
        '<div class="st-meta">Select text and use the toolbar to format it. Use <b>&#10132; Pipe in answer</b> to insert something a respondent said earlier - e.g. <code>{Q1}</code> becomes their Q1 answer.</div></div>' +
      '<div class="st-grid3">' +
        '<div class="st-field"><label>Font</label><select id="f-font">' + FONTS.map(function (f) { return '<option value="' + esc(f[0]) + '"' + (st.font === f[0] ? " selected" : "") + ">" + f[1] + "</option>"; }).join("") + "</select></div>" +
        '<div class="st-field"><label>Size</label><select id="f-size">' + SIZES.map(function (f) { return '<option value="' + f[0] + '"' + (st.size === f[0] ? " selected" : "") + ">" + f[1] + "</option>"; }).join("") + "</select></div>" +
        '<div class="st-field"><label>Align</label><select id="f-align">' + [["", "Left"], ["center", "Centre"], ["right", "Right"]].map(function (f) { return '<option value="' + f[0] + '"' + ((st.align || "") === f[0] ? " selected" : "") + ">" + f[1] + "</option>"; }).join("") + "</select></div>" +
      "</div>" +
      '<div class="st-field"><label>Help text (optional)</label>' + richToolbar("f-help-rich", true) +
        '<div class="st-rich sm" id="f-help-rich" contenteditable="true" data-rich="help_html">' + chipify(Q.sanitize(ed.help_html || esc(ed.help || ""))) + "</div></div>" +
      '<div class="st-inline-row">' +
        '<label class="st-inline"><input type="checkbox" id="f-required"' + (ed.required !== false ? " checked" : "") + "> Required</label>" +
        '<label class="st-inline"><input type="checkbox" id="f-hidenum"' + (ed.hide_number ? " checked" : "") + "> Hide question number</label>" +
      "</div>";
  }

  function richToolbar(target, small) {
    var b = function (cmd, label, title, val) {
      return '<button type="button" class="st-tb" data-cmd="' + cmd + '" data-val="' + (val || "") + '" data-target="' + target + '" title="' + title + '">' + label + "</button>";
    };
    return '<div class="st-toolbar">' +
      b("bold", "<b>B</b>", "Bold") + b("italic", "<i>I</i>", "Italic") + b("underline", "<u>U</u>", "Underline") +
      b("strikeThrough", "<s>S</s>", "Strikethrough") + b("superscript", "x<sup>2</sup>", "Superscript") +
      '<span class="st-tb-sep"></span>' +
      '<label class="st-tb st-tb-color" title="Text colour">A<input type="color" data-cmd="foreColor" data-target="' + target + '" value="#b3261e"></label>' +
      '<label class="st-tb st-tb-color hl" title="Highlight colour">&#9639;<input type="color" data-cmd="hiliteColor" data-target="' + target + '" value="#fff3a3"></label>' +
      b("removeFormat", "T&#818;", "Clear formatting") +
      '<span class="st-tb-sep"></span>' +
      b("insertUnorderedList", "&#8226; list", "Bulleted list") + b("insertOrderedList", "1. list", "Numbered list") +
      (small ? "" : b("fontSize", "A&#8593;", "Bigger", "5") + b("fontSize", "A&#8595;", "Smaller", "2")) +
      '<span class="st-tb-sep"></span>' +
      pipeButton(target) +
      "</div>";
  }

  // show {Q1} tokens as chips inside the rich editors (plain text again once saved)
  function chipify(html) {
    var tpl = document.createElement("template"); tpl.innerHTML = html;
    var walker = document.createTreeWalker(tpl.content, 4), nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (n) {
      if (!/\{[A-Za-z0-9_]+(\.[A-Za-z0-9_:]+)?\}/.test(n.nodeValue)) return;
      if (n.parentNode && n.parentNode.classList && n.parentNode.classList.contains("pipe")) return;
      var frag = document.createDocumentFragment();
      n.nodeValue.split(/(\{[A-Za-z0-9_]+(?:\.[A-Za-z0-9_:]+)?\})/).forEach(function (part) {
        if (/^\{[A-Za-z0-9_]+(\.[A-Za-z0-9_:]+)?\}$/.test(part)) {
          var sp = document.createElement("span"); sp.className = "pipe"; sp.setAttribute("contenteditable", "false"); sp.textContent = part; frag.appendChild(sp);
        } else if (part) frag.appendChild(document.createTextNode(part));
      });
      n.parentNode.replaceChild(frag, n);
    });
    var d = document.createElement("div"); d.appendChild(tpl.content); return d.innerHTML;
  }

  function unchip(html) { return html.replace(/<span class="pipe">(\{[^}]+\})<\/span>(?:&nbsp;|\u00a0)?/g, "$1 "); }

  // "Pipe in" button - one per text field. Opens the pipe picker for that field.
  function pipeButton(target, small) {
    return '<button type="button" class="st-pipe-btn' + (small ? " sm" : "") + '" data-pipe-for="' + target + '" title="Insert an earlier answer into this text">' +
      '&#10132; Pipe in answer</button>';
  }

  // ---- pipe picker ------------------------------------------------------------------------
  // Grouped by earlier question, plain-English choices, live example from the sample answers.
  var pipeTarget = null, pipeCaret = null;

  function isRichField(el) { return !!el && !/^(INPUT|TEXTAREA)$/.test(el.tagName); }
  function rememberCaret(target) {
    if (isRichField(target)) {
      var sel = window.getSelection();
      if (sel.rangeCount && target.contains(sel.anchorNode)) pipeCaret = sel.getRangeAt(0).cloneRange();
      else pipeCaret = null;
    } else pipeCaret = { start: target.selectionStart, end: target.selectionEnd };
  }

  function openPipePicker(target) {
    pipeTarget = target;
    if (!pipeCaret) rememberCaret(target);
    var earlier = [];
    for (var i = 0; i < cur.cfg.questions.length; i++) {
      var q = cur.cfg.questions[i];
      if (q.id === ed.id) break;
      if (q.type !== "choice_task") earlier.push(q);
    }
    var sample = { answers: Q.sampleAnswers(cur.cfg.questions, ed.id), questions: cur.cfg.questions };
    var ex = function (tok) { var v = Q.pipe(tok, sample, ""); return v ? '<span class="st-pipe-ex">e.g. "' + esc(v.slice(0, 60)) + '"</span>' : ""; };
    var row = function (tok, label) {
      return '<button type="button" class="st-pipe-item" data-token="' + esc(tok) + '"><b>' + esc(label) + '</b><code>' + esc(tok) + "</code>" + ex(tok) + "</button>";
    };
    var html = '<div class="st-pipe-head"><strong>Pipe in an earlier answer</strong>' +
      '<span class="st-meta">Click an item to insert it where your cursor was. Respondents see their own answer in its place.</span>' +
      '<button type="button" class="ex-close" data-act="pipe-close">&times;</button></div>' +
      '<input class="st-pipe-search" placeholder="Search questions…" autofocus>';
    if (!earlier.length) html += '<div class="st-note">No earlier questions yet - piping pulls answers from questions that come <em>before</em> this one.</div>';
    earlier.forEach(function (q) {
      html += '<details class="st-pipe-q" open><summary><span class="qid">' + esc(q.id) + "</span> " + esc(String(q.stem).slice(0, 90)) + "</summary><div class=\"st-pipe-list\">";
      html += row("{" + q.id + "}", "Their answer (as text)");
      if (q.options && q.options.length) {
        if (q.type === "multi_select") { html += row("{" + q.id + ".first}", "First option they ticked") + row("{" + q.id + ".last}", "Last option they ticked"); }
        html += row("{" + q.id + ".code}", "Answer code (number)");
        if (q.options.some(function (o) { return o.other; })) html += row("{" + q.id + ".other}", "Text typed in 'Other'");
        html += '<div class="st-pipe-sub">A fixed option label (does not depend on their answer)</div>';
        q.options.forEach(function (o) { html += row("{" + q.id + ".opt:" + o.code + "}", "Option " + o.code + ": " + String(o.label).slice(0, 50)); });
      }
      if (q.rows && q.rows.length) {
        html += '<div class="st-pipe-sub">Rows</div>';
        q.rows.forEach(function (r) {
          if (q.scale) html += row("{" + q.id + ".r:" + r.code + "}", "Their rating for: " + String(r.label).slice(0, 45));
          html += row("{" + q.id + ".row:" + r.code + "}", "Row label: " + String(r.label).slice(0, 50));
        });
      }
      html += row("{" + q.id + ".stem}", "The question text itself");
      html += "</div></details>";
    });
    var pop = document.getElementById("st-pipe-pop");
    pop.innerHTML = html;
    pop.hidden = false;
    var srch = pop.querySelector(".st-pipe-search");
    srch.addEventListener("input", function () {
      var t = srch.value.toLowerCase();
      pop.querySelectorAll(".st-pipe-q").forEach(function (d) {
        var hit = !t || d.textContent.toLowerCase().indexOf(t) >= 0; d.style.display = hit ? "" : "none"; d.open = true;
      });
    });
    setTimeout(function () { srch.focus(); }, 30);
  }

  function insertPipe(tok) {
    var t = pipeTarget; if (!t) return;
    if (isRichField(t)) {
      t.focus();
      var sel = window.getSelection();
      var range = pipeCaret;
      if (!range || !t.contains(range.startContainer)) { range = document.createRange(); range.selectNodeContents(t); range.collapse(false); }
      sel.removeAllRanges(); sel.addRange(range);
      range.deleteContents();
      var node = document.createElement("span");
      node.className = "pipe"; node.setAttribute("contenteditable", "false"); node.textContent = tok;
      range.insertNode(node);
      var space = document.createTextNode("\u00a0");
      node.parentNode.insertBefore(space, node.nextSibling);
      range.setStartAfter(space); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    } else {
      var v = t.value, a = pipeCaret ? pipeCaret.start : v.length, b = pipeCaret ? pipeCaret.end : v.length;
      if (a == null) a = b = v.length;
      t.value = v.slice(0, a) + tok + v.slice(b);
      t.focus(); t.selectionStart = t.selectionEnd = a + tok.length;
      t.dispatchEvent(new Event("input", { bubbles: true }));
    }
    closePipePicker();
    syncFromForm(); renderPreview();
    toast("Inserted " + tok);
  }
  function closePipePicker() { var pop = document.getElementById("st-pipe-pop"); if (pop) pop.hidden = true; pipeTarget = null; pipeCaret = null; }

  // ---- Answers tab: options / rows table, randomisation, exclusive ---------------------
  function answersTab(t) {
    var html = "";
    if (hasOptions(t)) {
      html += '<div class="st-field"><label>Answer options</label>' +
        '<table class="st-opts"><thead><tr><th style="width:52px">Code</th><th>Label</th><th title="Never moves when randomised">Pin</th>' +
        '<th title="Selecting this clears every other answer (None / Not applicable)">Exclusive</th><th title="Adds a free-text box">Other</th><th></th></tr></thead><tbody>' +
        (ed.options || []).map(function (o, i) {
          return '<tr data-oi="' + i + '"><td><input data-opt="code" data-oi="' + i + '" value="' + esc(o.code) + '"></td>' +
            '<td><div class="st-with-pipe"><input id="f-opt-' + i + '" data-opt="label" data-oi="' + i + '" value="' + esc(o.label) + '" placeholder="Label">' + pipeButton("f-opt-" + i, true) + "</div>" +
            (o.image ? '<div class="st-meta">image: ' + esc(o.image.split("/").pop()) + ' <button class="st-x" data-act="opt-img-del" data-oi="' + i + '">&times;</button></div>' : "") + "</td>" +
            '<td><input type="checkbox" data-opt="pin" data-oi="' + i + '"' + (o.pin ? " checked" : "") + "></td>" +
            '<td><input type="checkbox" data-opt="exclusive" data-oi="' + i + '"' + (o.exclusive ? " checked" : "") + "></td>" +
            '<td><input type="checkbox" data-opt="other" data-oi="' + i + '"' + (o.other ? " checked" : "") + "></td>" +
            '<td class="st-opt-tools"><button class="st-ibtn" data-act="opt-up" data-oi="' + i + '" title="Move up">&#9650;</button>' +
            '<button class="st-ibtn" data-act="opt-down" data-oi="' + i + '" title="Move down">&#9660;</button>' +
            '<label class="st-ibtn" title="Attach an image to this option">&#128444;<input type="file" accept="image/*" data-act="opt-img" data-oi="' + i + '" hidden></label>' +
            '<button class="st-ibtn" data-act="opt-del" data-oi="' + i + '" title="Delete">&#10005;</button></td></tr>';
        }).join("") + "</tbody></table>" +
        '<div class="st-inline-row"><button class="st-btn sm" data-act="opt-add">+ Add option</button>' +
        '<button class="st-btn sm" data-act="opt-add-none">+ Add "None of these" (exclusive)</button>' +
        '<button class="st-btn sm" data-act="opt-add-na">+ Add "Not applicable" (exclusive)</button>' +
        '<button class="st-btn sm" data-act="opt-add-other">+ Add "Other (please specify)"</button>' +
        '<button class="st-btn sm" data-act="opt-bulk">Paste list…</button></div></div>';
      if (t === "multi_select") html += '<div class="st-grid2"><div class="st-field"><label>Max selections (blank = unlimited)</label><input id="f-maxselect" type="number" min="1" value="' + (ed.max_select || "") + '"></div>' +
        '<div class="st-field"><label>Layout</label>' + layoutSelect("grid") + "</div></div>";
      else html += '<div class="st-field"><label>Layout</label>' + layoutSelect("list") + "</div>";
      html += '<label class="st-inline"><input type="checkbox" id="f-hidecodes"' + (ed.hide_codes ? " checked" : "") + "> Hide option codes (1., 2., …) from respondents</label>";
      html += randomizeBlock("options");
    }
    if (hasRows(t)) {
      html += '<div class="st-field"><label>Rows / items (code | label' + (t === "semantic_diff" ? " | left pole | right pole" : "") + ' per line)</label>' +
        '<textarea id="f-rows" style="min-height:120px">' + lines(ed.rows, t === "semantic_diff") + "</textarea>" +
        '<div class="st-inline-row">' + pipeButton("f-rows", true) + '<span class="st-meta">Prefix a line with <code>*</code> to pin it in place when rows are randomised.</span></div></div>';
      html += randomizeBlock("rows");
    }
    if (t === "rating_grid" || t === "semantic_diff" || t === "nps") {
      var sc = ed.scale || {};
      html += '<div class="st-grid2"><div class="st-field"><label>Scale min / max</label><div class="st-inline-row">' +
        '<input id="f-smin" type="number" value="' + (sc.min != null ? sc.min : 1) + '" style="width:80px"> <input id="f-smax" type="number" value="' + (sc.max != null ? sc.max : 7) + '" style="width:80px"></div></div>' +
        '<div class="st-field"><label>End labels (min / max)</label><div class="st-inline-row"><input id="f-sminl" value="' + esc(sc.min_label || "") + '"> <input id="f-smaxl" value="' + esc(sc.max_label || "") + '"></div></div></div>';
    }
    if (t === "numeric" || t === "slider") {
      html += '<div class="st-grid3"><div class="st-field"><label>Min</label><input id="f-min" type="number" value="' + (ed.min != null ? ed.min : 0) + '"></div>' +
        '<div class="st-field"><label>Max</label><input id="f-max" type="number" value="' + (ed.max != null ? ed.max : 100) + '"></div>' +
        (t === "slider" ? '<div class="st-field"><label>Step</label><input id="f-step" type="number" value="' + (ed.step || 1) + '"></div>' : "") + "</div>" +
        '<div class="st-grid2"><div class="st-field"><label>Prefix (e.g. $)</label><input id="f-prefix" value="' + esc(ed.prefix || "") + '"></div>' +
        '<div class="st-field"><label>Suffix (e.g. %)</label><input id="f-suffix" value="' + esc(ed.suffix || "") + '"></div></div>';
    }
    if (t === "open_text") {
      html += '<div class="st-grid2"><div class="st-field"><label>Minimum words</label><input id="f-minwords" type="number" value="' + (ed.min_words || 3) + '"></div>' +
        '<div class="st-field"><label>Placeholder</label><div class="st-with-pipe"><input id="f-placeholder" value="' + esc(ed.placeholder || "") + '">' + pipeButton("f-placeholder", true) + "</div></div></div>";
    }
    if (t === "rank") html += '<div class="st-field"><label>Top-N recorded</label><input id="f-rankcount" type="number" value="' + (ed.rank_count || 3) + '"></div>';
    if (t === "heatmap") html += '<div class="st-field"><label>Columns (code|label per line)</label><textarea id="f-cols">' + lines(ed.cols) + "</textarea></div>";
    if (t === "maxdiff") html += '<div class="st-field"><label>Rounds (comma-separated item codes per line)</label><textarea id="f-rounds">' +
      (ed.rounds || []).map(function (r) { return r.items.join(","); }).join("\n") + "</textarea></div>";
    if (t === "choice_task") html += '<div class="st-field"><label>Patient vignette</label><textarea id="f-vignette">' + esc(ed.vignette || "") + "</textarea></div>" +
      '<div class="st-note">The choice alternatives come from the conjoint design on the Conjoint tab.</div>';
    return html || '<div class="st-note">This question type has no answer settings.</div>';
  }
  function layoutSelect(def) {
    var v = ed.layout || def;
    return '<select id="f-layout">' + [["list", "Vertical list"], ["grid", "Two-column grid"], ["inline", "Inline chips"]].map(function (l) {
      return '<option value="' + l[0] + '"' + (v === l[0] ? " selected" : "") + ">" + l[1] + "</option>"; }).join("") + "</select>";
  }
  function randomizeBlock(what) {
    var rz = ed.randomize; var mode = rz && typeof rz === "object" ? rz.mode : (rz || "none");
    return '<div class="st-field st-box"><label>Randomise ' + what + '</label><div class="st-radio-row">' +
      [["none", "Fixed order", "Everyone sees the list as written"],
       ["shuffle", "Shuffle", "Fully random order per respondent"],
       ["rotate", "Rotate", "Random start point, relative order kept"],
       ["reverse", "Flip 50/50", "Half see the list reversed (scale-order balance)"]].map(function (m) {
        return '<label class="st-radio' + (mode === m[0] ? " on" : "") + '" title="' + m[2] + '"><input type="radio" name="f-rz" value="' + m[0] + '"' + (mode === m[0] ? " checked" : "") + "> " + m[1] + "<small>" + m[2] + "</small></label>";
      }).join("") + "</div>" +
      '<div class="st-meta">Pinned ' + what + ' (Pin column' + (what === "rows" ? " / <code>*</code> prefix" : "") + ') keep their position - use it for "Other", "None" or "Don\'t know". ' +
      "The order each respondent saw is stored as <code>" + esc(ed.id) + "._order</code>.</div></div>";
  }

  // ---- Logic tab ------------------------------------------------------------------------
  function logicTab(c) {
    var sif = ed.show_if || { match: "all", rules: [] };
    var earlier = c.questions.filter(function (q) { return q.id !== ed.id && q.type !== "choice_task"; });
    var idx = c.questions.map(function (q) { return q.id; }).indexOf(ed.id);
    return '<div class="st-note">Show this question only when the rules below are met. Otherwise it is skipped and any answer it held is cleared. ' +
      "Rules may reference any question; referencing a later question means the rule is evaluated against its current (usually empty) state.</div>" +
      '<div class="st-inline-row"><span>Show when</span><select id="f-sif-match">' +
        '<option value="all"' + (sif.match !== "any" ? " selected" : "") + '>ALL rules match</option>' +
        '<option value="any"' + (sif.match === "any" ? " selected" : "") + '>ANY rule matches</option></select>' +
        '<label class="st-inline"><input type="checkbox" id="f-sif-negate"' + (sif.negate ? " checked" : "") + "> invert (hide instead)</label></div>" +
      '<div id="f-rules">' + (sif.rules || []).map(function (r, i) {
        var q = earlier.filter(function (x) { return x.id === r.q; })[0];
        var valField;
        if (q && q.options && ["selected", "not_selected", "eq", "ne"].indexOf(r.op) >= 0) {
          valField = '<select data-rule="value" data-ri="' + i + '">' + q.options.map(function (o) {
            return '<option value="' + esc(o.code) + '"' + (String(o.code) === String(r.value) ? " selected" : "") + ">" + esc(o.code + " - " + o.label) + "</option>"; }).join("") + "</select>";
        } else if (r.op === "answered" || r.op === "not_answered") valField = "";
        else valField = '<input data-rule="value" data-ri="' + i + '" value="' + esc(r.value == null ? "" : r.value) + '" placeholder="value">';
        return '<div class="st-rule"><select data-rule="q" data-ri="' + i + '">' + earlier.map(function (x, xi) {
            return '<option value="' + esc(x.id) + '"' + (x.id === r.q ? " selected" : "") + ">" + esc(x.id + " · " + String(x.stem).slice(0, 48)) + (c.questions.indexOf(x) > idx && idx >= 0 ? " (later)" : "") + "</option>"; }).join("") + "</select>" +
          '<select data-rule="op" data-ri="' + i + '">' + OPS.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === r.op ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") + "</select>" +
          valField + '<button class="st-ibtn" data-act="rule-del" data-ri="' + i + '" title="Remove rule">&#10005;</button></div>';
      }).join("") + "</div>" +
      '<button class="st-btn sm" data-act="rule-add"' + (earlier.length ? "" : " disabled") + ">+ Add rule</button>" +
      (earlier.length ? "" : '<div class="st-meta">Add other questions first.</div>') +
      '<div class="st-box" style="margin-top:14px"><label>Try it</label><div class="st-meta">With the sample answers used in the test view this question is currently ' +
      '<b id="sif-result"></b>. Tick "sample answers" off in the test view to evaluate against an empty questionnaire.</div></div>';
  }

  // ---- Media tab --------------------------------------------------------------------------
  function mediaTab() {
    var m = ed.media || {};
    return '<div class="st-field"><label>Image or video shown under the question text</label>' +
      (m.src ? '<div class="st-media-cur">' + (m.kind === "video" ? '<video src="' + esc(m.src) + '" controls></video>' : '<img src="' + esc(m.src) + '" alt="">') +
        '<div><code>' + esc(m.src.split("/").pop()) + '</code> <button class="st-btn sm danger" data-act="media-del">Remove</button></div></div>' : "") +
      '<label class="st-upload">' + (m.src ? "Replace" : "Upload") + ' image / video <input type="file" accept="image/*,video/mp4,video/webm,video/quicktime" data-act="media-upload" hidden></label>' +
      '<div class="st-meta">png, jpg, gif, webp, svg, mp4, webm, mov · max 10 MB. Or paste a URL:</div>' +
      '<input id="f-media-url" placeholder="https://…/diagram.png or …/clip.mp4" value="' + (m.external ? esc(m.src) : "") + '"></div>' +
      '<div class="st-grid3">' +
        '<div class="st-field"><label>Width</label><select id="f-media-width">' + [["", "Natural"], ["240px", "Small (240px)"], ["420px", "Medium (420px)"], ["100%", "Full width"]].map(function (w) {
          return '<option value="' + w[0] + '"' + ((m.width || "") === w[0] ? " selected" : "") + ">" + w[1] + "</option>"; }).join("") + "</select></div>" +
        '<div class="st-field"><label>Alignment</label><select id="f-media-align">' + [["", "Left"], ["center", "Centre"], ["right", "Right"]].map(function (w) {
          return '<option value="' + w[0] + '"' + ((m.align || "") === w[0] ? " selected" : "") + ">" + w[1] + "</option>"; }).join("") + "</select></div>" +
        '<div class="st-field"><label>Video</label><label class="st-inline"><input type="checkbox" id="f-media-autoplay"' + (m.autoplay ? " checked" : "") + "> autoplay (muted)</label></div>" +
      "</div>" +
      '<div class="st-grid2"><div class="st-field"><label>Caption (optional)</label><div class="st-with-pipe"><input id="f-media-cap" value="' + esc(m.caption || "") + '">' + pipeButton("f-media-cap", true) + "</div></div>" +
      '<div class="st-field"><label>Alt text (accessibility)</label><input id="f-media-alt" value="' + esc(m.alt || "") + '"></div></div>';
  }

  function advancedTab() {
    return '<div class="st-field"><label>Raw question JSON</label>' +
      '<textarea id="f-raw" style="min-height:300px;font-family:monospace;font-size:12px">' + esc(JSON.stringify(ed, null, 2)) + "</textarea>" +
      '<div class="st-inline-row"><button class="st-btn sm" data-act="raw-apply">Load JSON into editor</button>' +
      '<span class="st-meta">For power users - everything the form does is stored here. Fields: stem_html, help_html, style, options[].exclusive/pin/other/image, randomize, show_if, media, layout, hide_codes, hide_number.</span></div></div>';
  }

  // ---- live respondent preview ---------------------------------------------------------
  var prevSeed = "preview-1";
  function renderPreview() {
    var host = document.getElementById("st-ed-prev-body");
    if (!host || !window.BeaconSurveyPreview) return;
    var useSample = document.getElementById("prev-sample");
    var answers = (!useSample || useSample.checked) ? Q.sampleAnswers(cur.cfg.questions, ed.id) : {};
    var res = window.BeaconSurveyPreview.render(host, ed, { answers: answers, questions: cur.cfg.questions }, prevSeed);
    var note = document.getElementById("st-ed-prev-note");
    var visible = Q.showIf(ed, { answers: answers, questions: cur.cfg.questions });
    var bits = [];
    if (!visible) bits.push("<b>Hidden</b> by its show-if rules for these sample answers (respondents would skip it).");
    if (ed.randomize && ed.randomize !== "none") bits.push("Order shown is one random draw - press reshuffle for another.");
    if (res && res.unresolved && res.unresolved.length) bits.push("Unresolved piping: <code>" + res.unresolved.map(esc).join("</code> <code>") + "</code>.");
    if (note) note.innerHTML = bits.join(" ") || "Interactive - try answering it. Nothing here is saved.";
    var sr = document.getElementById("sif-result"); if (sr) sr.textContent = visible ? "SHOWN" : "HIDDEN";
  }

  // ---- read form -> ed ----------------------------------------------------------------
  function val(id) { var n = document.getElementById(id); return n ? n.value : undefined; }
  function num(id) { var x = val(id); return x === undefined || x === "" ? undefined : Number(x); }
  function chk(id) { var n = document.getElementById(id); return n ? n.checked : undefined; }
  function setOrDel(obj, key, v) { if (v === undefined || v === "" || v === false || v === null) delete obj[key]; else obj[key] = v; }

  function syncFromForm() {
    if (!ed) return;
    var t = ed.type;
    if (edTab === "content") {
      if (val("f-id") !== undefined) ed.id = val("f-id").trim() || ed.id;
      if (val("f-section") !== undefined) ed.section = val("f-section");
      var rich = document.getElementById("f-stem-rich");
      if (rich) { ed.stem_html = unchip(Q.sanitize(rich.innerHTML)); ed.stem = Q.stripTags(ed.stem_html) || ed.stem; }
      var hr = document.getElementById("f-help-rich");
      if (hr) { var hh = unchip(Q.sanitize(hr.innerHTML)); if (Q.stripTags(hh)) { ed.help_html = hh; ed.help = Q.stripTags(hh); } else { delete ed.help_html; delete ed.help; } }
      ed.style = ed.style || {};
      setOrDel(ed.style, "font", val("f-font")); setOrDel(ed.style, "size", val("f-size")); setOrDel(ed.style, "align", val("f-align"));
      if (!Object.keys(ed.style).length) delete ed.style;
      ed.required = chk("f-required") !== false;
      setOrDel(ed, "hide_number", chk("f-hidenum"));
    }
    if (edTab === "answers") {
      if (hasOptions(t)) {
        document.querySelectorAll("[data-opt]").forEach(function (n) {
          var o = ed.options[Number(n.getAttribute("data-oi"))]; if (!o) return;
          var k = n.getAttribute("data-opt");
          if (n.type === "checkbox") setOrDel(o, k, n.checked);
          else if (k === "code") o.code = isNaN(Number(n.value)) || n.value.trim() === "" ? n.value.trim() : Number(n.value);
          else o[k] = n.value;
        });
        if (t === "multi_select") setOrDel(ed, "max_select", num("f-maxselect"));
        setOrDel(ed, "layout", val("f-layout") === (t === "multi_select" ? "grid" : "list") ? "" : val("f-layout"));
        setOrDel(ed, "hide_codes", chk("f-hidecodes"));
      }
      if (hasRows(t)) {
        var rows = String(val("f-rows") || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean).map(function (l, i) {
          var pin = l.charAt(0) === "*"; if (pin) l = l.slice(1).trim();
          var p = l.split("|"); var o = { code: (p[0] || "").trim() || String(i + 1), label: (p[1] || p[0] || "").trim() };
          if (t === "semantic_diff") { o.left = (p[2] || "").trim(); o.right = (p[3] || "").trim(); }
          if (pin) o.pin = true; return o;
        });
        if (rows.length) ed.rows = rows;
      }
      var rz = document.querySelector("input[name=f-rz]:checked");
      if (rz) setOrDel(ed, "randomize", rz.value === "none" ? "" : rz.value);
      if (t === "rating_grid" || t === "semantic_diff" || t === "nps") {
        ed.scale = ed.scale || {}; ed.scale.min = num("f-smin") != null ? num("f-smin") : 1; ed.scale.max = num("f-smax") != null ? num("f-smax") : 7;
        setOrDel(ed.scale, "min_label", val("f-sminl")); setOrDel(ed.scale, "max_label", val("f-smaxl"));
      }
      if (t === "numeric" || t === "slider") { ed.min = num("f-min"); ed.max = num("f-max"); setOrDel(ed, "step", num("f-step")); setOrDel(ed, "prefix", val("f-prefix")); setOrDel(ed, "suffix", val("f-suffix")); }
      if (t === "open_text") { setOrDel(ed, "min_words", num("f-minwords")); setOrDel(ed, "placeholder", val("f-placeholder")); }
      if (t === "rank") setOrDel(ed, "rank_count", num("f-rankcount"));
      if (t === "heatmap" && val("f-cols") !== undefined) ed.cols = parseLines(val("f-cols"));
      if (t === "maxdiff" && val("f-rounds") !== undefined) ed.rounds = String(val("f-rounds")).split("\n").filter(function (l) { return l.trim(); }).map(function (l) { return { items: l.split(",").map(function (x) { return x.trim(); }).filter(Boolean) }; });
      if (t === "choice_task" && val("f-vignette") !== undefined) ed.vignette = val("f-vignette");
    }
    if (edTab === "logic") {
      var rules = [];
      document.querySelectorAll("#f-rules .st-rule").forEach(function (row) {
        var r = {};
        row.querySelectorAll("[data-rule]").forEach(function (n) { r[n.getAttribute("data-rule")] = n.value; });
        if (r.q && r.op) rules.push(r);
      });
      if (rules.length) ed.show_if = { match: val("f-sif-match") || "all", rules: rules, negate: !!chk("f-sif-negate") };
      else delete ed.show_if;
      if (ed.show_if && !ed.show_if.negate) delete ed.show_if.negate;
    }
    if (edTab === "media") {
      var m = ed.media || {};
      var url = (val("f-media-url") || "").trim();
      if (url && /^https?:\/\//i.test(url)) { m.src = url; m.external = true; m.kind = /\.(mp4|webm|mov)(\?|$)/i.test(url) ? "video" : "image"; }
      else if (m.external && !url) { m = {}; }
      setOrDel(m, "width", val("f-media-width")); setOrDel(m, "align", val("f-media-align"));
      setOrDel(m, "autoplay", chk("f-media-autoplay")); setOrDel(m, "caption", val("f-media-cap")); setOrDel(m, "alt", val("f-media-alt"));
      if (m.src) ed.media = m; else delete ed.media;
    }
  }

  function uploadMedia(file, cb) {
    var fd = new FormData(); fd.append("file", file, file.name);
    toast("Uploading " + file.name + "…");
    fetch("/api/studio/media?study=" + encodeURIComponent(cur.slug) + TQ, { method: "POST", body: fd, credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (r) { if (r.error) { toast("Upload failed: " + r.error); return; } cb(r); })
      .catch(function () { toast("Upload failed"); });
  }

  // drawer events: tabs, toolbar, option table, rules, media, preview
  drawer.addEventListener("click", function (e) {
    var tb = e.target.closest("[data-edtab]");
    if (tb) { syncFromForm(); closePipePicker(); edTab = tb.getAttribute("data-edtab"); renderDrawer(); return; }
    var cmd = e.target.closest("button[data-cmd]");
    if (cmd) {
      e.preventDefault();
      var target = document.getElementById(cmd.getAttribute("data-target"));
      target.focus();
      document.execCommand("styleWithCSS", false, true);
      document.execCommand(cmd.getAttribute("data-cmd"), false, cmd.getAttribute("data-val") || null);
      syncFromForm(); renderPreview();
      return;
    }
    var pb = e.target.closest("[data-pipe-for]");
    if (pb) { e.preventDefault(); openPipePicker(document.getElementById(pb.getAttribute("data-pipe-for"))); return; }
    var pi = e.target.closest(".st-pipe-item");
    if (pi) { insertPipe(pi.getAttribute("data-token")); return; }
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var act = b.getAttribute("data-act");
    var oi = Number(b.getAttribute("data-oi"));
    var ri = Number(b.getAttribute("data-ri"));
    if (act === "pipe-close") { closePipePicker(); return; }
    if (act === "qclose") { closeDrawer(); }
    if (act === "qsave") {
      syncFromForm();
      if (!ed.id || !(ed.stem || "").trim()) { toast("Question needs an id and text"); return; }
      var clash = cur.cfg.questions.some(function (q, i) { return q.id === ed.id && i !== edQi; });
      if (clash) { toast("Another question already uses id " + ed.id); return; }
      if (edQi === -1) cur.cfg.questions.push(ed); else cur.cfg.questions[edQi] = ed;
      closeDrawer(); renderTab();
      toast("Question updated - press Save study to publish");
    }
    if (act === "prev-reshuffle") { prevSeed = "preview-" + Math.random().toString(36).slice(2, 8); renderPreview(); }
    if (act === "opt-add" || act === "opt-add-none" || act === "opt-add-na" || act === "opt-add-other") {
      syncFromForm();
      var codes = (ed.options || []).map(function (o) { return Number(o.code); }).filter(function (n) { return !isNaN(n); });
      var next = (codes.length ? Math.max.apply(null, codes) : 0) + 1;
      var o = { code: next, label: "New option" };
      if (act === "opt-add-none") { o.label = "None of these"; o.exclusive = true; o.pin = true; o.code = 99; }
      if (act === "opt-add-na") { o.label = "Not applicable"; o.exclusive = true; o.pin = true; o.code = 98; }
      if (act === "opt-add-other") { o.label = "Other (please specify)"; o.other = true; o.pin = true; o.code = 97; }
      ed.options = (ed.options || []).concat([o]); renderDrawer();
      var last = document.querySelector('.st-opts tbody tr:last-child input[data-opt=label]'); if (last) { last.focus(); last.select(); }
    }
    if (act === "opt-del") { syncFromForm(); ed.options.splice(oi, 1); renderDrawer(); }
    if (act === "opt-up" && oi > 0) { syncFromForm(); var a = ed.options; var tmp = a[oi - 1]; a[oi - 1] = a[oi]; a[oi] = tmp; renderDrawer(); }
    if (act === "opt-down" && oi < ed.options.length - 1) { syncFromForm(); var a2 = ed.options; var tmp2 = a2[oi + 1]; a2[oi + 1] = a2[oi]; a2[oi] = tmp2; renderDrawer(); }
    if (act === "opt-img-del") { syncFromForm(); delete ed.options[oi].image; renderDrawer(); }
    if (act === "opt-bulk") {
      syncFromForm();
      var txt = prompt("Paste one option per line (optionally code|label):", "");
      if (txt && txt.trim()) { ed.options = parseLines(txt).map(function (o, i) { o.code = isNaN(Number(o.code)) ? i + 1 : Number(o.code); return o; }); renderDrawer(); }
    }
    if (act === "rule-add") {
      syncFromForm();
      var earlier = cur.cfg.questions.filter(function (q) { return q.id !== ed.id && q.type !== "choice_task"; });
      var q0 = earlier[0]; if (!q0) return;
      ed.show_if = ed.show_if || { match: "all", rules: [] };
      ed.show_if.rules.push({ q: q0.id, op: q0.options ? "selected" : "answered", value: q0.options ? q0.options[0].code : "" });
      renderDrawer();
    }
    if (act === "rule-del") { syncFromForm(); ed.show_if.rules.splice(ri, 1); if (!ed.show_if.rules.length) delete ed.show_if; renderDrawer(); }
    if (act === "media-del") {
      syncFromForm();
      var m = ed.media;
      if (m && !m.external && m.src) api("/api/studio/media/delete", { study: cur.slug, file: m.src.split("/").pop() });
      delete ed.media; renderDrawer();
    }
    if (act === "raw-apply") {
      try {
        var parsed = JSON.parse(val("f-raw"));
        if (!parsed || !parsed.id || !parsed.type) { toast("JSON needs at least id and type"); return; }
        ed = parsed; renderDrawer(); toast("Loaded - press Apply to keep it");
      } catch (err) { toast("JSON did not parse: " + err.message); }
    }
  });
  drawer.addEventListener("change", function (e) {
    var t = e.target;
    var cmdIn = t.closest("input[type=color][data-cmd]");
    if (cmdIn) {
      var target = document.getElementById(cmdIn.getAttribute("data-target"));
      target.focus();
      document.execCommand("styleWithCSS", false, true);
      document.execCommand(cmdIn.getAttribute("data-cmd"), false, cmdIn.value);
      syncFromForm(); renderPreview(); return;
    }
    var act = t.getAttribute("data-act");
    if (act === "media-upload" && t.files && t.files[0]) {
      uploadMedia(t.files[0], function (r) { syncFromForm(); ed.media = Object.assign(ed.media || {}, { src: r.src, kind: r.kind, external: false }); renderDrawer(); toast("Attached " + r.file); });
      return;
    }
    if (act === "opt-img" && t.files && t.files[0]) {
      var oi = Number(t.getAttribute("data-oi"));
      uploadMedia(t.files[0], function (r) { syncFromForm(); ed.options[oi].image = r.src; renderDrawer(); });
      return;
    }
    if (t.id === "prev-sample") { renderPreview(); return; }
    if (t.getAttribute("data-rule") === "q" || t.getAttribute("data-rule") === "op") { syncFromForm(); renderDrawer(); return; }
    if (t.name === "f-rz") { document.querySelectorAll(".st-radio").forEach(function (l) { l.classList.toggle("on", l.querySelector("input").checked); }); }
    syncFromForm(); renderPreview();
  });
  drawer.addEventListener("input", function (e) {
    if (e.target.id === "f-raw") return;
    syncFromForm(); renderPreview();
  });
  // keep selection-based commands working when the toolbar button steals focus
  drawer.addEventListener("mousedown", function (e) {
    if (e.target.closest("button.st-tb, .st-tb-color")) e.preventDefault();      // keep the text selection
    var pb = e.target.closest("[data-pipe-for]");
    if (pb) { e.preventDefault(); pipeCaret = null; rememberCaret(document.getElementById(pb.getAttribute("data-pipe-for"))); }
  });

  drawer.addEventListener("paste", function (e) {
    var rich = e.target.closest("[data-rich]"); if (!rich) return;
    e.preventDefault();
    var html = e.clipboardData.getData("text/html"), text = e.clipboardData.getData("text/plain");
    document.execCommand("insertHTML", false, html ? Q.sanitize(html) : esc(text).replace(/\n/g, "<br>"));
  });

  // quick "test view" of a saved-in-draft question straight from the list
  function openTestView(qi) {
    var q = cur.cfg.questions[qi];
    var ov = document.getElementById("qtest");
    if (!ov) return;
    ov.hidden = false;
    var host = document.getElementById("qtest-body");
    document.getElementById("qtest-title").textContent = q.id + " · " + q.type;
    var answers = Q.sampleAnswers(cur.cfg.questions, q.id);
    window.BeaconSurveyPreview.render(host, q, { answers: answers, questions: cur.cfg.questions }, "test-" + Date.now());
    var vis = Q.showIf(q, { answers: answers, questions: cur.cfg.questions });
    document.getElementById("qtest-note").textContent = vis ? "Interactive test - answers are not saved." : "Note: with sample answers this question would be hidden by its show-if rules.";
  }
  document.addEventListener("click", function (e) {
    if (e.target.closest("#qtest-close") || (e.target.id === "qtest")) { var ov = document.getElementById("qtest"); if (ov) ov.hidden = true; }
  });

  function closeDrawer() {
    drawer.classList.remove("open");
    setTimeout(function () { drawer.hidden = true; drawer.classList.remove("wide"); drawer.innerHTML = ""; }, 350);
    ed = null;
  }

  // ------------------------------------------------------------ tpp / conjoint / settings tabs
  // ------------------------------------------------------------ TPP + walkthrough tab
  var TPP_FIELDS = [["patient", "Patient population", "patient"], ["trial", "Pivotal trial", "trial"],
    ["mechanism", "Mechanism of action", "mechanism"], ["efficacy", "Headline efficacy", "efficacy"],
    ["safety", "Safety summary", "safety"], ["administration", "Administration", "dosing"],
    ["cdx", "Companion diagnostic", "cdx"]];

  function artLabels() {
    return window.BEACON_ART_LABELS || [["generic", "Generic"]];
  }
  function artLabel(id) {
    var hit = artLabels().filter(function (a) { return a[0] === id; })[0];
    return hit ? hit[1] : id;
  }
  function newSceneId() {
    return "sc_" + Math.random().toString(36).slice(2, 8);
  }
  function scenes() {
    if (!Array.isArray(cur.cfg.explainer_scenes)) cur.cfg.explainer_scenes = [];
    // older studies stored scenes without an explicit art field
    cur.cfg.explainer_scenes.forEach(function (sc) {
      if (!sc.art) sc.art = (window.BEACON_ART || {})[sc.id] ? sc.id : "generic";
      if (!sc.id) sc.id = newSceneId();
    });
    return cur.cfg.explainer_scenes;
  }

  function tppTab() {
    var t = cur.cfg.tpp || {};
    var html = '<div class="st-note">Two ways to build the walkthrough. <strong>Quick start:</strong> ' +
      "fill in the product profile text and press <em>Build scenes from text</em> - one scene per " +
      "field, with matching artwork. <strong>Fine-tune:</strong> then add, remove, reorder and " +
      "re-illustrate scenes below, and optionally upload a narration clip per scene. " +
      "<em>Preview walkthrough</em> always plays what is on this page right now; " +
      "<em>Save study</em> publishes it.</div>" +
      '<details class="st-details"' + (scenes().length ? "" : " open") + '><summary>Product profile text (quick start)</summary>' +
      TPP_FIELDS.map(function (f) {
        return '<div class="st-field"><label>' + f[1] + '</label><textarea data-tpp="' + f[0] +
          '">' + esc(t[f[0]] || "") + "</textarea></div>";
      }).join("") +
      '<div class="st-row"><button class="st-btn on" data-act="regen">Build scenes from text</button>' +
      '<span class="st-muted-note">Replaces the scene list below with one scene per filled-in field.</span></div>' +
      "</details>" +
      '<h3 class="st-h3">Walkthrough scenes <span class="st-count" id="scene-count"></span></h3>' +
      '<div class="st-field"><label><input type="checkbox" id="f-tts" style="width:auto" ' +
      (cur.cfg.use_tts ? "checked" : "") + '> Narrate scenes that have no uploaded clip with browser ' +
      "text-to-speech</label></div>" +
      '<div class="st-row">' +
      '<button class="st-btn play" data-act="preview-tpp">&#9654; Preview walkthrough</button>' +
      '<button class="st-btn" data-act="scene-add">+ Add scene</button>' +
      '<span class="st-muted" id="tpp-dirty" hidden>Unsaved changes &middot; press Save study to publish</span>' +
      "</div>" +
      '<div id="scene-prev" style="margin-top:12px"></div>';
    return html;
  }

  function draftTpp() {
    var tpp = {};
    root.querySelectorAll("[data-tpp]").forEach(function (n) {
      tpp[n.getAttribute("data-tpp")] = n.value;
    });
    return tpp;
  }

  // one scene per non-empty TPP field, in field order
  function scenesFromTppText(t) {
    t = t || {};
    var titles = { patient: "The patient in front of you", trial: "The pivotal trial",
      mechanism: "Mechanism of action", efficacy: "Headline efficacy", safety: "Safety at a glance",
      administration: "Dosing and administration", cdx: "Companion diagnostic" };
    return TPP_FIELDS.filter(function (f) { return (t[f[0]] || "").trim(); }).map(function (f) {
      return { id: newSceneId(), art: f[2], clip: null, at: 0, title: titles[f[0]], caption: t[f[0]].trim() };
    });
  }

  function markDirty() {
    var d = document.getElementById("tpp-dirty"); if (d) d.hidden = false;
  }

  function renderScenePrev() {
    var el = document.getElementById("scene-prev");
    if (!el) return;
    var list = scenes();
    var cnt = document.getElementById("scene-count");
    if (cnt) cnt.textContent = list.length ? list.length + (list.length === 1 ? " scene" : " scenes") : "";
    if (!list.length) {
      el.innerHTML = '<div class="st-note">No scenes yet. Fill in the product profile text above and press ' +
        "<em>Build scenes from text</em>, or <em>+ Add scene</em> to start from a blank one.</div>";
      return;
    }
    var opts = artLabels().map(function (a) { return a[0]; });
    el.innerHTML = '<div class="st-scenes">' + list.map(function (sc, i) {
      var empty = !(sc.caption || "").trim();
      var clip = sc.src ? '<span class="st-clip">&#127911; ' + esc(sc.file || "clip") +
        (sc.seconds ? " &middot; " + sc.seconds + "s" : "") +
        ' <button class="st-x" data-act="scene-clip-del" data-i="' + i + '" title="Remove clip">&times;</button></span>' :
        '<label class="st-upload">&#8679; Upload narration' +
        '<input type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav,.webm" data-act="scene-clip" data-i="' + i + '" hidden></label>';
      return '<div class="st-scene' + (empty ? " empty" : "") + '" data-scene-i="' + i + '">' +
        '<div class="st-scene-head">' +
        '<span class="st-scene-no">' + (i + 1) + "</span>" +
        '<span class="st-scene-thumb" data-act="scene-thumb" data-i="' + i + '" title="Change artwork">' + sceneThumb(sc.art) + "</span>" +
        '<div class="st-scene-fields">' +
        '<input type="text" class="st-scene-title" data-scene-title="' + i + '" placeholder="Scene title" value="' + esc(sc.title || "") + '">' +
        '<textarea class="st-scene-cap" data-scene-cap="' + i + '" placeholder="What the respondent reads / hears">' + esc(sc.caption || "") + "</textarea>" +
        "</div>" +
        '<div class="st-scene-tools">' +
        '<button class="st-btn sm" data-act="preview-scene" data-i="' + i + '" title="Play from this scene">&#9654;</button>' +
        '<button class="st-btn sm" data-act="scene-up" data-i="' + i + '" title="Move up"' + (i === 0 ? " disabled" : "") + ">&#8593;</button>" +
        '<button class="st-btn sm" data-act="scene-down" data-i="' + i + '" title="Move down"' + (i === list.length - 1 ? " disabled" : "") + ">&#8595;</button>" +
        '<button class="st-btn sm danger" data-act="scene-del" data-i="' + i + '" title="Remove scene">&#128465;</button>' +
        "</div></div>" +
        '<div class="st-scene-foot">' +
        '<label class="st-inline">Artwork <select data-scene-art="' + i + '">' +
        opts.map(function (a) { return '<option value="' + a + '"' + (a === sc.art ? " selected" : "") + ">" + esc(artLabel(a)) + "</option>"; }).join("") +
        "</select></label>" +
        '<span class="st-inline">Narration ' + clip + "</span>" +
        (empty ? '<span class="st-warn-note">no text yet</span>' : "") +
        "</div></div>";
    }).join("") + "</div>";
  }

  function sceneThumb(art) {
    var A = window.BEACON_ART || {};
    return A[art] || A.generic || '<svg viewBox="0 0 400 240"></svg>';
  }

  function uploadClip(i, file) {
    if (!file) return;
    var sc = scenes()[i];
    if (!sc) return;
    var fd = new FormData();
    fd.append("file", file, file.name);
    toast("Uploading " + file.name + "…");
    fetch("/api/studio/narration?study=" + encodeURIComponent(cur.slug) + TQ,
      { method: "POST", body: fd, credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r.error) { toast("Upload failed: " + r.error); return; }
        sc.src = r.src; sc.file = r.file; sc.seconds = r.seconds || 0; sc.clipId = r.clip;
        renderScenePrev(); markDirty();
        toast("Clip attached" + (r.seconds ? " (" + r.seconds + "s)" : "") + " - save to publish");
      })
      .catch(function () { toast("Upload failed"); });
  }

  function removeClip(i) {
    var sc = scenes()[i];
    if (!sc) return;
    var id = sc.clipId || (sc.src || "").split("/").pop().split(".")[0];
    if (id) api("/api/studio/narration/delete", { study: cur.slug, clip: id });
    delete sc.src; delete sc.file; delete sc.seconds; delete sc.clipId;
    renderScenePrev(); markDirty();
  }

  // ------------------------------------------------------------ walkthrough preview
  var previewer = null;
  function closePreview() {
    var ov = document.getElementById("explainer");
    if (!ov || ov.hidden) return;
    ov.hidden = true;
    closePreviewer();
    document.getElementById("ex-mount").innerHTML = "";
  }
  function closePreviewer() { if (previewer) { try { previewer.finish(); } catch (e) {} previewer = null; } }

  function previewWalkthrough(startAt) {
    if (!window.BeaconExplainer) { toast("Explainer script not loaded"); return; }
    var list = scenes();
    var ttsBox = document.getElementById("f-tts");
    var tts = ttsBox ? ttsBox.checked : !!cur.cfg.use_tts;
    var filled = list.filter(function (s) { return (s.caption || "").trim(); }).length;
    if (!list.length) { toast("Add at least one scene first"); return; }
    if (!filled) { toast("All scenes are empty - add some text first"); return; }
    var ov = document.getElementById("explainer");
    var clips = list.filter(function (s) { return s.src; }).length;
    document.getElementById("ex-hint").textContent = filled < list.length
      ? (list.length - filled) + " scene(s) still empty"
      : (clips === list.length ? "Uploaded narration on every scene"
        : clips ? clips + " uploaded clip(s), rest " + (tts ? "browser voice" : "silent")
        : (tts ? "Browser voice narration on" : "Silent, timed walkthrough"));
    ov.hidden = false;
    closePreviewer();
    previewer = new window.BeaconExplainer(document.getElementById("ex-mount"), {
      scenes: JSON.parse(JSON.stringify(list)),
      narration: cur.cfg.narration || {},
      muted: false,
      tts: tts,
      onDone: function () { previewer = null; closePreview(); }
    });
    previewer.start();
    if (startAt) previewer.loadScene(startAt);
  }

  window.addEventListener("keydown", function (e) { if (e.key === "Escape") closePreview(); });
  document.addEventListener("click", function (e) {
    if (e.target && e.target.id === "ex-close") closePreview();
  });
  document.addEventListener("input", function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute("data-tpp")) { cur.cfg.tpp = draftTpp(); markDirty(); }
    var i;
    if (t.hasAttribute("data-scene-title")) {
      i = Number(t.getAttribute("data-scene-title")); scenes()[i].title = t.value; markDirty();
    }
    if (t.hasAttribute("data-scene-cap")) {
      i = Number(t.getAttribute("data-scene-cap")); scenes()[i].caption = t.value;
      var card = t.closest(".st-scene"); if (card) card.classList.toggle("empty", !t.value.trim());
      markDirty();
    }
  });
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute("data-scene-art")) {
      var i = Number(t.getAttribute("data-scene-art"));
      scenes()[i].art = t.value;
      var th = document.querySelector('[data-act="scene-thumb"][data-i="' + i + '"]');
      if (th) th.innerHTML = sceneThumb(t.value);
      markDirty();
    }
    if (t.getAttribute("data-act") === "scene-clip") {
      uploadClip(Number(t.getAttribute("data-i")), t.files && t.files[0]);
    }
  });

  function conjointTab() {
    var cj = cur.cfg.conjoint;
    var attrs = cj ? cj.attributes : [];
    var html = '<div class="st-note">Define attributes with three levels each, then generate ' +
      "a balanced best-worst-safe design. A choice_task question will be added if missing." +
      "</div>" +
      '<div class="st-field"><label>Attributes (id|label|level1|level2|level3|higher_is_bad ' +
      '0/1 per line)</label><textarea id="f-attrs" style="min-height:140px">' +
      (attrs.map(function (a) {
        return a.id + "|" + (a.label || a.id) + "|" + a.levels.join("|") + "|" +
          (a.higher_is_bad ? 1 : 0);
      }).join("\n") || "OS|Overall survival|no proven benefit|+3 months|+6 months|0") +
      "</textarea></div>" +
      '<div class="st-field"><label>Choice tasks per respondent</label>' +
      '<input id="f-ntasks" type="number" value="' + (cj ? cj.n_tasks : 9) + '"></div>' +
      '<div class="st-field"><label>Patient vignette for the choice tasks</label>' +
      '<textarea id="f-cvignette">' + esc((cur.cfg.conjoint_scene && cur.cfg.vignette) ||
        cur.cfg.vignette || "") + '</textarea></div>' +
      '<button class="st-btn on" data-act="genconj">Generate design</button>' +
      (cj ? '<div class="st-note">Current design: ' + cj.n_tasks + " tasks x " +
        (cj.tasks && cj.tasks[0] ? cj.tasks[0].length : 3) + " alternatives over " +
        attrs.length + " attributes.</div>" : "");
    return html;
  }

  function settingsTab() {
    var c = cur.cfg, qc = c.qc || {};
    return '<div class="st-field"><label>Study slug (link /survey/' + esc(cur.slug) +
      ')</label><input value="' + esc(cur.slug) + '" disabled></div>' +
      '<div class="st-field"><label>Conjoint minimum dwell (seconds)</label>' +
      '<input id="f-dwell" type="number" value="' + (c.conjoint_min_dwell || 10) + '"></div>' +
      '<div class="st-field"><label>QC - minimum elapsed seconds (speeder flag)</label>' +
      '<input id="f-minsec" type="number" value="' + (qc.min_seconds || 300) + '"></div>' +
      '<div class="st-field"><label>QC - attention-check question id (correct code)</label>' +
      '<input id="f-attq" value="' + esc(qc.attention_q || "") + '" placeholder="Q13" ' +
      'style="width:48%;display:inline-block"><input id="f-attok" value="' +
      esc(qc.attention_ok || "") + '" placeholder="2" style="width:48%;display:inline-block">' +
      "</div>" +
      '<div class="st-field"><label>QC - straightline question id / uniform conjoint ' +
      'id</label><input id="f-strq" value="' + esc(qc.straightline_q || "") +
      '" style="width:48%;display:inline-block"><input id="f-uniq" value="' +
      esc(qc.uniform_q || "") + '" style="width:48%;display:inline-block"></div>' +
      '<div class="st-field"><label>QC - verbatim question ids (comma separated)</label>' +
      '<input id="f-verb" value="' + esc((qc.verbatim_qs || []).join(", ")) + '"></div>' +
      '<div class="st-field"><label>Headline metric question ids (intent / pct / wtp, ' +
      'optional)</label><input id="f-m1" value="' + esc((c.metrics || {}).intent_q || "") +
      '" placeholder="intent" style="width:32%;display:inline-block"><input id="f-m2" value="' +
      esc((c.metrics || {}).pct_q || "") + '" placeholder="pct" ' +
      'style="width:32%;display:inline-block"><input id="f-m3" value="' +
      esc((c.metrics || {}).wtp_q || "") + '" placeholder="wtp" ' +
      'style="width:32%;display:inline-block"></div>';
  }

  // ------------------------------------------------------------ responses / analysis
  function responsesTab(p) {
    api("/api/admin/data?study=" + encodeURIComponent(cur.slug) + "&scope=all")
      .then(function (d) {
        var html = '<div class="st-kpis">' +
          kpi(d.counts.total, "started") + kpi(d.counts.complete, "complete") +
          kpi(d.counts.screened_out, "screened out") + kpi(d.counts.in_progress, "in progress") +
          "</div>" +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
          '<a class="st-btn" href="/admin/export.xlsx?study=' + cur.slug +
          '&scope=all' + TQ + '">Excel (all)</a>' +
          '<a class="st-btn" href="/admin/export.csv?study=' + cur.slug + "&scope=all" +
          TQ + '">CSV</a>' +
          '<a class="st-btn" href="/admin/export.json?study=' + cur.slug + "&scope=all" +
          TQ + '">JSON</a>' +
          '<button class="st-btn bad" data-act="reset" data-scope="test">Reset test data</button>' +
          '<button class="st-btn bad" data-act="reset" data-scope="all">Reset all</button>' +
          "</div>" +
          '<table class="st-tbl"><tr><th>Code</th><th>Status</th><th>Min</th><th>QC flags</th>' +
          "<th>Started</th></tr>" +
          d.recent.map(function (r) {
            return "<tr><td>" + esc(r.code) + "</td><td>" + esc(r.status) + "</td><td>" +
              r.minutes + "</td><td>" + esc(r.flags.join(", ") || "clean") + "</td><td>" +
              esc(r.started_at || "") + "</td></tr>";
          }).join("") + "</table>";
        p.innerHTML = html;
      });
    function kpi(v, l) { return '<div class="st-kpi"><strong>' + v + "</strong><span>" + l +
      "</span></div>"; }
  }

  function analysisTab(p) {
    fetch("/api/studio/analysis?study=" + encodeURIComponent(cur.slug) + TQ, { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (a) {
        var html = '<div class="st-kpis">' +
          '<div class="st-kpi"><strong>' + a.n_complete + "/" + a.n_started +
          "</strong><span>completed</span></div>" +
          '<div class="st-kpi"><strong>' + a.mean_minutes + "</strong><span>mean minutes</span></div>" +
          (a.nps ? '<div class="st-kpi"><strong>' + a.nps.score + "</strong><span>NPS</span></div>" : "") +
          "</div>";
        a.ratings.forEach(function (r) {
          html += "<h4>" + esc(r.id) + " - " + esc(r.stem) + "</h4>" +
            '<table class="st-tbl"><tr><th>Item</th><th style="width:200px">Mean</th><th></th></tr>' +
            r.rows.map(function (row) {
              var m = row.mean == null ? 0 : row.mean;
              return "<tr><td>" + esc(row.label) + "</td><td>" + (row.mean == null ? "–" : m) +
                '</td><td><div class="st-bar"><i style="width:' + Math.min(100, m * 14) +
                '%"></i></div></td></tr>';
            }).join("") + "</table>";
        });
        if (a.nps) html += '<div class="st-note">NPS segments: Promoter ' +
          a.nps.segments.Promoter + ", Passive " + a.nps.segments.Passive + ", Detractor " +
          a.nps.segments.Detractor + "</div>";
        a.maxdiff.forEach(function (m) {
          html += "<h4>MaxDiff " + esc(m.id) + " (best minus worst)</h4>" +
            '<table class="st-tbl"><tr><th>Code</th><th>Best</th><th>Worst</th><th>B-W</th></tr>' +
            m.scores.sort(function (x, y) { return y.bw - x.bw; }).map(function (s) {
              return "<tr><td>" + esc(s.code) + "</td><td>" + s.best + "</td><td>" + s.worst +
                "</td><td><strong>" + s.bw + "</strong></td></tr>";
            }).join("") + "</table>";
        });
        a.heatmap.forEach(function (h) {
          html += "<h4>Heat map " + esc(h.id) + "</h4>" +
            '<table class="st-tbl"><tr><th>Cell</th><th>Mean intensity (0-3)</th></tr>' +
            h.cells.map(function (c) {
              return "<tr><td>" + esc(c.row) + " × " + esc(c.col) + "</td><td>" +
                (c.mean == null ? "–" : c.mean) + "</td></tr>";
            }).join("") + "</table>";
        });
        if (a.choice_share) {
          html += "<h4>Conjoint: share of choices when level shown</h4>" +
            '<table class="st-tbl"><tr><th>Attribute</th><th>Level</th><th>Choice share</th></tr>' +
            a.choice_share.map(function (s) {
              return "<tr><td>" + esc(s.attr) + "</td><td>" + esc(s.level) + "</td><td>" +
                s.share + '%</td></tr>';
            }).join("") + "</table>";
        }
        p.innerHTML = html || "<p>No responses yet.</p>";
      });
  }

  // ------------------------------------------------------------ events
  document.getElementById("new-study").addEventListener("click", function () {
    var cfg = blankCfg();
    api("/api/studio/save", { slug: "", title: cfg.title, cfg: cfg }).then(function (r) {
      toast("Created /" + r.slug);
      openEditor(r.slug);
    });
  });
  document.getElementById("dup-beacon").addEventListener("click", function () {
    api("/api/studio/study?slug=beacon")
      .then(function (s) {
        var cfg = JSON.parse(JSON.stringify(s.cfg));
        cfg.title = s.title + " (copy)";
        api("/api/studio/save", { slug: "", title: cfg.title, cfg: cfg }).then(function (r) {
          toast("Duplicated as /" + r.slug);
          openEditor(r.slug);
        });
      });
  });

  root.addEventListener("click", function (e) {
    var t = e.target;
    var tabBtn = t.closest("[data-tab]");
    if (tabBtn) { tab = tabBtn.getAttribute("data-tab"); renderEditor(); return; }
    var b = t.closest("[data-act]");
    if (!b) return;
    var act = b.getAttribute("data-act");
    var slug = b.getAttribute("data-slug");
    var i = Number(b.getAttribute("data-i"));

    if (act === "open") openEditor(slug);
    if (act === "back") { history.replaceState(null, "", location.pathname + location.search); loadList(); }
    if (act === "status") {
      api("/api/studio/status", { slug: slug, status: b.getAttribute("data-status") })
        .then(function () { toast("Status updated"); loadList(); });
    }
    if (act === "dup") {
      api("/api/studio/study?slug=" + slug)
        .then(function (s) {
          var cfg = JSON.parse(JSON.stringify(s.cfg));
          cfg.title = s.title + " (copy)";
          api("/api/studio/save", { slug: "", title: cfg.title, cfg: cfg })
            .then(function (r) { toast("Duplicated as /" + r.slug); loadList(); });
        });
    }
    if (act === "del") {
      if (confirm("Delete study /" + slug + " and all of its responses?")) {
        api("/api/studio/delete", { slug: slug }).then(function () { loadList(); });
      }
    }
    if (act === "save") {
      cur.title = document.getElementById("ed-title").value;
      var ttsBox = document.getElementById("f-tts");
      if (ttsBox) cur.cfg.use_tts = ttsBox.checked;
      if (root.querySelector("[data-tpp]")) cur.cfg.tpp = draftTpp();
      var st = document.getElementById("ed-status").value;
      saveStudy(function () {
        if (st !== cur.status) {
          api("/api/studio/status", { slug: cur.slug, status: st })
            .then(function () { cur.status = st; toast("Saved & status: " + st); });
        }
      });
    }
    if (act === "viewlive") {
      // signed-in browsers may open drafts; ?preview= keeps token-in-URL bookmarks working
      window.open("/survey/" + cur.slug + "/test" + (TOKEN ? "?preview=" + encodeURIComponent(TOKEN) : ""), "_blank");
    }
    if (act === "addsec") {
      var id = "S" + (cur.cfg.sections.length + 1);
      cur.cfg.sections.push({ id: id, title: "Section " + (cur.cfg.sections.length + 1),
                              blurb: null });
      renderTab();
    }
    if (act === "delsec") {
      if (cur.cfg.questions.some(function (q) { return q.section === cur.cfg.sections[i].id; })) {
        toast("Move or delete its questions first"); return;
      }
      cur.cfg.sections.splice(i, 1); renderTab();
    }
    if (act === "qadd") {
      var type = document.getElementById("addtype-" + b.getAttribute("data-si")).value;
      var q = qTemplate(type, "", b.getAttribute("data-sec"));
      q.id = "N" + (cur.cfg.questions.length + 1);
      cur.cfg.questions.push(q);
      openQuestionDrawer(cur.cfg.questions.length - 1);
    }
    if (act === "qedit") openQuestionDrawer(i);
    if (act === "qtest") openTestView(i);
    if (act === "qdel") { cur.cfg.questions.splice(i, 1); renderTab(); }
    if (act === "qup" && i > 0) {
      var a1 = cur.cfg.questions; var t1 = a1[i - 1]; a1[i - 1] = a1[i]; a1[i] = t1; renderTab();
    }
    if (act === "qdown" && i < cur.cfg.questions.length - 1) {
      var a2 = cur.cfg.questions; var t2 = a2[i + 1]; a2[i + 1] = a2[i]; a2[i] = t2; renderTab();
    }
    if (act === "regen") {
      cur.cfg.tpp = draftTpp();
      var built = scenesFromTppText(cur.cfg.tpp);
      if (!built.length) { toast("Fill in at least one product-profile field first"); return; }
      if (scenes().length && !confirm("Replace the current " + scenes().length + " scene(s) with " +
          built.length + " built from the text?")) return;
      cur.cfg.explainer_scenes = built;
      renderScenePrev(); markDirty();
      toast(built.length + " scene(s) built - press Save study to publish");
    }
    if (act === "preview-tpp") previewWalkthrough(0);
    if (act === "preview-scene") previewWalkthrough(i || 0);
    if (act === "scene-add") {
      scenes().push({ id: newSceneId(), art: "generic", clip: null, at: 0, title: "New scene", caption: "" });
      renderScenePrev(); markDirty();
      var last = document.querySelector(".st-scene:last-child textarea"); if (last) last.focus();
    }
    if (act === "scene-del") {
      var victim = scenes()[i];
      if (victim && (victim.caption || "").trim() && !confirm("Remove scene " + (i + 1) + "?")) return;
      if (victim && victim.src) removeClip(i);
      scenes().splice(i, 1); renderScenePrev(); markDirty();
    }
    if (act === "scene-up" && i > 0) {
      var L = scenes(); var tmp = L[i - 1]; L[i - 1] = L[i]; L[i] = tmp; renderScenePrev(); markDirty();
    }
    if (act === "scene-down" && i < scenes().length - 1) {
      var L2 = scenes(); var tmp2 = L2[i + 1]; L2[i + 1] = L2[i]; L2[i] = tmp2; renderScenePrev(); markDirty();
    }
    if (act === "scene-clip-del") removeClip(i);
    if (act === "scene-thumb") {
      var sel = document.querySelector('[data-scene-art="' + i + '"]'); if (sel) sel.focus();
    }
    if (act === "genconj") {
      var attrs = String(document.getElementById("f-attrs").value).split("\n")
        .filter(function (l) { return l.trim(); }).map(function (l) {
          var p = l.split("|");
          return { id: p[0].trim(), label: (p[1] || p[0]).trim(),
                   levels: [p[2] || "low", p[3] || "mid", p[4] || "high"],
                   higher_is_bad: p[5] === "1" };
        });
      api("/api/studio/make_conjoint", {
        attributes: attrs, n_tasks: Number(document.getElementById("f-ntasks").value) || 9,
        seed: 7
      }).then(function (d) {
        if (d.error) { toast("Design failed: " + d.error); return; }
        cur.cfg.conjoint = {
          attributes: d.attributes.map(function (id) {
            return { id: id, levels: d.levels[id] };
          }),
          tasks: d.tasks.map(function (task) {
            return task.map(function (p, i) { return { alt_id: i + 1, levels: p }; });
          }),
          n_tasks: d.n_tasks, has_opt_out: true
        };
        cur.cfg.vignette = document.getElementById("f-cvignette").value || cur.cfg.vignette;
        if (!cur.cfg.questions.some(function (q) { return q.type === "choice_task"; })) {
          var q = qTemplate("choice_task", "CT1",
                            cur.cfg.sections[cur.cfg.sections.length - 1].id);
          q.vignette = cur.cfg.vignette;
          cur.cfg.questions.push(q);
        }
        renderTab();
        toast("Design generated: " + d.n_tasks + " balanced tasks");
      });
    }
    if (act === "reset") {
      if (confirm("Reset " + b.getAttribute("data-scope") + " responses for /" + cur.slug + "?")) {
        fetch("/admin/reset?study=" + cur.slug + "&scope=" + b.getAttribute("data-scope") + TQ,
              { method: "POST", credentials: "same-origin" })
          .then(function (r) { return r.json(); })
          .then(function (r) { toast("Deleted " + r.deleted_respondents); responsesTab(
            document.getElementById("st-panel")); });
      }
    }
  });

  root.addEventListener("input", function (e) {
    var t = e.target;
    if (t.id === "ed-title") cur.title = t.value;
    var si = t.getAttribute && t.getAttribute("data-sec-title");
    if (si != null) cur.cfg.sections[Number(si)].title = t.value;
  });

  // deep link: /studio/#<slug> opens that study's builder directly (used by Home and Admin)
  function openFromHash() {
    var slug = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (slug) openEditor(slug); else loadList();
  }
  window.addEventListener("hashchange", function () {
    var slug = location.hash.replace(/^#/, "");
    if (slug && (!cur || cur.slug !== slug)) openEditor(slug);
    if (!slug && cur) loadList();
  });
  openFromHash();
})();
