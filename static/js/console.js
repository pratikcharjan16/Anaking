/* Admin console: approve or reject new profiles, manage accounts, inspect what
   each account has built.  All calls go through security.js (CSRF header). */
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
    } : undefined).then(function (r) { return r.json(); });
  }

  var STATUS_CLS = { pending: "st-pending", approved: "st-ok", rejected: "st-no", disabled: "st-no" };

  function renderStats(s) {
    document.getElementById("cs-stats").innerHTML =
      '<div class="cs-stat"><b>' + s.pending + '</b><span>pending</span></div>' +
      '<div class="cs-stat"><b>' + s.approved + '</b><span>approved</span></div>' +
      '<div class="cs-stat"><b>' + s.projects + '</b><span>projects</span></div>' +
      '<div class="cs-stat"><b>' + s.completes + '</b><span>completes</span></div>';
  }

  function actions(u) {
    var h = "";
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
      return '<tr class="' + (u.status === "pending" ? "is-pending" : "") + '">' +
        '<td class="cs-person">' +
          (u.picture ? '<img src="' + esc(u.picture) + '" alt="">' : '<i class="cs-av"></i>') +
          '<span><b>' + esc(u.name || "—") + '</b><small>' + esc(u.email) + '</small></span></td>' +
        '<td><span class="cs-pill ' + (STATUS_CLS[u.status] || "") + '">' + esc(u.status) + '</span></td>' +
        '<td>' + esc(u.role) + '</td>' +
        '<td>' + u.projects + '</td>' +
        '<td>' + u.completes + '</td>' +
        '<td class="cs-when">' + esc((u.created_at || "").replace("T", " ").slice(0, 16)) + '</td>' +
        '<td class="cs-when">' + esc((u.last_login || "").replace("T", " ").slice(0, 16)) + '</td>' +
        '<td class="cs-acts">' + actions(u) + '</td></tr>';
    }).join("");
    document.getElementById("cs-rows").innerHTML = rows ||
      '<tr><td colspan="8" class="cs-empty">No accounts yet. The first Google sign-in will land here.</td></tr>';

    var pending = users.filter(function (u) { return u.status === "pending"; });
    var box = document.getElementById("cs-pending");
    box.hidden = pending.length === 0;
    document.getElementById("cs-pending-list").innerHTML = pending.map(function (u) {
      return '<div class="cs-pending-card"><b>' + esc(u.name || u.email) + '</b>' +
        '<small>' + esc(u.email) + ' · signed up ' + esc((u.created_at || "").replace("T", " ").slice(0, 16)) + '</small>' +
        '<span><button class="cs-btn ok" data-act="approve" data-id="' + u.id + '">Approve</button>' +
        '<button class="cs-btn no" data-act="reject" data-id="' + u.id + '">Reject</button></span></div>';
    }).join("");
  }

  function load() {
    api("/api/admin/console/overview").then(function (out) {
      if (out.error) { alert(out.error); return; }
      renderStats(out.stats);
      renderUsers(out.users);
    });
  }

  function decide(id, act) {
    var labels = { approve: "Approve this account?", reject: "Reject this account?",
                   disable: "Disable this account? They lose access immediately.",
                   enable: "Re-enable this account?" };
    if (!confirm(labels[act] || act)) return;
    api("/api/admin/console/decision", { user_id: +id, decision: act }).then(function (out) {
      if (out.error) alert(out.error); else load();
    });
  }

  function showProjects(id, name) {
    api("/api/admin/console/projects?user_id=" + id).then(function (out) {
      if (out.error) { alert(out.error); return; }
      var box = document.getElementById("cs-projects");
      box.hidden = false;
      document.getElementById("cs-projects-title").textContent = "Projects built by " + name;
      document.getElementById("cs-project-rows").innerHTML = out.projects.map(function (p) {
        return '<tr><td><b>' + esc(p.title) + '</b></td><td><code>' + esc(p.slug) + '</code></td>' +
          '<td><span class="cs-pill ' + (p.status === "live" ? "st-ok" : "") + '">' + esc(p.status) + '</span></td>' +
          '<td>' + (p.completes || 0) + '</td>' +
          '<td class="cs-when">' + esc((p.updated_at || "").replace("T", " ").slice(0, 16)) + '</td>' +
          '<td><a class="cs-btn ghost" href="/studio/#' + esc(p.slug) + '">Open in Studio</a> ' +
          '<a class="cs-btn ghost" href="/admin/?study=' + esc(p.slug) + '">Monitor</a></td></tr>';
      }).join("") || '<tr><td colspan="6" class="cs-empty">Nothing built yet.</td></tr>';
      box.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id");
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
