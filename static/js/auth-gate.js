/* SurveyKart Sign-in / Registration (+100 Kart pts) / Share-Redemption / Recovery behaviour. */
(function () {
  var mode = document.body.getAttribute("data-mode") || "login";
  var nextUrl = document.body.getAttribute("data-next") || "";
  var shareToken = document.body.getAttribute("data-share") || "";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function showGateMsg(msg, isWarn) {
    var box = document.getElementById("gate-msg");
    if (!box) { alert(msg); return; }
    box.hidden = false;
    box.className = "ln-gate-out" + (isWarn ? " warn" : "");
    box.innerHTML = "<span>" + esc(msg) + "</span>";
  }

  // ---- Direct SurveyKart Login (Username/E-mail + Password) ----------------
  var loginForm = document.getElementById("sk-login-form");
  if (loginForm) loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = document.getElementById("login-submit");
    if (btn) btn.disabled = true;
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: (document.getElementById("login-ident") || {}).value || "",
        password: (document.getElementById("login-password") || {}).value || "",
        next: nextUrl,
        share_token: shareToken
      })
    }).then(function (r) { return r.json(); }).then(function (out) {
      if (btn) btn.disabled = false;
      if (out.error) {
        showGateMsg(out.error, true);
        return;
      }
      location.href = out.redirect || "/studio/";
    }).catch(function () {
      if (btn) btn.disabled = false;
      showGateMsg("Sign-in request could not be completed. Please try again.", true);
    });
  });

  // ---- Direct SurveyKart Registration (+100 Kart Points) -------------------
  var regForm = document.getElementById("sk-register-form");
  if (regForm) regForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = document.getElementById("reg-submit");
    if (btn) btn.disabled = true;
    fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: (document.getElementById("reg-name") || {}).value || "",
        email: (document.getElementById("reg-email") || {}).value || "",
        username: (document.getElementById("reg-username") || {}).value || "",
        password: (document.getElementById("reg-password") || {}).value || "",
        next: nextUrl,
        share_token: shareToken
      })
    }).then(function (r) { return r.json(); }).then(function (out) {
      if (btn) btn.disabled = false;
      if (out.error) {
        showGateMsg(out.error, true);
        return;
      }
      location.href = out.redirect || "/studio/";
    }).catch(function () {
      if (btn) btn.disabled = false;
      showGateMsg("Registration could not be completed. Please try again.", true);
    });
  });

  // ---- Account lookup / recovery -------------------------------------------
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
          '<p class="ln-gate-joined">Signed in as <b>' + esc(me.user.username || me.user.email) +
          '</b> &middot; <a href="/studio/">Open Studio</a> &middot; <a href="/workspace/">Projects</a></p>');
      }
    }).catch(function () {});

  var adminBtn = document.getElementById("ln-dev-admin");
  if (adminBtn) adminBtn.addEventListener("click", function () {
    var email = document.getElementById("ln-dev-email"), name = document.getElementById("ln-dev-name");
    if (email) email.value = "admin@surveykart.local";
    if (name) name.value = "SurveyKart Admin";
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
      location.href = out.redirect || (out.user && out.user.status !== "approved" ? "/welcome" : "/studio/");
    });
  });
})();
