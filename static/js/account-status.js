/* /welcome — unobtrusive status polling and account switching. */
(function () {
  var initialStatus = document.body.getAttribute("data-status") || "";
  var hint = document.getElementById("sk-check-hint");
  var checking = false;
  var timer = null;

  function check() {
    if (checking) return;
    checking = true;
    fetch("/api/me", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (me) {
        checking = false;
        if (!me || !me.user) { location.href = "/signin?next=/welcome"; return; }
        if (me.user.status !== initialStatus) {
          if (hint) hint.textContent = me.user.status === "approved"
            ? "Approved — refreshing your account and Kart balance…"
            : "Your account status changed — refreshing…";
          if (timer) clearInterval(timer);
          setTimeout(function () { location.reload(); }, 700);
        }
      })
      .catch(function () { checking = false; });
  }

  if (initialStatus === "pending") {
    timer = setInterval(check, 15000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) check();
    });
  }

  // Sign out, then land on sign-in so a different account can be used.
  var form = document.getElementById("sk-signout-form");
  if (form) form.addEventListener("submit", function (e) {
    var button = form.querySelector("[data-signout]");
    var dest = button ? button.getAttribute("data-signout") : "";
    if (!dest) return;
    e.preventDefault();
    fetch("/auth/logout", { method: "POST", headers: { "X-Requested-With": "fetch" } })
      .then(function () { location.href = dest; })
      .catch(function () { location.href = dest; });
  });
})();
