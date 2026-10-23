/* SurveyKart Admin Portal: animated KPI counters, user search, and 3D Kart point adjustments. */
(function () {
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.querySelectorAll(".ptl-kpi-n").forEach(function (el) {
    var target = parseInt(el.getAttribute("data-count") || "0", 10) || 0;
    if (reduce || !target) { el.textContent = String(target); return; }
    var t0 = null, dur = 900;
    function step(t) {
      if (!t0) t0 = t;
      var p = Math.min(1, (t - t0) / dur);
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });

  var search = document.getElementById("ptl-search");
  if (search) search.addEventListener("input", function () {
    var q = search.value.trim().toLowerCase();
    document.querySelectorAll("#ptl-rows tr[data-search]").forEach(function (row) {
      row.style.display = !q || row.getAttribute("data-search").indexOf(q) !== -1 ? "" : "none";
    });
  });

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-ptl-pts]");
    if (!btn) return;
    var uid = parseInt(btn.getAttribute("data-uid") || "0", 10);
    var delta = parseInt(btn.getAttribute("data-ptl-pts") || "0", 10);
    btn.disabled = true;
    fetch("/api/admin/console/points", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: uid, delta: delta })
    }).then(function (r) { return r.json(); }).then(function (out) {
      btn.disabled = false;
      if (out.error) { alert(out.error); return; }
      var u = out.user;
      var badge = document.getElementById("ptl-bal-" + uid);
      if (badge && u) {
        badge.textContent = u.points_balance + " left (" + u.points_used + "/" + u.points_limit + ")";
      }
    }).catch(function () { btn.disabled = false; });
  });
})();
