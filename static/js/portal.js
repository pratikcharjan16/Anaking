/* Admin portal: animated KPI counters + user search. Bars animate in CSS. */
(function () {
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // count-up on the KPI tiles
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

  // live search over the users table
  var search = document.getElementById("ptl-search");
  if (search) search.addEventListener("input", function () {
    var q = search.value.trim().toLowerCase();
    document.querySelectorAll("#ptl-rows tr[data-search]").forEach(function (row) {
      row.style.display = !q || row.getAttribute("data-search").indexOf(q) !== -1 ? "" : "none";
    });
  });
})();
