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
      if (out.redirect && (out.pending || !out.error)) {
        // Pending / rejected / disabled accounts land on the live status page.
        if (out.notice) { try { sessionStorage.setItem("sk-notice", out.notice); } catch (e) {} }
        location.href = out.redirect;
        return;
      }
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
      // A new account is an approval request: /welcome shows the live status and
      // the 100 Kart points land the moment the admin approves.
      location.href = out.redirect || "/welcome";
    }).catch(function () {
      if (btn) btn.disabled = false;
      showGateMsg("Registration could not be completed. Please try again.", true);
    });
  });

  // ---- Account recovery: look the account up, then send a one-time link ------
  function recoverCard() { return document.getElementById("recover-out"); }

  function recoverIdent() {
    var el = document.getElementById("recover-email");
    return el ? String(el.value || "").trim() : "";
  }

  function recoverMessage(html, warn) {
    var out = recoverCard();
    if (!out) return;
    out.hidden = false;
    out.className = "ln-gate-out" + (warn ? " warn" : "");
    out.innerHTML = html;
  }

  var form = document.getElementById("recover-form");
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!recoverIdent()) { recoverMessage("Enter your e-mail address or username.", true); return; }
    recoverMessage("<span>Looking\u2026</span>");
    fetch("/api/auth/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: recoverIdent() })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.error) { recoverMessage(esc(res.error), true); return; }
      recoverMessage("<span>" + esc(res.message) + "</span>" +
        (res.found
          ? '<button class="ln-btn ln-btn-primary" type="button" id="recover-send">Send me a recovery link</button>'
          : '<a class="ln-btn ln-btn-primary" href="/register">Create my account</a>'));
      var send = document.getElementById("recover-send");
      if (send) send.addEventListener("click", requestLink);
    }).catch(function () { recoverMessage("The lookup could not be completed. Please try again.", true); });
  });

  function requestLink() {
    if (!recoverIdent()) { recoverMessage("Enter your e-mail address or username.", true); return; }
    var btn = document.getElementById("recover-request") || document.getElementById("recover-send");
    if (btn) btn.disabled = true;
    recoverMessage("<span>Creating your one-time link\u2026</span>");
    fetch("/api/auth/recover/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: recoverIdent() })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (btn) btn.disabled = false;
      if (res.error) { recoverMessage(esc(res.error), true); return; }
      var cls = res.sent && res.delivery === "email" ? "" : " warn";
      recoverMessage("<span>" + esc(res.message) + "</span>", cls === " warn");
      if (res.sent && res.delivery !== "email") {
        var out = recoverCard();
        if (out) out.className = "ln-gate-out warn";
      }
    }).catch(function () {
      if (btn) btn.disabled = false;
      recoverMessage("The request could not be completed. Please try again.", true);
    });
  }

  var linkBtn = document.getElementById("recover-request");
  if (linkBtn) linkBtn.addEventListener("click", requestLink);

  // ---- Set a new password from a recovery link ----------------------------
  var resetForm = document.getElementById("reset-form");
  if (resetForm) resetForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var out = document.getElementById("reset-out");
    var btn = document.getElementById("reset-submit");
    var pw = (document.getElementById("reset-password") || {}).value || "";
    var confirm = (document.getElementById("reset-confirm") || {}).value || "";
    if (pw !== confirm) {
      out.hidden = false; out.className = "ln-gate-out warn";
      out.innerHTML = "<span>The two passwords do not match.</span>";
      return;
    }
    if (btn) btn.disabled = true;
    out.hidden = false; out.className = "ln-gate-out";
    out.innerHTML = "<span>Saving\u2026</span>";
    fetch("/api/auth/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: resetForm.getAttribute("data-token"), password: pw, confirm: confirm })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (btn) btn.disabled = false;
      if (res.error) { out.className = "ln-gate-out warn"; out.innerHTML = "<span>" + esc(res.error) + "</span>"; return; }
      out.className = "ln-gate-out";
      out.innerHTML = "<span>Password saved — signing you in\u2026</span>";
      location.href = res.redirect || "/studio/";
    }).catch(function () {
      if (btn) btn.disabled = false;
      out.className = "ln-gate-out warn";
      out.innerHTML = "<span>That could not be saved. Please try again.</span>";
    });
  });

  // ---- development sign-in shortcut (only rendered when DEV_LOGIN is on) --
  var devbox = document.getElementById("ln-devbox");
  var devform = document.getElementById("ln-devform");
  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (me.dev_login && devbox) devbox.hidden = false;
      // Never advertise whoever is signed in on a recovery page: the link may be
      // opened on a shared computer by someone else.
      if (me.user && me.user.status === "approved" && mode !== "recover" && mode !== "reset") {
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
