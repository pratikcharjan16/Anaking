/* jsdom check for the landing-page footer (templates/_footer_landing.html, .lnf-* rules in
   landing.css).  The landing page closes on its own dark directory footer, separate from the
   cream _footer.html that the team surfaces use.  Pinned here:

   1. Five link columns with SurveyKart's own headings and original copy - no borrowed text.
   2. Every destination is a page or landing anchor that actually exists (no invented
      /terms, /privacy or /compare routes), and every link keeps a descriptive title.
   3. The bottom rail keeps the two app entrances, the quick destinations, the contact chip,
      the copyright year and the search-alias line.
   4. The footer buttons drive the shared "Request a demo" dialog the rest of the page uses.

   Needs the server on :8000 and jsdom:  node scripts/dom/landing_footer_test.js */
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch (e) { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
const http = require("http");
const BASE = process.env.BASE || "http://127.0.0.1:8000";
const get = p => new Promise((res, rej) => {
  const r = http.get(BASE + p, x => { let d = ""; x.setEncoding("utf8"); x.on("data", c => d += c); x.on("end", () => res(d)); });
  r.on("error", rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (l, c, d = "") => { console.log((c ? "PASS  " : "FAIL  ") + l + (c ? "" : "  -> " + d)); if (!c) fails++; };
(async () => {
  const dom = new JSDOM(await get("/"), { url: BASE + "/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window, doc = w.document;
  w.scrollTo = () => {}; w.requestAnimationFrame = fn => setTimeout(fn, 0);
  w.Element.prototype.scrollIntoView = function () {};
  w.matchMedia = w.matchMedia || (q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(el) { this.cb([{ target: el, isIntersecting: true }], this); } unobserve() {} disconnect() {} };
  const req2 = (method, path, body) => new Promise((res, rej) => {
    const u = new URL(BASE + path); const h = {};
    if (body) h["Content-Type"] = "application/json";
    const r = http.request(u, { method, headers: h }, x => { let d = ""; x.setEncoding("utf8"); x.on("data", c => d += c); x.on("end", () => res({ status: x.statusCode, body: d })); });
    r.on("error", rej); if (body) r.write(body); r.end();
  });
  w.fetch = (u, o) => { const U = new URL(u, BASE);
    return req2((o && o.method) || "GET", U.pathname + U.search, o && o.body)
      .then(x => ({ ok: x.status < 400, status: x.status, headers: { get: () => "" }, json: () => Promise.resolve(JSON.parse(x.body)), text: () => Promise.resolve(x.body) })); };
  const errs = [];
  w.addEventListener("error", e => errs.push(String(e.message)));
  for (const f of ["js/security.js", "js/landing.js"]) { try { w.eval(await get("/static/" + f)); } catch (e) { console.log("ERR eval " + f, (e.stack || e.message).split("\n").slice(0,4).join(" / ")); } }
  await sleep(500);

  const foot = doc.querySelector("footer.lnf");
  check("landing has the dark footer", !!foot);
  check("shared executive footer is not also printed", !doc.querySelector("footer.an-foot"));
  const cols = foot.querySelectorAll(".lnf-col");
  check("five link columns", cols.length === 5, String(cols.length));
  const heads = [...foot.querySelectorAll(".lnf-h")].map(h => h.textContent.trim());
  check("column headings", JSON.stringify(heads) === JSON.stringify(["The platform", "What teams run", "See it in action", "Account & contact", "Why SurveyKart"]), JSON.stringify(heads));
  const links = foot.querySelectorAll("a[href]");
  const bad = [...links].filter(a => !a.getAttribute("href") || /^(#|javascript:)/.test(a.getAttribute("href")));
  check("every link has a real target", bad.length === 0, bad.map(b => b.outerHTML).join(" | ").slice(0, 300));
  check("links carry title text", [...links].every(a => (a.getAttribute("title") || "").length > 8), String([...links].filter(a => !(a.getAttribute("title") || "").length > 8).length));
  check("two store-style badges", foot.querySelectorAll(".lnf-badge").length === 2);
  check("four social destinations", foot.querySelectorAll(".lnf-soc").length === 4);
  check("contact chip present", !!foot.querySelector(".lnf-contact"));
  const year = doc.getElementById("lnf-year");
  check("year is the current one", !!year && year.textContent.trim() === String(new Date().getFullYear()), year && year.textContent);
  check("copyright sits beside the year", /SurveyKart/.test(foot.querySelector(".lnf-copy").textContent));
  check("alias index kept for search", /SurveyCart/.test(foot.querySelector(".lnf-alias").textContent));
  check("no copied marketing text", !/Get the app|Download on the|Available on the|Terms of Service|Privacy Policy|Cookie/i.test(foot.textContent));

  // every in-page anchor resolves to a real section
  const landAnchors = [...foot.querySelectorAll('a[href^="/#"]')].map(a => a.getAttribute("href").slice(2));
  const missing = landAnchors.filter(id => !doc.getElementById(id));
  check("in-page anchors resolve", missing.length === 0, missing.join(","));

  // footer buttons drive the demo dialog
  const modal = doc.getElementById("ln-demo-modal");
  check("dialog starts hidden", modal && modal.hidden === true);
  const contact = foot.querySelector(".lnf-contact");
  contact.click(); await sleep(80);
  check("contact chip opens the demo dialog", modal.hidden === false);
  doc.querySelector("#ln-demo-modal [data-demo-close]").click(); await sleep(80);
  check("close button hides it again", modal.hidden === true);
  const rowBtn = [...foot.querySelectorAll(".lnf-link")].find(b => /live demo/i.test(b.textContent));
  rowBtn.click(); await sleep(80);
  check("footer text button opens the dialog", modal.hidden === false);
  check("no page errors", errs.length === 0, errs.join(" | "));
  console.log(fails ? fails + " FAILED" : "PASS Landing footer");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
