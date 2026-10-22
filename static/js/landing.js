/* Landing page: sign-in state chrome + demo-animation replay.
   Marketing animations live in landing.css; this only restarts them when a card
   scrolls back into view so visitors see them move every time (reduced-motion is
   honoured in CSS). */
(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- who is signed in ----------------------------------------------------
  function renderAuth(me) {
    var chip = document.getElementById("ln-auth");
    var cta = document.getElementById("ln-cta");
    var join = document.getElementById("ln-join-cta");
    var note = document.getElementById("ln-hero-note");
    var devbox = document.getElementById("ln-devbox");
    if (devbox && me.dev_login) devbox.hidden = false;

    if (me.user && me.user.status === "approved") {
      var html = '<span class="ln-joined">' +
        (me.user.picture ? '<img class="ln-avatar" src="' + esc(me.user.picture) + '" alt="">' : "") +
        '<span class="ln-uname">' + esc(me.user.name || me.user.email) + "</span>" +
        '<a class="ln-btn ln-btn-primary" href="/workspace/">Open workspace</a>' +
        '<button class="ln-btn ln-btn-ghost" id="ln-signout" type="button">Sign out</button></span>';
      if (chip) chip.innerHTML = html;
      if (cta) cta.innerHTML = '<a class="ln-btn ln-btn-primary lg" href="/workspace/">Open your workspace</a>' +
        '<a class="ln-btn ln-btn-ghost lg" href="#demos">See it move</a>';
      if (join) join.innerHTML = '<a class="ln-btn ln-btn-primary lg" href="/workspace/">Open your workspace</a>';
      if (note) note.textContent = "Signed in as " + (me.user.email || "") + " — your projects are private to your account.";
    } else if (me.user) {
      if (chip) chip.innerHTML = '<span class="ln-uname">' + esc(me.user.email) + "</span>" +
        '<button class="ln-btn ln-btn-ghost" id="ln-signout" type="button">Sign out</button>';
      if (note) {
        note.className = "ln-hero-note pending";
        note.textContent = me.user.status === "pending"
          ? "You're signed in — the platform admin is reviewing your profile. You'll get access as soon as it's approved."
          : "This profile is not approved to use the platform (" + me.user.status + "). Ask the admin for access.";
      }
      if (cta) cta.innerHTML = '<span class="ln-btn ln-btn-ghost lg" aria-disabled="true">Waiting for admin approval</span>';
      if (join) join.innerHTML = '<span class="ln-btn ln-btn-ghost lg" aria-disabled="true">Waiting for admin approval</span>';
    }

    var out = document.getElementById("ln-signout");
    if (out) out.addEventListener("click", function () {
      fetch("/auth/logout", {
        method: "POST",
        headers: { "X-Requested-With": "fetch" }
      }).then(function () { location.reload(); });
    });
  }

  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(renderAuth)
    .catch(function () { /* page works signed out */ });

  // ---- dev sign-in (only rendered when the server enables DEV_LOGIN) --------
  var form = document.getElementById("ln-devform");
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    fetch("/auth/dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: (document.getElementById("ln-dev-email") || {}).value || "",
        name: (document.getElementById("ln-dev-name") || {}).value || ""
      })
    }).then(function (r) { return r.json(); }).then(function (out) {
      if (out.error) alert(out.error);
      else location.href = "/workspace/";
    });
  });

  // ---- replay demo animations each time a card scrolls back into view -------
  if (!window.matchMedia || !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var stage = en.target.querySelector(".ln-demo-stage");
        if (!stage || stage.dataset.played) return;
        stage.dataset.played = "1";
        // first entry: CSS already animates on load.  Later re-entries below.
      });
    }, { threshold: 0.45 });
    var retrigger = function (stage) {
      Array.prototype.forEach.call(stage.querySelectorAll("*"), function (n) {
        var a = n.style.animation;
        n.style.animation = "none";
        void n.offsetWidth;
        n.style.animation = a || "";
      });
    };
    document.querySelectorAll(".ln-demo").forEach(function (card) {
      io.observe(card);
      var visible = false;
      new IntersectionObserver(function (es) {
        es.forEach(function (en) {
          if (!en.isIntersecting) { visible = false; return; }
          if (visible) return;
          if (card.dataset.seen) retrigger(card.querySelector(".ln-demo-stage"));
          card.dataset.seen = "1";
          visible = true;
        });
      }, { threshold: 0.45 }).observe(card);
    });
  }
})();
