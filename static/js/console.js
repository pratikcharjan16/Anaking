/* SurveyKart Admin — Account desk.
   Master/detail control surface: roster on the left, one account's whole context
   (identity, access, Kart ledger, projects, audit trail) on the right. */
(function () {
  "use strict";

  var state = {
    users: [],
    stats: {},
    requests: [],
    selectedId: 0,
    detail: null,
    recovery: { pending: [], count: 0, mail_configured: false, ttl_minutes: 60 },
    tab: "overview",
    filter: "all",
    query: ""
  };

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function when(raw) {
    var s = String(raw || "");
    if (!s) return "—";
    var d = new Date(s.replace(" ", "T"));
    if (isNaN(d.getTime())) return s.slice(0, 16).replace("T", " ");
    return d.getDate() + " " + MONTHS[d.getMonth()] + " · " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function initials(u) {
    var base = (u.name || u.username || u.email || "?").trim();
    var parts = base.split(/\s+/).filter(Boolean);
    if (parts.length > 1) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return base.slice(0, 2).toUpperCase();
  }

  function firstName(u) {
    return String(u.name || u.username || u.email || "").split(/\s+/)[0] || "this account";
  }

  function n(v) {
    var num = Number(v || 0);
    return isNaN(num) ? "0" : num.toLocaleString();
  }

  function api(path, body) {
    return fetch(path, body ? {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    } : undefined).then(function (r) {
      return r.json().catch(function () {
        return { error: "Request failed (" + r.status + ")" };
      });
    });
  }

  var toastTimer = null;
  function toast(message, bad) {
    var el = document.getElementById("adk-toast");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("bad", !!bad);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, bad ? 6000 : 3400);
  }

  function fail(out) {
    toast((out && out.error) || "That action did not go through.", true);
  }

  // ------------------------------------------------------------------ stats
  function renderStats() {
    var s = state.stats || {};
    var stats = [
      { n: s.users, label: "Accounts" },
      { n: s.pending, label: "Awaiting approval", alert: s.pending > 0 },
      { n: s.pending_point_requests, label: "Kart requests", alert: s.pending_point_requests > 0 },
      { n: s.projects, label: "Projects" },
      { n: s.completes, label: "Completes" }
    ];
    document.getElementById("adk-stats").innerHTML = stats.map(function (x) {
      return '<div class="adk-stat' + (x.alert ? " alert" : "") + '"><b>' + n(x.n) +
        '</b><span>' + esc(x.label) + "</span></div>";
    }).join("");
  }

  // ------------------------------------------------------------------ queue
  function renderQueue() {
    var box = document.getElementById("adk-queue");
    var pendingUsers = state.users.filter(function (u) { return u.status === "pending"; });
    var requests = state.requests.filter(function (r) { return r.status === "pending"; });
    var total = pendingUsers.length + requests.length;
    box.hidden = total === 0;
    if (!total) return;

    var bits = [];
    if (pendingUsers.length) bits.push(pendingUsers.length + " account approval" + (pendingUsers.length === 1 ? "" : "s"));
    if (requests.length) bits.push(requests.length + " Kart point request" + (requests.length === 1 ? "" : "s"));
    document.getElementById("adk-queue-count").textContent = bits.join(" · ") + " — handled right here, no digging required.";

    var cards = pendingUsers.map(function (u) {
      var pts = u.welcome_points_pending || 100;
      return '<div class="adk-queue-card">' +
        "<b>" + esc(u.name || u.email) +
          (u.auth_source === "google" ? ' <span class="adk-tag violet">Google</span>' : "") + "</b>" +
        "<small>" + esc(u.email) + " · signed up " + esc(when(u.created_at)) + "</small>" +
        "<small>Approval adds the welcome Kart points once, in the same click.</small>" +
        '<div class="adk-queue-acts">' +
          '<input class="adk-input" id="adk-qpts-' + u.id + '" type="number" min="0" max="100000" value="' + pts +
            '" style="width:76px" aria-label="Welcome Kart points">' +
          '<button type="button" class="adk-btn primary sm" data-act="queue-approve" data-id="' + u.id + '">Approve &amp; add</button>' +
          '<button type="button" class="adk-btn sm danger" data-act="queue-reject" data-id="' + u.id + '">Reject</button>' +
          '<button type="button" class="adk-btn ghost sm" data-act="open" data-id="' + u.id + '">Open</button>' +
        "</div></div>";
    }).concat(requests.map(function (r) {
      return '<div class="adk-queue-card">' +
        "<b>" + esc(r.user_name || r.user_email) +
          ' <span class="adk-tag warn">+' + n(r.requested_points) + " pts</span></b>" +
        "<small>" + esc(r.user_email) + " · current limit " + n(r.points_limit) + " pts</small>" +
        (r.reason ? "<small>“" + esc(r.reason) + "”</small>" : "") +
        '<div class="adk-queue-acts">' +
          '<input class="adk-input" id="adk-reqpts-' + r.id + '" type="number" min="0" max="100000" value="' +
            n(r.requested_points) + '" style="width:76px" aria-label="Points to grant">' +
          '<button type="button" class="adk-btn primary sm" data-act="req-approve" data-req="' + r.id + '">Grant</button>' +
          '<button type="button" class="adk-btn sm danger" data-act="req-reject" data-req="' + r.id + '">Decline</button>' +
          '<button type="button" class="adk-btn ghost sm" data-act="open" data-id="' + r.user_id + '">Open</button>' +
        "</div></div>";
    }));

    document.getElementById("adk-queue-list").innerHTML = cards.join("");
  }

  // ------------------------------------------------------------------ roster
  function matchesFilter(u) {
    switch (state.filter) {
      case "pending": return u.status === "pending";
      case "approved": return u.status === "approved";
      case "blocked": return u.status === "rejected" || u.status === "disabled";
      case "admin": return u.role === "admin";
      default: return true;
    }
  }

  function filterCounts() {
    return {
      all: state.users.length,
      pending: state.users.filter(function (u) { return u.status === "pending"; }).length,
      approved: state.users.filter(function (u) { return u.status === "approved"; }).length,
      blocked: state.users.filter(function (u) { return u.status === "rejected" || u.status === "disabled"; }).length,
      admin: state.users.filter(function (u) { return u.role === "admin"; }).length
    };
  }

  function renderFilters() {
    var counts = filterCounts();
    document.querySelectorAll("#adk-filters [data-filter]").forEach(function (b) {
      var key = b.getAttribute("data-filter");
      b.classList.toggle("on", key === state.filter);
      b.setAttribute("aria-pressed", key === state.filter ? "true" : "false");
      var slot = b.querySelector("[data-count]");
      if (slot) slot.textContent = counts[key] || 0;
    });
  }

  function renderRoster() {
    renderFilters();
    var q = state.query.trim().toLowerCase();
    var rows = state.users.filter(function (u) {
      if (!matchesFilter(u)) return false;
      if (!q) return true;
      var hay = [u.name, u.username, u.email].join(" ").toLowerCase();
      return hay.indexOf(q) !== -1;
    });

    var list = document.getElementById("adk-list");
    list.innerHTML = rows.map(function (u) {
      var cls = u.status === "pending" ? "pending"
              : (u.status === "rejected" || u.status === "disabled") ? "blocked"
              : u.role === "admin" ? "admin" : "";
      var tag = u.role === "admin" ? "Admin"
              : u.status === "pending" ? "Pending"
              : (u.status === "rejected" || u.status === "disabled") ? "Blocked" : "User";
      var avatar = u.picture
        ? '<i class="adk-ava' + (cls ? " is-" + cls : "") + '"><img src="' + esc(u.picture) + '" alt=""></i>'
        : '<i class="adk-ava' + (cls ? " is-" + cls : "") + '" aria-hidden="true">' + esc(initials(u)) + "</i>";
      var kartLeft = Math.max(0, (u.points_limit || 0) - (u.points_used || 0));
      var kartLabel = u.role === "admin" ? "\u221e"
                    : u.status === "pending" ? "+" + n(u.welcome_points_pending || 100)
                    : n(kartLeft);
      var kartClass = "adk-row-pts" + (u.role === "admin" ? " admin" : (kartLeft <= 0 && u.status !== "pending" ? " zero" : ""));
      var kartTitle = u.role === "admin" ? "Unlimited admin Kart"
                    : u.status === "pending" ? "Welcome Kart points granted on approval"
                    : n(kartLeft) + " of " + n(u.points_limit || 0) + " Kart points left";
      return '<li role="presentation">' +
        '<button type="button" class="adk-row' + (u.id === state.selectedId ? " on" : "") + '"' +
          ' data-select="' + u.id + '" role="option" aria-selected="' + (u.id === state.selectedId) + '"' +
          ' title="Open ' + esc(u.name || u.email) + '">' +
          avatar +
          '<span class="adk-row-text"><b>' + esc(u.name || u.username || u.email) + "</b>" +
            "<small>" + esc(u.username ? "@" + u.username + " · " + u.email : u.email) + "</small></span>" +
          '<span class="' + kartClass + '" title="' + kartTitle + '">' + kartLabel +
            (u.role === "admin" ? "" : " pts") + "</span>" +
          '<span class="adk-row-tag ' + cls + '">' + esc(tag) + "</span>" +
        "</button></li>";
    }).join("");

    if (!rows.length) {
      list.innerHTML = '<li class="adk-list-empty">' +
        (state.users.length ? "No account matches this filter." :
          "No accounts yet — new registrations appear here.") + "</li>";
    }
    document.getElementById("adk-list-foot").innerHTML =
      "<span>" + rows.length + " of " + state.users.length + " accounts</span>" +
      "<span>Select a card to open its dossier</span>";
  }

  // ------------------------------------------------------------------ detail
  function statusTag(u) {
    var cls = u.status === "approved" ? "ok"
            : u.status === "pending" ? "warn" : "bad";
    return '<span class="adk-tag ' + cls + '">' + esc(u.status) + "</span>";
  }

  function sealClass(u) {
    if (u.status === "pending") return " is-pending";
    if (u.status === "rejected" || u.status === "disabled") return " is-blocked";
    if (u.role === "admin") return " is-admin";
    return "";
  }

  function metric(label, value, cls, extra) {
    return '<div class="adk-metric' + (cls ? " " + cls : "") + '"><b>' + value + "</b><span>" +
      esc(label) + "</span>" + (extra || "") + "</div>";
  }

  function passportHtml(d) {
    var u = d.user;
    var isAdmin = u.role === "admin";
    var pendingKart = u.status === "pending" && !isAdmin;
    var kart = isAdmin ? "∞"
      : pendingKart ? n(u.welcome_points_pending || 100)
      : n(Math.max(0, (u.points_limit || 0) - (u.points_used || 0)));
    var kartPct = isAdmin ? 100
      : pendingKart ? 0
      : Math.min(100, Math.round(100 * (u.points_used || 0) / Math.max(1, u.points_limit || 0)));
    var actions = "";
    if (u.role !== "admin" && u.status === "approved") {
      actions += '<button type="button" class="adk-btn primary" data-act="impersonate">' +
        '<span aria-hidden="true">◉</span> Open as ' + esc(firstName(u)) + "</button>";
    }
    actions += '<button type="button" class="adk-btn ghost" data-act="refresh" title="Reload this account">Refresh</button>';

    var handleBits = [];
    if (u.username) handleBits.push("@" + esc(u.username));
    handleBits.push(esc(u.email));
    handleBits.push("ID #" + u.id);

    return '<article class="adk-passport">' +
      '<div class="adk-seal' + sealClass(u) + '" aria-hidden="true">' +
        (u.picture ? '<img src="' + esc(u.picture) + '" alt="">' : esc(initials(u))) +
      "</div>" +
      '<div class="adk-id">' +
        '<div class="adk-id-top"><h2>' + esc(u.name || u.username || u.email) + "</h2>" +
          statusTag(u) +
          (isAdmin ? '<span class="adk-tag admin">★ Admin</span>' : '<span class="adk-tag line">User</span>') +
          (u.auth_source === "google" ? '<span class="adk-tag violet">Google</span>' : "") +
          (u.is_protected ? '<span class="adk-tag warn">Protected</span>' : "") +
        "</div>" +
        '<p class="adk-handle">' + handleBits.join(' <span>·</span> ') + "</p>" +
        '<p class="adk-meta"><span>Joined <i>' + esc(when(u.created_at)) + "</i></span>" +
          "<span>Last seen <i>" + esc(when(u.last_login)) + "</i></span>" +
          '<span>Signed in with <i>' + esc(u.auth_source || "surveykart") + "</i></span></p>" +
      "</div>" +
      '<div class="adk-passport-actions">' + actions + "</div>" +
    "</article>" +
    '<div class="adk-metrics">' +
      metric("Projects", n(d.stats.projects)) +
      metric("Completes", n(d.stats.completes)) +
      metric(isAdmin ? "Kart" : pendingKart ? "Kart on approval" : "Kart left", kart, "kart",
        (isAdmin || pendingKart) ? "" : '<div class="adk-bar"><i style="width:' + kartPct + '%"></i></div>') +
      metric("Recorded actions", n(d.stats.actions)) +
    "</div>";
  }

  function tabsHtml(d) {
    var tabs = [
      ["overview", "Overview", ""],
      ["projects", "Projects", d.projects.length],
      ["kart", "Kart & ledger", d.ledger.length],
      ["activity", "Activity", d.activity.length]
    ];
    return '<div class="adk-tabs" role="tablist" aria-label="Account sections">' +
      tabs.map(function (t) {
        return '<button type="button" role="tab" class="adk-tab' + (state.tab === t[0] ? " on" : "") + '"' +
          ' data-act="tab" data-tab="' + t[0] + '" aria-selected="' + (state.tab === t[0]) + '">' +
          esc(t[1]) + (t[2] !== "" ? '<span class="n">' + t[2] + "</span>" : "") + "</button>";
      }).join("") + "</div>";
  }

  function identityBox(u) {
    var lock = u.is_protected;
    return '<div class="adk-box">' +
      '<h3>Identity <span class="adk-tag line">' + esc(u.auth_source || "surveykart") + "</span></h3>" +
      '<p class="adk-box-sub">' + (lock
        ? "The master admin's sign-in identity is protected. The display name stays editable."
        : "Correct a name, handle or e-mail. Uniqueness is checked before anything changes.") + "</p>" +
      '<div class="adk-form">' +
        '<label class="adk-field"><span>Display name</span>' +
          '<input class="adk-input" id="adk-name" value="' + esc(u.name || "") + '" maxlength="120" autocomplete="off"></label>' +
        '<div class="adk-form-row">' +
          '<label class="adk-field"><span>Username</span>' +
            '<input class="adk-input" id="adk-username" value="' + esc(u.username || "") + '" maxlength="40" autocomplete="off"' +
              (lock ? " disabled" : "") + "></label>" +
          '<label class="adk-field"><span>E-mail</span>' +
            '<input class="adk-input" id="adk-email" type="email" value="' + esc(u.email || "") + '" autocomplete="off"' +
              (lock ? " disabled" : "") + "></label>" +
        "</div>" +
        '<div class="adk-actions">' +
          '<button type="button" class="adk-btn primary" data-act="profile-save">Save identity</button>' +
          '<button type="button" class="adk-btn ghost sm" data-act="refresh">Discard</button>' +
        "</div>" +
      "</div></div>";
  }

  function accessBox(u) {
    var status = u.status;
    if (u.is_protected) {
      return '<div class="adk-box">' +
        "<h3>Access " + statusTag(u) + "</h3>" +
        '<p class="adk-box-sub">The master admin is the platform\'s escape hatch. It stays approved and ' +
          "cannot be paused, rejected or demoted — that is what makes 'All rights reserved to Admin' true.</p>" +
        '<p class="adk-note"><b>Always on.</b> Create a second admin if you need another operator.</p>' +
        "</div>";
    }
    var buttons = [];
    function btn(decision, label, cls, disabled) {
      buttons.push('<button type="button" class="adk-btn ' + cls + '" data-act="status" data-decision="' +
        decision + '"' + (disabled ? " disabled" : "") + ">" + label + "</button>");
    }
    if (status === "pending") {
      btn("approve", "Approve account", "primary", false);
      btn("reject", "Reject request", "danger", false);
    } else if (status === "approved") {
      btn("disable", "Pause access", "danger", false);
    } else {
      btn("enable", "Re-enable access", "primary", false);
      btn("reject", "Keep rejected", "ghost", true);
    }
    var welcome = "";
    if (status === "pending") {
      welcome = '<hr class="adk-divider"><label class="adk-field"><span>Welcome Kart points on approval</span>' +
        '<input class="adk-input" id="adk-welcome" type="number" min="0" max="100000" value="' +
          (u.welcome_points_pending || 100) + '"></label>' +
        '<p class="adk-hint">Granted exactly once, at the moment you approve.</p>';
    }
    var blocked = (status === "rejected" || status === "disabled")
      ? '<p class="adk-note"><b>Paused.</b> They cannot sign in to Workspace, Studio or the survey builder until re-enabled.</p>'
      : "";
    return '<div class="adk-box">' +
      "<h3>Access " + statusTag(u) + "</h3>" +
      '<p class="adk-box-sub">Approval is the door to Workspace and Studio. Pausing ends access immediately.</p>' +
      '<div class="adk-state-grid">' + buttons.join("") + "</div>" +
      welcome + blocked +
      "</div>";
  }

  function roleBox(u) {
    var isAdmin = u.role === "admin";
    var lock = u.is_protected || (isAdmin && u._lastAdmin);
    var action = isAdmin
      ? '<button type="button" class="adk-btn danger sm" data-act="role" data-role="user"' + (lock ? " disabled" : "") + ">Revoke admin rights</button>"
      : '<button type="button" class="adk-btn gold sm" data-act="role" data-role="admin">Give admin rights</button>';
    return '<div class="adk-box">' +
      "<h3>Role &amp; reach</h3>" +
      '<p class="adk-box-sub">Admins see every account and every project. Regular accounts see their own work and anything shared with them.</p>' +
      '<div class="adk-role-row"><span><b>' + (isAdmin ? "Platform admin" : "Regular account") + "</b>" +
        "<small>" + (isAdmin
          ? "Full platform rights, including this desk."
          : "Works in Workspace and Studio within their own Kart.") + "</small></span>" + action + "</div>" +
      (u.is_protected ? '<p class="adk-hint warn" style="margin-top:8px">Protected master admin — cannot be demoted or deleted.</p>' : "") +
      "</div>";
  }

  function supportBox(u) {
    if (u.role === "admin") return "";
    if (u.status !== "approved") {
      return '<div class="adk-box subtle"><h3>Support view</h3>' +
        '<p class="adk-box-sub" style="margin:0">Available once the account is approved — open their exact Workspace to reproduce what they report.</p></div>';
    }
    return '<div class="adk-box subtle">' +
      "<h3>Support view</h3>" +
      '<p class="adk-box-sub">See SurveyKart exactly as ' + esc(firstName(u)) + " does — their projects, their Kart, their screen. " +
        "Every action you take is written to the audit trail, and a strip brings you straight back here.</p>" +
      '<button type="button" class="adk-btn primary" data-act="impersonate">Open as ' + esc(firstName(u)) + " →</button>" +
      "</div>";
  }

  function dangerBox(d) {
    var u = d.user;
    if (u.is_protected) {
      return '<div class="adk-danger"><h3>Protected account</h3>' +
        "<p>The master admin account cannot be disabled, demoted or deleted. Its identity fields are locked.</p></div>";
    }
    var owns = d.projects.length;
    var disabled = owns > 0;
    return '<div class="adk-danger"><h3>Delete account</h3>' +
      "<p>" + (disabled
        ? "This account still owns " + owns + " project" + (owns === 1 ? "" : "s") +
          ". Transfer or delete them from the Projects tab first — deleting never destroys a study by surprise."
        : "Removes the profile and its Kart ledger. Projects and responses are not touched because there are none.") +
      "</p>" +
      '<button type="button" class="adk-btn danger sm" data-act="delete-account"' +
        (disabled ? " disabled" : "") + ">Delete this account</button></div>";
  }

  // ------------------------------------------------------------------ recovery
  function linkBox(link, message) {
    return '<div class="adk-linkbox" id="adk-linkbox">' +
      '<p class="adk-box-sub">' + esc(message || "Copy this link and send it to them. It works once, " +
        "for " + (state.recovery.ttl_minutes || 60) + " minutes.") + "</p>" +
      '<div class="adk-linkrow">' +
        '<code id="adk-link-value">' + esc(link) + "</code>" +
        '<button type="button" class="adk-btn sm" data-act="recovery-copy" data-link="' + esc(link) + '">Copy</button>' +
      "</div></div>";
  }

  function signinBox(d) {
    var u = d.user;
    var who = d.signin || {};
    var rows = [
      ["Username", who.username ? "@" + who.username : "not set — signs in with e-mail"],
      ["E-mail", who.email],
      ["Signs in with", who.google ? "Google" : (who.has_password ? "SurveyKart password" : "nothing yet")],
      ["Password set", who.has_password ? "yes — recoverable by link" : "no"]
    ];
    var history = (d.recovery || []).slice(0, 4).map(function (r) {
      var tag = r.status === "used" ? "used" : r.delivered === "email" ? "e-mailed"
              : r.delivered === "handed_over" ? "handed over" : r.status;
      return '<li><span>' + esc(when(r.created_at)) + " · " + esc(tag) + "</span>" +
        '<small>' + esc(r.requested_by || "self-service") + "</small></li>";
    }).join("");

    return '<div class="adk-box subtle"><h3>Sign-in &amp; recovery</h3>' +
      '<div class="adk-kvlist">' + rows.map(function (r) {
        return "<div><span>" + esc(r[0]) + "</span><b>" + esc(r[1]) + "</b></div>";
      }).join("") + "</div>" +
      '<p class="adk-box-sub">Forgot username or password is automatic: when SMTP is configured the ' +
        "link is e-mailed to them; otherwise it waits in the queue above for you to hand over. " +
        "A link always shows the username and sets a new password, once.</p>" +
      (u.is_protected ? '<p class="adk-box-sub" style="margin:0">This protected account signs in with ' +
        "<code>ADMIN_PASSWORD</code> from the environment — change it in <code>.env</code> and restart.</p>"
        : '<button type="button" class="adk-btn" data-act="recovery-issue" data-id="' + u.id +
          '">Create a one-time link</button>' +
          '<div id="adk-recovery-out" class="adk-linkhost" hidden></div>') +
      (history ? '<h4 class="adk-minihead">Recent requests</h4><ul class="adk-minilist">' + history + "</ul>" : "") +
      "</div>";
  }

  function renderRecovery() {
    var box = document.getElementById("adk-recovery");
    var list = document.getElementById("adk-recovery-list");
    if (!box || !list) return;
    var rows = (state.recovery && state.recovery.pending) || [];
    box.hidden = rows.length === 0;
    if (!rows.length) { list.innerHTML = ""; return; }
    var mail = state.recovery.mail_configured;
    document.getElementById("adk-recovery-count").textContent =
      rows.length + " request" + (rows.length === 1 ? "" : "s") +
      (mail ? " — mail is configured, these fell back after a send failure."
            : " — no mail server, so the link is handed over by you.");
    list.innerHTML = rows.map(function (r) {
      return '<div class="adk-recovery-row" id="adk-rec-' + r.id + '">' +
        '<div class="adk-recovery-who"><b>' + esc(r.user_name || r.user_email) + "</b>" +
          "<small>" + esc(r.user_email) +
          (r.user_username ? " · @" + esc(r.user_username) : "") + "</small>" +
          "<small>asked " + esc(when(r.created_at)) + " · expires " + esc(when(r.expires_at)) +
          (r.requested_ip ? " · from " + esc(r.requested_ip) : "") + "</small></div>" +
        '<div class="adk-recovery-acts">' +
          '<button type="button" class="adk-btn primary sm" data-act="recovery-row-link" data-id="' + r.id +
            '" data-user="' + r.user_id + '">Create link</button>' +
          '<button type="button" class="adk-btn sm ghost" data-act="recovery-handover" data-id="' + r.id +
            '">Handed over</button>' +
          '<button type="button" class="adk-btn sm danger-ghost" data-act="recovery-revoke" data-id="' + r.id +
            '">Revoke</button>' +
        "</div>" +
        '<div class="adk-linkhost" id="adk-rec-out-' + r.id + '" hidden></div>' +
        "</div>";
    }).join("");
  }

  function loadRecovery() {
    return api("/api/admin/console/recovery").then(function (out) {
      if (out.error) return out;
      state.recovery = out;
      renderRecovery();
      return out;
    });
  }

  // Kart points are an admin right, so the control lives on the Overview tab too —
  // not only inside the ledger — with an amount the admin types, +/- either way.
  function kartQuickBox(u) {
    var isAdmin = u.role === "admin";
    if (isAdmin) {
      return '<div class="adk-box"><h3>Kart points <span class="adk-tag admin">Unlimited</span></h3>' +
        '<p class="adk-note info"><b>Unlimited admin Kart.</b> Admins do not spend Kart points on projects, ' +
        "so there is nothing to adjust here.</p></div>";
    }
    var limit = u.points_limit || 0;
    var used = u.points_used || 0;
    var left = Math.max(0, limit - used);
    return '<div class="adk-box adk-kart-quick" id="adk-kart-quick"><h3>Kart points ' +
        '<span class="adk-tag warn">' + n(left) + " left</span></h3>" +
      '<p class="adk-box-sub">Limit <b>' + n(limit) + "</b> pts &middot; used <b>" + n(used) +
        "</b> pts &middot; <b>" + n(left) + "</b> left" +
        (u.status === "pending" ? " &middot; this account is still pending approval" : "") + "</p>" +
      '<div class="adk-form">' +
        '<label class="adk-field"><span>Points to add or remove</span>' +
          '<input class="adk-input" id="adk-quick-amt" type="number" min="1" max="10000000" step="10" ' +
            'value="100" inputmode="numeric" aria-label="Points to add or remove"></label>' +
        '<label class="adk-field"><span>Reason written to the ledger</span>' +
          '<input class="adk-input" id="adk-quick-reason" maxlength="200" ' +
            'placeholder="e.g. Approved extra field budget"></label>' +
        '<div class="adk-actions">' +
          '<button type="button" class="adk-btn primary sm gold" data-act="points-apply" data-mode="add">' +
            "+ Add points</button>" +
          '<button type="button" class="adk-btn sm danger-ghost" data-act="points-apply" data-mode="remove">' +
            "&minus; Remove points</button>" +
          '<button type="button" class="adk-btn sm ghost" data-act="points-tab">Set an exact limit &rarr;</button>' +
          (left > 0 ? '<button type="button" class="adk-btn sm danger" data-act="points-expire" title="Expire all currently unused points">Expire remaining points</button>' : '') +
        "</div>" +
      "</div></div>";
  }

  function renderOverview(d) {
    var u = d.user;
    return '<div class="adk-pane-grid">' +
      '<div class="adk-stack">' + kartQuickBox(u) + identityBox(u) + signinBox(d) + supportBox(u) + "</div>" +
      '<div class="adk-stack">' + accessBox(u) + roleBox(u) + dangerBox(d) + "</div>" +
      "</div>";
  }

  function sharedProjectsBlock(d) {
    var shared = d.shared_with || [];
    if (!shared.length) return "";
    return '<div class="adk-box subtle" style="margin-top:14px"><h3>Projects shared with ' +
      esc(firstName(d.user)) + ' <span class="adk-tag line">' + shared.length + "</span></h3>" +
      '<p class="adk-box-sub">Someone else owns these; this account can open them through a share.</p>' +
      shared.map(function (s) {
        return '<div class="adk-role-row" style="margin-bottom:6px"><span><b>' + esc(s.study_slug) + "</b>" +
          "<small>" + esc(s.permission || "collaborate") + " · shared " + esc(when(s.created_at)) + "</small></span>" +
          '<a class="adk-btn sm ghost" href="/studio/#' + esc(s.study_slug) + '">Open ↗</a></div>';
      }).join("") + "</div>";
  }

  function renderProjects(d) {
    var u = d.user;
    if (!d.projects.length) {
      return '<div class="adk-empty-inline"><b>No projects yet</b>' +
        esc(firstName(u)) + " has not built a study. Their Kart holds the points until they do.</div>" +
        sharedProjectsBlock(d);
    }
    var peers = d.peers || [];
    return '<div class="adk-section-head"><h3>Projects owned by ' + esc(firstName(u)) + "</h3>" +
      "<p>Change status, jump into Studio or hand ownership to another account.</p></div>" +
      '<div class="adk-projects">' + d.projects.map(function (p) {
        var pill = '<span class="adk-tag ' + (p.status === "live" ? "ok" : p.status === "closed" ? "line" : "warn") + '">' +
          esc(p.status) + "</span>";
        var options = peers.map(function (peer) {
          return '<option value="' + peer.id + '">' + esc(peer.name + " · " + peer.email) + "</option>";
        }).join("");
        return '<article class="adk-project" data-slug="' + esc(p.slug) + '">' +
          '<div class="adk-project-main"><h4>' + esc(p.title || p.slug) + "</h4>" +
            "<code>" + esc(p.slug) + "</code>" +
            '<div class="adk-project-meta">' + pill +
              '<select class="adk-select" data-pstatus="' + esc(p.slug) + '" aria-label="Status of ' +
                esc(p.title || p.slug) + '">' +
                ["draft", "live", "paused", "closed"].map(function (st) {
                  return '<option value="' + st + '"' + (st === p.status ? " selected" : "") + ">" +
                    st.charAt(0).toUpperCase() + st.slice(1) + "</option>";
                }).join("") + "</select>" +
              "<span><b>" + n(p.points_used) + "</b> Kart pts</span>" +
              "<span><b>" + n(p.completes) + "</b> completes</span>" +
              "<span>updated " + esc(when(p.updated_at)) + "</span>" +
            "</div></div>" +
          '<div class="adk-project-actions">' +
            '<a class="adk-btn sm" href="/studio/#' + esc(p.slug) + '" title="Open this study in Studio">Studio ↗</a>' +
            '<a class="adk-btn sm" href="/admin/?study=' + esc(p.slug) + '" title="Open this study in Monitor">Monitor ↗</a>' +
            '<button type="button" class="adk-btn sm danger" data-act="project-delete" data-slug="' + esc(p.slug) + '">Delete</button>' +
          "</div>" +
          '<div class="adk-project-owner"><span>Owner</span>' +
            '<select class="adk-select" aria-label="Transfer ownership of ' + esc(p.title || p.slug) + '" data-owner="' + esc(p.slug) + '">' +
              '<option value="">Transfer to…</option>' + options + "</select>" +
            '<button type="button" class="adk-btn sm" data-act="project-owner" data-slug="' + esc(p.slug) + '">Transfer</button>' +
            '<button type="button" class="adk-btn sm ghost" data-act="project-take" data-slug="' + esc(p.slug) + '">Take ownership</button>' +
          "</div>" +
        "</article>";
      }).join("") + "</div>" + sharedProjectsBlock(d);
  }

  function renderRequests(d) {
    var mine = (d.requests || []).filter(function (r) { return r.status === "pending"; });
    if (!mine.length) return "";
    return '<div class="adk-box"><h3>Open Kart requests <span class="adk-tag warn">' + mine.length + "</span></h3>" +
      '<p class="adk-box-sub">Grant the points they asked for, change the amount or decline.</p>' +
      mine.map(function (r) {
        return '<div class="adk-role-row" style="margin-bottom:6px"><span><b>+' + n(r.requested_points) + " pts</b>" +
          "<small>" + (r.reason ? "“" + esc(r.reason) + "” · " : "") + esc(when(r.created_at)) + "</small></span>" +
          '<span class="adk-actions">' +
            '<input class="adk-input" id="adk-reqpts-' + r.id + '" type="number" min="0" value="' + n(r.requested_points) +
              '" style="width:72px" aria-label="Points to grant">' +
            '<button type="button" class="adk-btn primary sm" data-act="req-approve" data-req="' + r.id + '">Grant</button>' +
            '<button type="button" class="adk-btn sm" data-act="req-reject" data-req="' + r.id + '">Decline</button>' +
          "</span></div>";
      }).join("") + "</div>";
  }

  function renderKart(d) {
    var u = d.user;
    var isAdmin = u.role === "admin";
    var limit = u.points_limit || 0;
    var used = u.points_used || 0;
    var pct = Math.min(100, Math.round(100 * used / Math.max(1, limit)));
    var value = isAdmin ? "∞" : n(Math.max(0, limit - used));
    var available = Math.max(0, limit - used);
    var rows = d.ledger.map(function (t) {
      var delta = Number(t.delta || 0);
      return "<tr><td class=\"when\">" + esc(when(t.created_at)) + "</td>" +
        '<td class="adk-delta ' + (delta >= 0 ? "up" : "down") + '">' + (delta >= 0 ? "+" : "") + n(delta) + "</td>" +
        '<td class="adk-delta">' + n(t.balance_after) + "</td>" +
        "<td>" + esc(t.reason || "—") + "</td>" +
        '<td class="by">' + esc(t.actor || "system") + "</td></tr>";
    }).join("");

    var editor = isAdmin
      ? '<p class="adk-note info"><b>Unlimited admin Kart.</b> Admins do not spend Kart points on projects.</p>'
      : '<div class="adk-form">' +
          '<label class="adk-field"><span>Set the exact limit</span>' +
            '<input class="adk-input" id="adk-pts-limit" type="number" min="0" max="10000000" value="' + limit + '"></label>' +
          '<label class="adk-field"><span>Reason written to the ledger</span>' +
            '<input class="adk-input" id="adk-pts-reason" maxlength="200" placeholder="e.g. Approved extra field budget"></label>' +
          '<div class="adk-actions">' +
            '<button type="button" class="adk-btn primary" data-act="points-set">Save limit</button>' +
            '<button type="button" class="adk-btn sm" data-act="points-delta" data-delta="-50">−50</button>' +
            '<button type="button" class="adk-btn sm" data-act="points-delta" data-delta="-20">−20</button>' +
            '<button type="button" class="adk-btn sm gold" data-act="points-delta" data-delta="20">+20</button>' +
            '<button type="button" class="adk-btn sm gold" data-act="points-delta" data-delta="50">+50</button>' +
            (available > 0 ? '<button type="button" class="adk-btn sm danger" data-act="points-expire">Expire remaining points</button>' : '') +
          "</div>" +
        "</div>";

    return '<div class="adk-pane-grid">' +
      '<div class="adk-stack"><div class="adk-box">' +
        "<h3>Kart balance " + (isAdmin ? '<span class="adk-tag admin">Unlimited</span>' : '<span class="adk-tag warn">' + value + " left</span>") + "</h3>" +
        '<p class="adk-box-sub">Limit ' + (isAdmin ? "unlimited" : n(limit) + " pts") + " · used " + n(used) + " pts across their projects.</p>" +
        '<div class="adk-bar"><i style="width:' + (isAdmin ? 100 : pct) + '%"></i></div>' +
        '<hr class="adk-divider">' + editor +
      "</div></div>" +
      '<div class="adk-stack">' + renderRequests(d) +
        '<div class="adk-box subtle"><h3>How the Kart works</h3>' +
        '<p class="adk-box-sub">Points are a limit, not a balance you top up forever: building questions spends from the limit, and the ledger records every admin change with a reason.</p>' +
        '<p class="adk-hint">Approval grants the welcome allocation exactly once. Revoking points never deletes a project.</p></div>' +
      "</div></div>" +
      '<div class="adk-ledger" style="margin-top:14px">' +
        '<div class="adk-table-wrap"><table class="adk-table"><thead><tr>' +
          "<th>When</th><th>Change</th><th>Limit after</th><th>Reason</th><th>By</th>" +
        "</tr></thead><tbody>" + (rows || '<tr><td colspan="5" class="adk-list-empty">No Kart transactions recorded yet.</td></tr>') +
        "</tbody></table></div></div>";
  }

  function activityLabel(action) {
    var labels = {
      "auth/signin": ["Signed in", "signin"],
      "auth/admin-signin": ["Admin signed in", "signin"],
      "auth/register": ["Registered on SurveyKart", "account"],
      "auth/approval-request": ["Requested approval", "account"],
      "console/decision": ["Account decision", "account"],
      "console/role": ["Role changed", "account"],
      "console/points": ["Kart points adjusted", "account"],
      "console/point-request": ["Kart request processed", "account"],
      "console/profile": ["Identity edited", "account"],
      "console/impersonate": ["Support view opened", "account"],
      "console/impersonate-end": ["Support view closed", "account"],
      "console/delete-account": ["Account deleted", "account"],
      "kart/request-points": ["Requested more Kart points", "account"],
      "share/create": ["Shared a project link", "design"],
      "share/redeem": ["Opened a shared link", "design"],
      "/api/studio/save": ["Edited a design", "design"],
      "/api/studio/status": ["Changed a study status", "design"],
      "/api/studio/delete": ["Deleted a study", "design"],
      "/api/studio/duplicate": ["Duplicated a study", "design"],
      "/api/studio/launch": ["Launched fieldwork", "field"],
      "/api/studio/relaunch": ["Relaunched fieldwork", "field"],
      "/api/studio/pause": ["Paused fieldwork", "field"],
      "/api/studio/remind": ["Sent reminders", "field"],
      "/api/workspace/publish": ["Published a version", "design"],
      "/api/workspace/review": ["Reviewed a version", "design"],
      "/api/workspace/comments": ["Left a comment", "design"],
      "/api/workspace/export": ["Exported data", "data"],
      "/api/workspace/export_ppt": ["Exported a deck", "data"],
      "/api/workspace/verbatims": ["Read verbatims", "data"],
      "/admin/export": ["Downloaded an extract", "data"],
      "/api/start": ["Started a test run", "field"]
    };
    if (labels[action]) return labels[action];
    for (var key in labels) {
      if (action && action.indexOf(key) === 0) return labels[key];
    }
    return [action || "Activity", "other"];
  }

  function renderActivity(d) {
    if (!d.activity.length) {
      return '<div class="adk-empty-inline"><b>Nothing recorded yet</b>' +
        "Sign-ins, design edits, exports and admin changes will appear here as they happen.</div>";
    }
    return '<div class="adk-box"><div class="adk-section-head"><h3>Audit trail</h3>' +
      "<p>Newest first · last " + d.activity.length + " recorded actions</p></div>" +
      '<ul class="adk-timeline">' + d.activity.map(function (ev) {
        var pair = activityLabel(ev.action);
        return '<li class="adk-ev k-' + pair[1] + '"><i class="adk-ev-dot" aria-hidden="true"></i>' +
          '<div class="adk-ev-body"><p><b>' + esc(pair[0]) + "</b>" +
            (ev.study ? " · <code>" + esc(ev.study) + "</code>" : "") + "</p>" +
            (ev.detail ? "<small>" + esc(ev.detail) + "</small>" : "") +
          "</div>" +
          '<span class="adk-ev-when">' + esc(when(ev.created_at)) + "</span></li>";
      }).join("") + "</ul></div>";
  }

  function renderDetail() {
    var d = state.detail;
    var placeholder = document.getElementById("adk-placeholder");
    var host = document.getElementById("adk-detail");
    if (!d) {
      placeholder.hidden = false;
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    placeholder.hidden = true;
    host.hidden = false;

    var body = state.tab === "projects" ? renderProjects(d)
             : state.tab === "kart" ? renderKart(d)
             : state.tab === "activity" ? renderActivity(d)
             : renderOverview(d);

    host.innerHTML = passportHtml(d) + tabsHtml(d) +
      '<div role="tabpanel">' + body + "</div>";
  }

  // ------------------------------------------------------------------ loading
  function loadOverview(silent) {
    return api("/api/admin/console/overview").then(function (out) {
      if (out.error) {
        document.getElementById("adk-list-foot").textContent = out.error;
        if (!silent) fail(out);
        return out;
      }
      state.users = out.users || [];
      state.stats = out.stats || {};
      state.requests = out.point_requests || [];
      renderStats();
      renderQueue();
      renderRoster();
      loadRecovery();
      return out;
    });
  }

  function loadDetail(id, silent) {
    if (!id) { state.detail = null; renderDetail(); return Promise.resolve(); }
    return api("/api/admin/console/account?user_id=" + encodeURIComponent(id)).then(function (out) {
      if (out.error) {
        state.detail = null;
        renderDetail();
        if (!silent) fail(out);
        return out;
      }
      state.detail = out;
      var u = out.user;
      // only the last remaining admin may not be demoted (mirrors the server rule)
      u._lastAdmin = u.role === "admin" && state.users.filter(function (x) {
        return x.role === "admin" && x.status === "approved";
      }).length <= 1;
      state.selectedId = u.id;
      renderRoster();
      renderDetail();
      return out;
    });
  }

  function selectUser(id, silent) {
    if (!id || (id === state.selectedId && state.detail)) return;
    state.selectedId = id;
    state.tab = "overview";
    if (location.hash !== "#user-" + id) {
      history.replaceState(null, "", "#user-" + id);
    }
    renderRoster();
    loadDetail(id, silent);
  }

  function refreshAll(message) {
    if (message) toast(message);
    return loadOverview(true).then(function () {
      return loadDetail(state.selectedId, true);
    });
  }

  // ------------------------------------------------------------------ actions
  function value(id) {
    var el = document.getElementById(id);
    return el ? el.value : "";
  }

  function run(btn, work) {
    if (btn) btn.disabled = true;
    var done = function () { if (btn) btn.disabled = false; };
    return work().then(done, function () { done(); fail({ error: "The request failed. Reload and try again." }); });
  }

  var handlers = {
    "tab": function (btn) {
      state.tab = btn.getAttribute("data-tab") || "overview";
      renderDetail();
    },
    "refresh": function () {
      loadDetail(state.selectedId);
    },
    "open": function (btn) {
      selectUser(+btn.getAttribute("data-id"));
      var pane = document.getElementById("adk-pane");
      if (pane && pane.scrollIntoView) pane.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    "profile-save": function (btn) {
      var u = state.detail && state.detail.user;
      if (!u) return Promise.resolve();
      var body = {
        user_id: u.id,
        name: value("adk-name"),
        username: u.is_protected ? undefined : value("adk-username"),
        email: u.is_protected ? undefined : value("adk-email")
      };
      if (u.is_protected) { delete body.username; delete body.email; }
      return run(btn, function () {
        return api("/api/admin/console/profile", body).then(function (out) {
          if (out.error) { fail(out); return; }
          return refreshAll("Identity saved.");
        });
      });
    },
    "status": function (btn) {
      var u = state.detail && state.detail.user;
      if (!u) return Promise.resolve();
      var decision = btn.getAttribute("data-decision");
      var labels = {
        approve: "Approve this account and open Workspace & Studio?",
        reject: "Reject this request? They will not be able to sign in.",
        disable: "Pause this account? Access ends immediately.",
        enable: "Re-enable this account and restore access?"
      };
      if (!window.confirm(labels[decision] || "Apply this decision?")) return Promise.resolve();
      var body = { user_id: u.id, decision: decision };
      if (decision === "approve" && u.status === "pending") {
        var pts = parseInt(value("adk-welcome"), 10);
        if (!isNaN(pts)) body.points = pts;
      }
      return run(btn, function () {
        return api("/api/admin/console/decision", body).then(function (out) {
          if (out.error) { fail(out); return; }
          var extra = out.welcome_points_granted ? " · " + out.welcome_points_granted + " Kart pts added" : "";
          return refreshAll("Account " + decision + "d" + extra + ".");
        });
      });
    },
    "role": function (btn) {
      var u = state.detail && state.detail.user;
      if (!u) return Promise.resolve();
      var role = btn.getAttribute("data-role");
      var q = role === "admin"
        ? "Give this account full admin rights? They will see every account and project."
        : "Revoke admin rights for this account?";
      if (!window.confirm(q)) return Promise.resolve();
      return run(btn, function () {
        return api("/api/admin/console/role", { user_id: u.id, role: role }).then(function (out) {
          if (out.error) { fail(out); return; }
          return refreshAll(role === "admin" ? "Admin rights granted." : "Admin rights revoked.");
        });
      });
    },
    "points-tab": function () {
      state.tab = "kart";
      renderDetail();
      if (state.selectedId && location.hash !== "#user-" + state.selectedId) {
        history.replaceState(null, "", "#user-" + state.selectedId);
      }
      return Promise.resolve();
    },
    "points-apply": function (btn) {
      var u = state.detail && state.detail.user;
      if (!u) return Promise.resolve();
      if (u.role === "admin") { toast("Admins have an unlimited Kart — nothing to adjust.", true); return Promise.resolve(); }
      var amount = parseInt(value("adk-quick-amt"), 10);
      if (isNaN(amount) || amount <= 0) {
        toast("Enter how many points to add or remove (1 or more).", true);
        return Promise.resolve();
      }
      var removing = btn.getAttribute("data-mode") === "remove";
      var delta = removing ? -amount : amount;
      var reason = String(value("adk-quick-reason") || "").trim();
      return run(btn, function () {
        return api("/api/admin/console/points", {
          user_id: u.id, delta: delta,
          reason: reason || (removing ? "Admin removed " + amount + " Kart points"
                                     : "Admin added " + amount + " Kart points")
        }).then(function (out) {
          if (out.error) { fail(out); return; }
          var left = out.user && out.user.points_balance;
          refreshAll((removing ? "\u2212" : "+") + amount + " Kart points applied" +
                     (left != null ? " · " + n(left) + " left" : "") + ".");
        });
      });
    },
    "points-expire": function (btn) {
      var u = state.detail && state.detail.user;
      if (!u || u.role === "admin") return Promise.resolve();
      var balance = Math.max(0, (u.points_limit || 0) - (u.points_used || 0));
      if (!balance) { toast("This account has no available points to expire.", true); return Promise.resolve(); }
      if (!window.confirm("Expire all " + n(balance) + " unused Kart points for " + firstName(u) + "? This takes effect immediately and is recorded in the ledger.")) {
        return Promise.resolve();
      }
      return run(btn, function () {
        return api("/api/admin/console/points", {
          user_id: u.id, expire_remaining: true,
          reason: "Admin expired " + balance + " remaining Kart points"
        }).then(function (out) {
          if (out.error) { fail(out); return; }
          return refreshAll(n(out.points_expired || balance) + " remaining Kart points expired.");
        });
      });
    },
    "points-delta": function (btn) {
      var u = state.detail && state.detail.user;
      if (!u) return Promise.resolve();
      var delta = parseInt(btn.getAttribute("data-delta") || "0", 10);
      return run(btn, function () {
        return api("/api/admin/console/points", {
          user_id: u.id, delta: delta, reason: value("adk-pts-reason")
        }).then(function (out) {
          if (out.error) { fail(out); return; }
          return refreshAll((delta > 0 ? "+" : "") + delta + " Kart points applied.");
        });
      });
    },
    "points-set": function (btn) {
      var u = state.detail && state.detail.user;
      if (!u) return Promise.resolve();
      var limit = parseInt(value("adk-pts-limit"), 10);
      if (isNaN(limit) || limit < 0) { toast("Enter a Kart limit of 0 or more.", true); return Promise.resolve(); }
      return run(btn, function () {
        return api("/api/admin/console/points", {
          user_id: u.id, points_limit: limit, reason: value("adk-pts-reason")
        }).then(function (out) {
          if (out.error) { fail(out); return; }
          return refreshAll("Kart limit set to " + limit + " pts.");
        });
      });
    },
    "queue-approve": function (btn) {
      var id = +btn.getAttribute("data-id");
      var pts = parseInt(value("adk-qpts-" + id), 10);
      if (!window.confirm("Approve this account and add " + (isNaN(pts) ? 100 : pts) + " welcome Kart points?")) {
        return Promise.resolve();
      }
      return run(btn, function () {
        return api("/api/admin/console/decision", {
          user_id: id, decision: "approve", points: isNaN(pts) ? undefined : pts
        }).then(function (out) {
          if (out.error) { fail(out); return; }
          return refreshAll("Approved — welcome Kart points added.");
        });
      });
    },
    "recovery-issue": function (btn) {
      var u = state.detail && state.detail.user;
      if (!u) return Promise.resolve();
      return run(btn, function () {
        return api("/api/admin/console/recovery/issue", { user_id: u.id }).then(function (out) {
          if (out.error) { fail(out); return; }
          var host = document.getElementById("adk-recovery-out");
          if (host) {
            host.hidden = false;
            host.innerHTML = linkBox(out.link, out.message);
          }
          toast(out.delivery === "email" ? "Recovery link e-mailed." : "Recovery link created — copy it.");
          return loadRecovery();
        });
      });
    },
    "recovery-copy": function (btn) {
      var link = btn.getAttribute("data-link") || "";
      var done = function () { toast("Link copied."); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(done, function () { toast("Copy failed — select it manually.", true); });
      } else {
        var ta = document.createElement("textarea");
        ta.value = link;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch (e) { toast("Copy failed.", true); }
        document.body.removeChild(ta);
      }
      return Promise.resolve();
    },
    "recovery-row-link": function (btn) {
      var userId = +btn.getAttribute("data-user");
      var rowId = btn.getAttribute("data-id");
      return run(btn, function () {
        return api("/api/admin/console/recovery/issue", { user_id: userId }).then(function (out) {
          if (out.error) { fail(out); return; }
          var host = document.getElementById("adk-rec-out-" + rowId);
          if (host) { host.hidden = false; host.innerHTML = linkBox(out.link, out.message); }
          toast("Fresh link ready to copy.");
          return loadRecovery();
        });
      });
    },
    "recovery-handover": function (btn) {
      return run(btn, function () {
        return api("/api/admin/console/recovery/decide", {
          reset_id: +btn.getAttribute("data-id"), action: "handed_over"
        }).then(function (out) {
          if (out.error) { fail(out); return; }
          toast("Marked as handed over.");
          return loadRecovery();
        });
      });
    },
    "recovery-revoke": function (btn) {
      if (!window.confirm("Revoke this recovery link? They will have to ask again.")) return Promise.resolve();
      return run(btn, function () {
        return api("/api/admin/console/recovery/decide", {
          reset_id: +btn.getAttribute("data-id"), action: "revoke"
        }).then(function (out) {
          if (out.error) { fail(out); return; }
          toast("Recovery link revoked.");
          return loadRecovery();
        });
      });
    },
    "queue-reject": function (btn) {
      var id = +btn.getAttribute("data-id");
      if (!window.confirm("Reject this account request?")) return Promise.resolve();
      return run(btn, function () {
        return api("/api/admin/console/decision", { user_id: id, decision: "reject" }).then(function (out) {
          if (out.error) { fail(out); return; }
          return refreshAll("Request rejected.");
        });
      });
    },
    "req-approve": function (btn) {
      var req = +btn.getAttribute("data-req");
      var pts = parseInt(value("adk-reqpts-" + req), 10);
      return run(btn, function () {
        return api("/api/admin/console/point-requests/decide", {
          request_id: req, decision: "approve", points: isNaN(pts) ? undefined : pts
        }).then(function (out) {
          if (out.error) { fail(out); return; }
          return refreshAll("Kart points granted.");
        });
      });
    },
    "req-reject": function (btn) {
      var req = +btn.getAttribute("data-req");
      return run(btn, function () {
        return api("/api/admin/console/point-requests/decide", {
          request_id: req, decision: "reject"
        }).then(function (out) {
          if (out.error) { fail(out); return; }
          return refreshAll("Kart request declined.");
        });
      });
    },
    "impersonate": function (btn) {
      var u = state.detail && state.detail.user;
      if (!u) return Promise.resolve();
      if (!window.confirm("Open SurveyKart as " + (u.name || u.email) + "?\n\n" +
          "You will see their Workspace and Studio. Every action is audited, and the strip at the top returns you here.")) {
        return Promise.resolve();
      }
      return run(btn, function () {
        return api("/api/admin/console/impersonate", { user_id: u.id }).then(function (out) {
          if (out.error) { fail(out); return; }
          window.location.href = out.redirect || "/workspace/";
        });
      });
    },
    "delete-account": function (btn) {
      var u = state.detail && state.detail.user;
      if (!u) return Promise.resolve();
      var typed = window.prompt("Type the account e-mail to confirm deletion:\n" + u.email);
      if (typed == null) return Promise.resolve();
      if (typed.trim().toLowerCase() !== String(u.email).toLowerCase()) {
        toast("That e-mail did not match — nothing was deleted.", true);
        return Promise.resolve();
      }
      return run(btn, function () {
        return api("/api/admin/console/delete", { user_id: u.id }).then(function (out) {
          if (out.error) { fail(out); return; }
          state.detail = null;
          state.selectedId = 0;
          history.replaceState(null, "", location.pathname);
          renderDetail();
          return loadOverview(true).then(function () { toast("Account deleted."); });
        });
      });
    },
    "project-delete": function (btn) {
      var slug = btn.getAttribute("data-slug");
      if (!window.confirm("Delete " + slug + " and every response in it? This cannot be undone.")) {
        return Promise.resolve();
      }
      return run(btn, function () {
        return api("/api/studio/delete", { slug: slug }).then(function (out) {
          if (out.error) { fail(out); return; }
          return refreshAll("Project deleted.");
        });
      });
    },
    "project-owner": function (btn) {
      var slug = btn.getAttribute("data-slug");
      var card = btn.closest(".adk-project-owner");
      var sel = card && card.querySelector("select");
      var target = sel && sel.value;
      if (!target) { toast("Choose the account that should own this project.", true); return Promise.resolve(); }
      return run(btn, function () {
        return api("/api/admin/console/project/owner", { slug: slug, user_id: +target }).then(function (out) {
          if (out.error) { fail(out); return; }
          return refreshAll("Project ownership transferred.");
        });
      });
    },
    "project-take": function (btn) {
      var slug = btn.getAttribute("data-slug");
      if (!window.confirm("Take ownership of " + slug + " as the signed-in admin?")) return Promise.resolve();
      return run(btn, function () {
        return api("/api/admin/console/project/owner", { slug: slug }).then(function (out) {
          if (out.error) { fail(out); return; }
          return refreshAll("You now own " + slug + ".");
        });
      });
    }
  };

  document.addEventListener("click", function (e) {
    var row = e.target.closest("[data-select]");
    if (row) {
      e.preventDefault();
      selectUser(+row.getAttribute("data-select"));
      return;
    }
    var btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    var act = btn.getAttribute("data-act");
    var fn = handlers[act];
    if (!fn) return;
    e.preventDefault();
    fn(btn);
  });

  document.addEventListener("change", function (e) {
    var owner = e.target.closest("select[data-owner]");
    if (owner) {
      var card = owner.closest(".adk-project");
      var btn = card && card.querySelector('[data-act="project-owner"]');
      if (btn) btn.classList.toggle("on", !!owner.value);
      return;
    }
    var statusSel = e.target.closest("select[data-pstatus]");
    if (statusSel) {
      var slug = statusSel.getAttribute("data-pstatus");
      var prev = (state.detail && state.detail.projects || []).filter(function (p) {
        return p.slug === slug;
      })[0];
      statusSel.disabled = true;
      api("/api/studio/status", { slug: slug, status: statusSel.value }).then(function (out) {
        statusSel.disabled = false;
        if (out.error) {
          if (prev) statusSel.value = prev.status;
          fail(out);
          return;
        }
        refreshAll("Study status set to " + statusSel.value + ".");
      });
    }
  });

  var search = document.getElementById("adk-search");
  if (search) {
    search.addEventListener("input", function () {
      state.query = search.value || "";
      renderRoster();
    });
  }

  var filters = document.getElementById("adk-filters");
  if (filters) {
    filters.addEventListener("click", function (e) {
      var b = e.target.closest("[data-filter]");
      if (!b) return;
      state.filter = b.getAttribute("data-filter");
      renderRoster();
    });
  }

  // Arrow keys move through the roster like a ledger.
  document.addEventListener("keydown", function (e) {
    if (!document.getElementById("adk-list")) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    var tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    var rows = Array.prototype.slice.call(document.querySelectorAll("#adk-list [data-select]"));
    if (!rows.length) return;
    var idx = rows.findIndex(function (r) { return +r.getAttribute("data-select") === state.selectedId; });
    var next = e.key === "ArrowDown" ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
    e.preventDefault();
    rows[next].focus();
    selectUser(+rows[next].getAttribute("data-select"));
  });

  window.addEventListener("hashchange", function () {
    var m = /^#user-(\d+)$/.exec(location.hash || "");
    if (m) selectUser(+m[1]);
  });

  // ------------------------------------------------------------------ boot
  var initial = /^#user-(\d+)$/.exec(location.hash || "");
  loadOverview().then(function (out) {
    if (out && out.error) return;
    var wanted = initial ? +initial[1] : 0;
    var exists = state.users.some(function (u) { return u.id === wanted; });
    var firstPending = state.users.filter(function (u) { return u.status === "pending"; })[0];
    var target = exists ? wanted : (firstPending || state.users[0] || {}).id;
    if (target) selectUser(target, true);
    else renderDetail();
  });
})();
