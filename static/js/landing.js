/* Landing page: the hero AI conversation, scroll reveals, sign-in chrome.
   Marketing motion lives in landing.css; this orchestrates the typewriter loop
   (restarts on each cycle) and reports account state from /api/me.
   prefers-reduced-motion: the conversation shows complete and static. */
(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- hero: "say what you need, watch it act" ---------------------------
  var NEED = "We need to understand why oncologists switch first-line therapy.";
  var typeEl = document.getElementById("ai-type");
  var replyEl = document.getElementById("ai-reply");
  var actionsEl = document.getElementById("ai-actions");
  var fastEl = document.getElementById("ai-fast");
  var youMsg = typeEl && typeEl.closest(".ai-msg");

  function retrigger(root) {
    Array.prototype.forEach.call(root.querySelectorAll("*"), function (n) {
      var a = n.style.animation;
      n.style.animation = "none";
      void n.offsetWidth;
      n.style.animation = a || "";
    });
    var a = root.style.animation;
    root.style.animation = "none";
    void root.offsetWidth;
    root.style.animation = a || "";
  }
  function type(text, i, done) {
    if (!typeEl) return;
    typeEl.textContent = text.slice(0, i);
    if (i < text.length) setTimeout(function () { type(text, i + 1, done); }, 34);
    else if (done) done();
  }

  function showConversation(statically) {
    if (!typeEl) return;
    if (statically) {
      typeEl.textContent = NEED;
      youMsg.classList.add("done");
      [replyEl, actionsEl, fastEl].forEach(function (el) { if (el) el.hidden = false; });
      return;
    }
    typeEl.textContent = "";
    youMsg.classList.remove("done");
    [replyEl, actionsEl, fastEl].forEach(function (el) { if (el) el.hidden = true; });
    retrigger(youMsg);
    type(NEED, 0, function () {
      youMsg.classList.add("done");
      setTimeout(function () {
        if (replyEl) { replyEl.hidden = false; retrigger(replyEl); }
        setTimeout(function () {
          if (actionsEl) { actionsEl.hidden = false; retrigger(actionsEl); }
          setTimeout(function () {
            if (fastEl) { fastEl.hidden = false; retrigger(fastEl); }
            setTimeout(function () { showConversation(false); }, 5200);
          }, 1400);
        }, 900);
      }, 350);
    });
  }
  if (typeEl) showConversation(reduce);

  // ---- reveal on scroll --------------------------------------------------
  if (!reduce && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.18 });
    document.querySelectorAll(".ln-reveal").forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll(".ln-reveal").forEach(function (el) { el.classList.add("in"); });
  }

  // ---- demo animations replay when a card scrolls back into view ---------
  if (!reduce && "IntersectionObserver" in window) {
    document.querySelectorAll(".ln-demo").forEach(function (card) {
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

  // ---- who is signed in --------------------------------------------------
  function renderAuth(me) {
    var chip = document.getElementById("ln-auth");
    if (me.dev_login) {
      var devbox = document.getElementById("ln-devbox");
      if (devbox) devbox.hidden = false;
    }
    if (!chip || !me.user) return;
    if (me.user.status === "approved") {
      chip.innerHTML = '<span class="ln-joined">' +
        (me.user.picture ? '<img class="ln-avatar" src="' + esc(me.user.picture) + '" alt="">' : "") +
        '<span class="ln-uname">' + esc(me.user.name || me.user.email) + "</span>" +
        '<a class="ln-btn ln-btn-primary sm" href="/workspace/">Open workspace</a>' +
        '<button class="ln-btn ln-btn-ghost sm" id="ln-signout" type="button">Sign out</button></span>';
    } else {
      chip.innerHTML = '<span class="ln-uname">' + esc(me.user.email) + "</span>" +
        '<button class="ln-btn ln-btn-ghost sm" id="ln-signout" type="button">Sign out</button>';
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

  // ---- dev sign-in (register semantics; only when the server enables it) --
  var adminBtn = document.getElementById("ln-dev-admin");
  if (adminBtn) adminBtn.addEventListener("click", function () {
    var email = document.getElementById("ln-dev-email"), name = document.getElementById("ln-dev-name");
    if (email) email.value = "admin@anaking.test";
    if (name) name.value = "Admin";
    var f = document.getElementById("ln-devform");
    if (f && f.requestSubmit) f.requestSubmit();
  });

  var form = document.getElementById("ln-devform");
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    fetch("/auth/dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: (document.getElementById("ln-dev-email") || {}).value || "",
        name: (document.getElementById("ln-dev-name") || {}).value || "",
        mode: "register"
      })
    }).then(function (r) { return r.json(); }).then(function (out) {
      if (out.error) alert(out.error);
      else location.href = "/workspace/";
    });
  });
})();
