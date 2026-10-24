/* SurveyKart Admin Console: manage accounts, increase/decrease Kart point allocations,
   process Kart point requests, and govern all studies. */
(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function api(path, body) {
    return fetch(path, body ? {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    } : undefined).then(function (r) {
      return r.json().catch(function () { return { error: "Request failed (" + r.status + ")" }; });
    });
  }

  var STATUS_CLS = { pending: "st-pending", approved: "st-ok", rejected: "st-no", disabled: "st-no" };

  function renderStats(s) {
    document.getElementById("cs-stats").innerHTML =
      '<div class="cs-stat"><b>' + s.users + '</b><span>users</span></div>' +
      '<div class="cs-stat"><b>' + (s.pending_point_requests || 0) + '</b><span>pt requests</span></div>' +
      '<div class="cs-stat"><b>' + s.pending + '</b><span>pending</span></div>' +
      '<div class="cs-stat"><b>' + s.projects + '</b><span>projects</span></div>' +
      '<div class="cs-stat"><b>' + s.completes + '</b><span>completes</span></div>';
  }

  function renderPointRequests(reqs) {
    var pending = (reqs || []).filter(function (r) { return r.status === "pending"; });
    var box = document.getElementById("cs-point-reqs");
    if (!box) return;
    box.hidden = pending.length === 0;
    document.getElementById("cs-point-req-list").innerHTML = pending.map(function (r) {
      return '<div class="cs-pending-card">' +
        '<b>' + esc(r.user_name || r.user_email) + ' &middot; <span style="color:#14614f">+' + r.requested_points + ' pts</span></b>' +
        '<small>' + esc(r.user_email) + ' &middot; current limit: ' + (r.current_limit || 100) + ' pts</small>' +
        (r.reason ? '<small>Reason: "' + esc(r.reason) + '"</small>' : '') +
        '<span>' +
          '<input type="number" class="cs-pts-input" id="req-pts-' + r.id + '" value="' + r.requested_points + '" min="1" max="100000" title="Points to grant">' +
          '<button class="cs-btn ok sm" data-act="req-approve" data-req="' + r.id + '">Approve &amp; Add Pts</button>' +
          '<button class="cs-btn no sm" data-act="req-reject" data-req="' + r.id + '">Decline</button>' +
        '</span></div>';
    }).join("");
  }

  function kartControls(u) {
    if (u.is_protected || u.role === "admin") {
      return '<div class="cs-kart-cell">' +
        '<span class="cs-kart-badge">&#9733; Unlimited Admin Kart (' + (u.points_used || 0) + ' pts used)</span>' +
      '</div>';
    }
    if (u.status === "pending") {
      return '<div class="cs-kart-cell">' +
        '<span class="cs-kart-badge">&#8987; ' + (u.welcome_points_pending || 100) + ' Kart pts on approval</span>' +
        '<small style="display:block;color:var(--muted,#5c574e);margin-top:4px">added automatically when you approve</small>' +
      '</div>';
    }
    var used = u.points_used || 0;
    var limit = u.points_limit != null ? u.points_limit : 100;
    var bal = Math.max(0, limit - used);
    return '<div class="cs-kart-cell">' +
      '<div class="cs-kart-meter">' +
        '<span class="cs-kart-badge">&#128722; ' + bal + ' left</span>' +
        '<small>(' + used + ' / ' + limit + ' pts)</small>' +
      '</div>' +
      '<div class="cs-kart-ctrls">' +
        '<button class="cs-btn sm no" data-act="pts-delta" data-id="' + u.id + '" data-delta="-20" title="Decrease limit by 20 pts">&minus;20</button>' +
        '<button class="cs-btn sm ok" data-act="pts-delta" data-id="' + u.id + '" data-delta="20" title="Increase limit by 20 pts">+20</button>' +
        '<button class="cs-btn sm gold" data-act="pts-delta" data-id="' + u.id + '" data-delta="50" title="Increase limit by 50 pts">+50</button>' +
        '<input type="number" class="cs-pts-input" id="pts-set-' + u.id + '" value="' + limit + '" min="0" max="1000000" aria-label="Point limit">' +
        '<button class="cs-btn sm ghost" data-act="pts-set" data-id="' + u.id + '">Set</button>' +
      '</div>' +
    '</div>';
  }

  function actions(u) {
    var h = "";
    if (u.is_protected) {
      h += '<span class="cs-pill st-ok" title="Protected Master Admin Account">Protected Master Admin</span> ';
      h += '<button class="cs-btn ghost" data-act="projects" data-id="' + u.id +
           '" data-name="' + esc(u.name || u.email) + '">Projects</button>';
      return h;
    }
    if (u.status === "pending") {
      h += '<button class="cs-btn ok" data-act="approve" data-id="' + u.id + '">Approve</button>' +
           '<button class="cs-btn no" data-act="reject" data-id="' + u.id + '">Reject</button>';
    } else if (u.status === "disabled") {
      h += '<button class="cs-btn ok" data-act="enable" data-id="' + u.id + '">Re-enable</button>';
    } else {
      h += '<button class="cs-btn no" data-act="disable" data-id="' + u.id + '">Disable</button>';
    }
    h += u.role === "admin"
      ? '<button class="cs-btn ghost" data-act="demote" data-id="' + u.id + '">Make user</button>'
      : '<button class="cs-btn ghost" data-act="promote" data-id="' + u.id + '">Make admin</button>';
    h += '<button class="cs-btn ghost" data-act="projects" data-id="' + u.id +
         '" data-name="' + esc(u.name || u.email) + '">Projects</button>';
    return h;
  }

  function renderUsers(users) {
    var rows = users.map(function (u) {
      var initials = esc((u.name || u.username || u.email || "U").slice(0, 2).toUpperCase());
      var subline = u.username ? (esc(u.username) + " · " + esc(u.email)) : esc(u.email);
      if (u.auth_source === "google") subline += ' · <span class="cs-pill st-ok">Google</span>';
      return '<tr class="' + (u.status === "pending" ? "is-pending" : "") + '">' +
        '<td class="cs-person">' +
          (u.picture ? '<img src="' + esc(u.picture) + '" alt="">' : '<i class="cs-av">' + initials + '</i>') +
          '<span><b>' + esc(u.name || u.username || "—") + '</b><small>' + subline + '</small></span></td>' +
        '<td><span class="cs-pill ' + (STATUS_CLS[u.status] || "") + '">' + esc(u.status) + '</span></td>' +
        '<td><b>' + esc(u.role) + '</b></td>' +
        '<td>' + kartControls(u) + '</td>' +
        '<td>' + u.projects + '</td>' +
        '<td>' + u.completes + '</td>' +
        '<td class="cs-when">' + esc((u.last_login || u.created_at || "").replace("T", " ").slice(0, 16)) + '</td>' +
        '<td class="cs-acts">' + actions(u) + '</td></tr>';
    }).join("");
    document.getElementById("cs-rows").innerHTML = rows ||
      '<tr><td colspan="8" class="cs-empty">No accounts yet. New registrations receive 100 Kart points automatically.</td></tr>';

    var pending = users.filter(function (u) { return u.status === "pending"; });
    var box = document.getElementById("cs-pending");
    box.hidden = pending.length === 0;
    document.getElementById("cs-pending-list").innerHTML = pending.map(function (u) {
      var src = u.auth_source === "google" ? ' <span class="cs-pill st-ok">Google</span>' : '';
      var pts = u.welcome_points_pending || 100;
      return '<div class="cs-pending-card"><b>' + esc(u.name || u.email) + src + '</b>' +
        '<small>' + esc(u.email) + ' · signed up ' + esc((u.created_at || "").replace("T", " ").slice(0, 16)) + '</small>' +
        '<small>&#8987; Approval adds the welcome allocation below to their Kart (exactly once).</small>' +
        '<span>' +
          '<input type="number" class="cs-pts-input" id="approve-pts-' + u.id + '" value="' + pts + '" min="0" max="100000" title="Welcome Kart points to add on approval" aria-label="Welcome Kart points">' +
          '<button class="cs-btn ok" data-act="approve" data-id="' + u.id + '">Approve &amp; add pts</button>' +
          '<button class="cs-btn no" data-act="reject" data-id="' + u.id + '">Reject</button>' +
        '</span></div>';
    }).join("");
  }

  function load() {
    api("/api/admin/console/overview").then(function (out) {
      if (out.error) { alert(out.error); return; }
      renderStats(out.stats);
      renderPointRequests(out.point_requests || []);
      renderUsers(out.users);
    });
  }

  function decide(id, act) {
    var body = { user_id: +id, decision: act };
    var labels = { reject: "Reject this account?",
                   disable: "Disable this account? They lose access immediately.",
                   enable: "Re-enable this account?" };
    if (act === "approve") {
      var inp = document.getElementById("approve-pts-" + id);
      var pts = inp ? parseInt(inp.value || "100", 10) : 100;
      if (isNaN(pts) || pts < 0) pts = 100;
      body.points = pts;
      labels.approve = "Approve this account and add " + pts + " welcome Kart points to their Kart?";
    }
    if (!confirm(labels[act] || act)) return;
    api("/api/admin/console/decision", body).then(function (out) {
      if (out.error) alert(out.error); else load();
    });
  }

  var STATUSES = ["draft", "live", "paused", "closed"];

  function showProjects(id, name) {
    api("/api/admin/console/projects?user_id=" + id).then(function (out) {
      if (out.error) { alert(out.error); return; }
      var box = document.getElementById("cs-projects");
      box.hidden = false;
      box.dataset.userId = id;
      document.getElementById("cs-projects-title").textContent = "Projects built by " + name;
      document.getElementById("cs-project-rows").innerHTML = out.projects.map(function (p) {
        return '<tr data-slug="' + esc(p.slug) + '"><td><b>' + esc(p.title) + '</b></td><td><code>' + esc(p.slug) + '</code></td>' +
          '<td><select class="cs-status" data-act="proj-status" data-slug="' + esc(p.slug) + '" title="Change study status">' +
            STATUSES.map(function (st) {
              return '<option value="' + st + '"' + (st === p.status ? " selected" : "") + '>' + st + '</option>';
            }).join("") + '</select></td>' +
          '<td><span class="cs-kart-badge">' + (p.points_used || 0) + ' pts</span></td>' +
          '<td>' + (p.completes || 0) + '</td>' +
          '<td class="cs-when">' + esc((p.updated_at || "").replace("T", " ").slice(0, 16)) + '</td>' +
          '<td class="cs-acts"><a class="cs-btn ghost" href="/studio/#' + esc(p.slug) + '">Open in Studio</a> ' +
          '<a class="cs-btn ghost" href="/admin/?study=' + esc(p.slug) + '">Monitor</a> ' +
          '<button class="cs-btn ghost" data-act="proj-own" data-slug="' + esc(p.slug) + '">Take ownership</button> ' +
          '<button class="cs-btn no" data-act="proj-del" data-slug="' + esc(p.slug) + '">Delete</button></td></tr>';
      }).join("") || '<tr><td colspan="7" class="cs-empty">Nothing built yet.</td></tr>';
      box.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function manageProject(act, slug, el) {
    if (act === "proj-status") {
      return api("/api/studio/status", { slug: slug, status: el.value }).then(function (out) {
        if (out.error) alert(out.error); else load();
      });
    }
    if (act === "proj-own") {
      if (!confirm("Take ownership of " + slug + "? You become its main owner (full access is already yours).")) return;
      return api("/api/admin/console/project/owner", { slug: slug }).then(function (out) {
        if (out.error) alert(out.error); else {
          var box = document.getElementById("cs-projects");
          showProjects(box.dataset.userId, document.getElementById("cs-projects-title").textContent.replace("Projects built by ", ""));
        }
      });
    }
    if (act === "proj-del") {
      if (!confirm("Delete " + slug + " and all of its responses? This cannot be undone.")) return;
      return api("/api/studio/delete", { slug: slug }).then(function (out) {
        if (out.error) alert(out.error); else {
          var box = document.getElementById("cs-projects");
          showProjects(box.dataset.userId, document.getElementById("cs-projects-title").textContent.replace("Projects built by ", ""));
          load();
        }
      });
    }
  }

  document.addEventListener("change", function (e) {
    var sel = e.target.closest('select[data-act="proj-status"]');
    if (sel) manageProject("proj-status", sel.getAttribute("data-slug"), sel);
  });

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id");
    if (act === "pts-delta") {
      var delta = parseInt(b.getAttribute("data-delta") || "0", 10);
      return api("/api/admin/console/points", { user_id: +id, delta: delta }).then(function (out) {
        if (out.error) alert(out.error); else load();
      });
    }
    if (act === "pts-set") {
      var inp = document.getElementById("pts-set-" + id);
      var val = inp ? parseInt(inp.value || "0", 10) : 100;
      return api("/api/admin/console/points", { user_id: +id, points_limit: val }).then(function (out) {
        if (out.error) alert(out.error); else load();
      });
    }
    if (act === "req-approve" || act === "req-reject") {
      var reqId = parseInt(b.getAttribute("data-req") || "0", 10);
      var ptsInp = document.getElementById("req-pts-" + reqId);
      var pts = ptsInp ? parseInt(ptsInp.value || "0", 10) : undefined;
      return api("/api/admin/console/point-requests/decide", {
        request_id: reqId,
        decision: act === "req-approve" ? "approve" : "reject",
        points: pts
      }).then(function (out) {
        if (out.error) alert(out.error); else load();
      });
    }
    if (act === "proj-del" || act === "proj-own") return manageProject(act, b.getAttribute("data-slug"));
    if (act === "projects") return showProjects(id, b.getAttribute("data-name") || "");
    if (act === "promote" || act === "demote") {
      if (act === "promote" && !confirm("Give this account full admin rights?")) return;
      return api("/api/admin/console/role", {
        user_id: +id, role: act === "promote" ? "admin" : "user"
      }).then(function (out) { if (out.error) alert(out.error); else load(); });
    }
    decide(id, act);
  });
  document.getElementById("cs-projects-close").addEventListener("click", function () {
    document.getElementById("cs-projects").hidden = true;
  });

  load();
})();
