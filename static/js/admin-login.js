/* Separate Admin Login (/admin-login) — posts to the admin-only endpoint and
   lands in the Admin Console, where pending approval requests wait. */
(function () {
  var nextUrl = document.body.getAttribute("data-next") || "";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function showMsg(msg) {
    var box = document.getElementById("gate-msg");
    if (!box) { alert(msg); return; }
    box.hidden = false;
    box.className = "ln-gate-out warn";
    box.innerHTML = "<span>" + esc(msg) + "</span>";
  }

  var form = document.getElementById("sk-admin-login-form");
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = document.getElementById("admin-submit");
    if (btn) btn.disabled = true;
    fetch("/api/auth/admin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: (document.getElementById("admin-ident") || {}).value || "",
        password: (document.getElementById("admin-password") || {}).value || "",
        next: nextUrl
      })
    }).then(function (r) { return r.json(); }).then(function (out) {
      if (btn) btn.disabled = false;
      if (out.error) { showMsg(out.error); return; }
      location.href = out.redirect || "/admin/console";
    }).catch(function () {
      if (btn) btn.disabled = false;
      showMsg("Admin sign-in could not be completed. Please try again.");
    });
  });
})();
