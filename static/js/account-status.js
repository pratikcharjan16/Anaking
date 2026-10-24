/* /welcome — live account-status polling.
   While an account waits for admin approval, quietly re-check /api/me every
   few seconds (and on demand); the moment the status changes, reload once so
   the server renders the new state (approved celebration + Kart balance, or
   the rejected/disabled explanation) and redeems any saved shared link. */
(function () {
  var initialStatus = document.body.getAttribute("data-status") || "";
  var hint = document.getElementById("sk-check-hint");
  var btn = document.getElementById("sk-check-now");
  var checking = false;
  var timer = null;

  function timeNow() {
    try { return new Date().toLocaleTimeString(); } catch (e) { return ""; }
  }

  function check(manual) {
    if (checking) return;
    checking = true;
    if (btn) btn.disabled = true;
    fetch("/api/me", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (me) {
        checking = false;
        if (btn) btn.disabled = false;
        if (!me || !me.user) { location.href = "/signin?next=/welcome"; return; }
        if (me.user.status !== initialStatus) {
          if (hint) hint.textContent = me.user.status === "approved"
            ? "🎉 You're approved — adding your Kart points…"
            : "Your account status changed — refreshing…";
          if (timer) clearInterval(timer);
          setTimeout(function () { location.reload(); }, 700);
          return;
        }
        if (hint) hint.textContent = "Still waiting for admin approval · last checked " + timeNow() +
          " · this page updates by itself";
      })
      .catch(function () {
        checking = false;
        if (btn) btn.disabled = false;
        if (hint && manual) hint.textContent = "Couldn't check just now — we'll keep trying automatically.";
      });
  }

  if (initialStatus === "pending") {
    timer = setInterval(function () { check(false); }, 6000);
    if (btn) btn.addEventListener("click", function () { check(true); });
    // Re-check promptly when the user returns to the tab.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) check(false);
    });
  }

  // Sign out, then land on the sign-in page (handy for switching Google accounts).
  var form = document.getElementById("sk-signout-form");
  if (form) form.addEventListener("submit", function (e) {
    var btn = form.querySelector("[data-signout]");
    var dest = btn ? btn.getAttribute("data-signout") : "";
    if (!dest) return; // plain form post -> home
    e.preventDefault();
    fetch("/auth/logout", { method: "POST", headers: { "X-Requested-With": "fetch" } })
      .then(function () { location.href = dest; })
      .catch(function () { location.href = dest; });
  });
})();
