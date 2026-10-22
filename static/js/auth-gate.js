/* Sign-in / registration / recovery page behaviour.
   The Google buttons are plain links (full redirects, best for OAuth); this
   script runs the recovery lookup and the development sign-in shortcut. */
(function () {
  var mode = document.body.getAttribute("data-mode") || "login";

  // ---- forgot user ID: look the address up -------------------------------
  var form = document.getElementById("recover-form");
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    var out = document.getElementById("recover-out");
    out.hidden = false;
    out.className = "ln-gate-out";
    out.innerHTML = "<span>Looking\u2026</span>";
    fetch("/api/auth/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: (document.getElementById("recover-email") || {}).value || "" })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.error) { out.className = "ln-gate-out warn"; out.innerHTML = "<span>" + esc(res.error) + "</span>"; return; }
      out.className = "ln-gate-out" + (res.found ? "" : " warn");
      out.innerHTML = "<span>" + esc(res.message) + "</span>" +
        (res.found && res.status === "approved"
          ? '<a class="ln-btn ln-btn-primary" href="/signin">Go to sign in</a>' : "");
    });
  });

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- development sign-in shortcut (only rendered when DEV_LOGIN is on) --
  var devbox = document.getElementById("ln-devbox");
  var devform = document.getElementById("ln-devform");
  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (me.dev_login && devbox) devbox.hidden = false;
      if (me.user && me.user.status === "approved" && mode !== "recover") {
        var card = document.querySelector(".ln-gate-card");
        if (card) card.insertAdjacentHTML("afterbegin",
          '<p class="ln-gate-joined">Signed in as <b>' + esc(me.user.email) +
          '</b> &middot; <a href="/workspace/">Open workspace</a></p>');
      }
    }).catch(function () {});

  var adminBtn = document.getElementById("ln-dev-admin");
  if (adminBtn) adminBtn.addEventListener("click", function () {
    var email = document.getElementById("ln-dev-email"), name = document.getElementById("ln-dev-name");
    if (email) email.value = "admin@anaking.test";
    if (name) name.value = "Admin";
    if (devform && devform.requestSubmit) devform.requestSubmit();
  });

  if (devform) devform.addEventListener("submit", function (e) {
    e.preventDefault();
    fetch("/auth/dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: (document.getElementById("ln-dev-email") || {}).value || "",
        name: (document.getElementById("ln-dev-name") || {}).value || "",
        mode: mode
      })
    }).then(function (r) { return r.json(); }).then(function (out) {
      if (out.error) {
        if (out.need_register && confirm(out.error + "\n\nGo to registration?")) {
          location.href = "/register?email=" + encodeURIComponent(out.email || "");
          return;
        }
        alert(out.error);
        return;
      }
      location.href = "/workspace/";
    });
  });
})();
