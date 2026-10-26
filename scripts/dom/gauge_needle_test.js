/* jsdom check of the Gauge Meter needle geometry.

   The needle used to be a <g transform="rotate(a 130 130)"> with a matching CSS
   transform-origin.  Browsers apply the CSS origin *on top of* the rotate() centre, so the
   needle actually swung around (260, 260) - below the dial - and hung off the widget.
   These checks pin the geometry down: direct coordinates only, tip on the band for the
   selected value, hub at the pivot, zone colour matching the verdict pill.

   Needs the server on :8000 and jsdom:
   node scripts/dom/gauge_needle_test.js */
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch (e) { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
const http = require("http"); const BASE = process.env.BASE || "http://127.0.0.1:8000";
function req(method, p, body) {
  return new Promise((res, rej) => {
    const u = new URL(BASE + p); const h = {};
    if (body) h["Content-Type"] = "application/json";
    const r = http.request(u, { method, headers: h }, x => {
      let d = ""; x.on("data", c => d += c); x.on("end", () => res({ status: x.statusCode, body: d }));
    });
    r.on("error", rej); if (body) r.write(body); r.end();
  });
}
const get = p => req("GET", p).then(r => r.body);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (l, c, d = "") => { console.log((c ? "PASS  " : "FAIL  ") + l + (c ? "" : "  -> " + d)); if (!c) fails++; };

const CX = 130, CY = 130;
const rad = (deg) => deg * Math.PI / 180;

function geom(box) {
  const poly = box.querySelector(".gauge-needle-poly");
  const pts = poly.getAttribute("points").trim().split(/\s+/).map(p => p.split(",").map(Number));
  const tip = pts[2];                                   // tail, left shoulder, tip, right shoulder
  const dx = tip[0] - CX, dy = tip[1] - CY;
  return {
    pts: pts,
    tip: tip,
    radius: Math.hypot(dx, dy),
    angle: (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360,   // 180 = left, 270 = top, 360 = right
    rotate: poly.getAttribute("transform") || box.querySelector(".gauge-svg").innerHTML.match(/rotate\([^)]*\)/),
    hub: (box.querySelector(".gauge-hub") || {}).getAttribute ? {
      cx: Number(box.querySelector(".gauge-hub").getAttribute("cx")),
      cy: Number(box.querySelector(".gauge-hub").getAttribute("cy"))
    } : null,
    tipColor: (box.querySelector(".gauge-tip") || {}).getAttribute
      ? box.querySelector(".gauge-tip").getAttribute("fill") : "",
  };
}

async function openGauge() {
  const cfg = { sections: [{ id: "S1", title: "Main" }], questions: [{
    id: "Q11", section: "S1", type: "gauge_meter", stem: "New gauge meter question", required: true,
    min: 0, max: 100, step: 1, unit: "%", target: 75,
    min_label: "Poor", mid_label: "Moderate", max_label: "Excellent" }] };
  await req("POST", "/api/studio/delete", JSON.stringify({ slug: "gauge-needle" }));
  await req("POST", "/api/studio/save", JSON.stringify({ slug: "gauge-needle", title: "Gauge needle", cfg }));
  await req("POST", "/api/studio/status", JSON.stringify({ slug: "gauge-needle", status: "live" }));
  const path = "/survey/gauge-needle/test";
  const dom = new JSDOM(await get(path), { url: BASE + path, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {}; w.requestAnimationFrame = fn => setTimeout(fn, 0);
  w.Element.prototype.scrollIntoView = function () {};
  w.fetch = (u, o) => {
    const U = new URL(u, BASE);
    return req((o && o.method) || "GET", U.pathname + U.search, o && o.body)
      .then(x => ({ ok: x.status < 400, status: x.status, json: () => Promise.resolve(JSON.parse(x.body)) }));
  };
  w.STUDY = { slug: "gauge-needle" };
  const errs = []; w.addEventListener("error", e => errs.push(e.message || String(e)));
  for (const f of ["qlogic.js", "explainer.js", "survey.js"]) w.eval(await get("/static/js/" + f));
  await sleep(800);
  w.document.querySelector("#start-btn").click();
  await sleep(800);
  return { w, errs };
}

function press(w, box, key, times = 1) {
  for (let i = 0; i < times; i++) box.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true }));
}

(async () => {
  const css = (await get("/static/css/survey.css")).replace(/\s+/g, " ");
  check("stylesheet never rotates the needle group", !/\.gauge-needle\s*\{[^}]*transform\s*:/.test(css),
    "a CSS transform on the needle group double-applies the rotation origin");
  check("no transform-origin on the needle", !/\.gauge-needle\s*\{[^}]*transform-origin/.test(css));

  const S = await openGauge();
  const box = S.w.document.querySelector(".gauge-box");
  check("gauge renders", !!box && !!box.querySelector(".gauge-svg"));
  check("dial has an un-answered state, not a fake midpoint", (box.querySelector(".gauge-val") || {}).textContent === "\u2013",
    (box.querySelector(".gauge-val") || {}).textContent);

  const g0 = geom(box);
  check("needle is drawn with direct coordinates (no rotate transform)", !g0.rotate, String(g0.rotate));
  check("hub sits on the pivot", g0.hub && g0.hub.cx === CX && g0.hub.cy === CY, JSON.stringify(g0.hub));
  check("needle starts at the minimum (left shoulder)", Math.abs(g0.angle - 180) < 1.5, g0.angle.toFixed(1));
  check("needle length stays inside the dial", g0.radius > 60 && g0.radius < 95, g0.radius.toFixed(1));

  // 28 out of 100: the tip must sit at 180 + 0.28 * 180 = 230.4 degrees, on the red band.
  press(S.w, box, "Home");
  press(S.w, box, "ArrowRight", 28);
  await sleep(500);
  const g28 = geom(box);
  check("value 28 is reported", box.getAttribute("aria-valuenow") === "28", box.getAttribute("aria-valuenow"));
  check("value 28 pill says Poor", /Poor/.test(box.querySelector(".gauge-zone-pill").textContent),
    box.querySelector(".gauge-zone-pill").textContent);
  check("needle points at 230.4deg for 28%", Math.abs(g28.angle - 230.4) < 1.5, g28.angle.toFixed(1));
  check("needle tip rides on the red band", g28.tipColor === "#ef4444", g28.tipColor);
  check("needle tip touches the coloured band", g28.radius >= 84 && g28.radius <= 88, g28.radius.toFixed(1));

  // Mid and top of the scale, so both shoulders are proven, not just the left one.
  press(S.w, box, "Home");
  press(S.w, box, "ArrowRight", 50);
  await sleep(400);
  const g50 = geom(box);
  check("needle points straight up at 50%", Math.abs(g50.angle - 270) < 1.5, g50.angle.toFixed(1));
  check("50% lands in the amber band", g50.tipColor === "#f59e0b", g50.tipColor);
  check("50% reads Moderate", /Moderate/.test(box.querySelector(".gauge-zone-pill").textContent),
    box.querySelector(".gauge-zone-pill").textContent);

  press(S.w, box, "End");
  await sleep(400);
  const g100 = geom(box);
  // 360 and 0 are the same shoulder angle: accept either side of the wrap.
  check("needle points at the right shoulder at 100%",
    Math.min(Math.abs(g100.angle - 360), g100.angle) < 1.5, g100.angle.toFixed(1));
  check("100% lands in the green band", g100.tipColor === "#10b981", g100.tipColor);
  check("100% reads Excellent", /Excellent/.test(box.querySelector(".gauge-zone-pill").textContent),
    box.querySelector(".gauge-zone-pill").textContent);

  press(S.w, box, "Home");
  await sleep(300);
  const gLeft = geom(box);
  check("Home returns the needle to 0%", box.getAttribute("aria-valuenow") === "0" &&
    Math.abs(gLeft.angle - 180) < 1.5, gLeft.angle.toFixed(1));

  // The three zone bands must be contiguous and match the pill thresholds (40 / 70).
  const bands = [...S.w.document.querySelectorAll(".gauge-zone")].map(n => n.getAttribute("stroke"));
  check("three coloured bands in red / amber / green order",
    bands.join(",") === "#ef4444,#f59e0b,#10b981", bands.join(","));
  const track = (S.w.document.querySelector(".gauge-track") || {}).getAttribute
    ? S.w.document.querySelector(".gauge-track").getAttribute("d") : "";
  check("track spans the whole semicircle", /^M 35 130 A 95 95 0 0 1 225/.test(track), track);
  const target = (S.w.document.querySelector(".gauge-target") || {}).getAttribute
    ? S.w.document.querySelector(".gauge-target").getAttribute("x1") : "";
  check("target threshold marker is drawn", !!target, "missing .gauge-target");
  check("no page errors", S.errs.length === 0, S.errs.join(" | "));

  await req("POST", "/api/studio/delete", JSON.stringify({ slug: "gauge-needle" }));
  console.log(fails ? fails + " FAILED" : "PASS Gauge Meter needle geometry, zone colours, keyboard scale and target marker.");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
