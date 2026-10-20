/* jsdom check of the cinematic walkthrough player: the narration is the clock, so one
   requestAnimationFrame loop drives the karaoke caption, the video-style timeline, the
   chapter markers and the audio meter from a single elapsed-time source.  Speech
   boundaries correct the estimate where the platform reports them; the estimate runs
   everywhere else so the caption never freezes.
   Loads explainer.js directly - no server, no studio UI.
   node scripts/dom/explainer_cinematic_test.js */
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch (e) { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "static", "js", "explainer.js"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (l, c, d = "") => { console.log((c ? "PASS  " : "FAIL  ") + l + (c ? "" : "  -> " + d)); if (!c) fails++; };

// ---------------------------------------------------------------- the environment
// A jsdom window with just enough media plumbing to exercise the three clock sources:
// browser speech (stubbed so we can fire a real word boundary), an uploaded clip (stubbed
// so play() can be made to reject), and nothing at all (the silent timer path).
function makeWindow(opts) {
  opts = opts || {};
  const dom = new JSDOM("<!doctype html><html><body><div id=\"ex-mount\"></div></body></html>",
    { url: "http://local.test/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;

  // deterministic frames: 16ms ticks instead of the display's
  w.requestAnimationFrame = f => setTimeout(f, 16);

  // --- a controllable <audio> ---
  const audioState = { playRejects: !!opts.playRejects, src: null, currentTime: 0, duration: 0 };
  function FakeAudio() {
    const a = {
      preload: "", muted: false, src: "", currentTime: 0, duration: 0, paused: true,
      _ls: {},
      addEventListener(t, f) { (a._ls[t] = a._ls[t] || []).push(f); },
      removeEventListener(t, f) { a._ls[t] = (a._ls[t] || []).filter(x => x !== f); },
      play() {
        a.paused = false;
        return audioState.playRejects ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve();
      },
      pause() { a.paused = true; },
      load() {}
    };
    Object.defineProperty(a, "src", { get: () => audioState.src, set: v => { audioState.src = v; } });
    return a;
  }
  w.Audio = FakeAudio;

  // --- speech, stubbed so a boundary can be fired by hand ---
  const spoken = [];
  w.SpeechSynthesisUtterance = function (text) { this.text = text; this.lang = ""; spoken.push(this); };
  w.speechSynthesis = {
    speak(u) { spoken.push(u); w.__lastSpoken = u; },
    cancel() {}, pause() {}, resume() {}, getVoices: () => []
  };
  w.audioState = audioState; w.spoken = spoken;
  return w;
}

const SCENES = [
  { id: "s1", art: "trial", title: "Why this trial ran",
    caption: "Investigators needed a comparison they could trust across sites." },
  { id: "s2", art: "efficacy", title: "What the results showed",
    caption: "Response improved steadily and held through the follow up visits." },
  { id: "s3", art: "safety", title: "How tolerability held",
    caption: "Adverse events stayed low and were mostly mild in nature." }
];

const NARR = { n1: { src: "/audio/n1.mp3", seconds: 30 } };

(async () => {
  // -------------------------------------------------- structure and the timeline
  {
    const w = makeWindow(); w.eval(SRC);
    const ex = new w.BeaconExplainer(w.document.getElementById("ex-mount"), {
      scenes: SCENES, narration: {}, onDone: () => { w.__done = true; }, muted: true, tts: false });
    ex.start();

    const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];

    check("the player mounts inside #ex-mount (the fallback contract)",
      !!w.document.getElementById("ex-mount").firstChild);
    check("every id the other players use is still there",
      ["ex-shell", "ex-artA", "ex-artB", "ex-title", "ex-sub", "ex-fill", "ex-dots",
       "ex-scene", "ex-prev", "ex-play", "ex-next", "ex-mute", "ex-skip"]
        .every(id => !!$("#" + id)));

    const dots = $$("#ex-dots .ex-dot");
    check("one chapter marker per step", dots.length === 3, "got " + dots.length);
    check("chapter markers carry their step index", dots[1].getAttribute("data-i") === "1");
    check("chapter markers carry their step title", /results/.test(dots[1].getAttribute("data-title")),
      dots[1].getAttribute("data-title"));

    // the total is the sum of the per-step estimates, drawn up front
    const total = ex.total;
    const perStep = SCENES.map((sc, i) => ex.constructor && sc).length && total;
    check("the timeline total is a positive sum of step lengths", total > 8, "total=" + total);
    check("the readout shows 0:00 / <total>",
      $("#ex-now").textContent === "0:00" && /^\d+:\d\d$/.test($("#ex-total").textContent),
      $("#ex-now").textContent + " / " + $("#ex-total").textContent);
    check("the first chapter sits at the start of the track",
      parseFloat(dots[0].style.left) === 0, dots[0].style.left);
    check("later chapters sit at their cumulative offset",
      parseFloat(dots[1].style.left) > parseFloat(dots[0].style.left) &&
      parseFloat(dots[2].style.left) > parseFloat(dots[1].style.left),
      [dots[0].style.left, dots[1].style.left, dots[2].style.left].join(" "));

    check("the counter reads step 1 of 3", $("#ex-scene").textContent === "1 / 3", $("#ex-scene").textContent);
    check("the title shows the step's label", /Why this trial ran/.test($("#ex-title").textContent));

    // -------------------------------------------------- the karaoke caption
    const words = $$("#ex-sub .w");
    check("the caption is split into one span per word", words.length >= 9, "got " + words.length);
    check("a span is emitted for the title words too, not just the caption",
      words[0].textContent.toLowerCase().startsWith("why"), words[0] && words[0].textContent);
    check("muted suppresses the karaoke: no word is marked done or current",
      !$("#ex-sub .w.done") && !$("#ex-sub .w.cur"));
    check("muted dims the meter", $("#ex-sound").classList.contains("off"));

    // -------------------------------------------------- click a chapter to jump
    dots[2].dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(60);
    check("clicking a chapter jumps to that step",
      ex.i === 2 && /tolerability/.test($("#ex-title").textContent), "i=" + ex.i);
    check("the jumped-to chapter is marked current",
      $$("#ex-dots .ex-dot")[2].classList.contains("cur"));
    check("the counter followed the jump", $("#ex-scene").textContent === "3 / 3", $("#ex-scene").textContent);

    // -------------------------------------------------- prev / replay
    $("#ex-prev").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(60);
    check("prev steps back one", ex.i === 1, "i=" + ex.i);
    $("#ex-replay").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(60);
    check("replay returns to the first step", ex.i === 0, "i=" + ex.i);

    // -------------------------------------------------- next / finish
    $("#ex-skip").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(60);
    check("Skip finishes and calls onDone", w.__done === true);
  }

  // -------------------------------------------------- the caption follows the estimate
  {
    const w = makeWindow(); w.eval(SRC);
    const ex = new w.BeaconExplainer(w.document.getElementById("ex-mount"), {
      scenes: [{ id: "s1", art: "trial", title: "One two three four",
        caption: "five six seven eight nine ten eleven twelve" }],
      narration: {}, onDone: () => {}, muted: false, tts: false });
    ex.start();
    const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
    check("at the very start the first word is the current one",
      $$("#ex-sub .w.cur").length === 1 && $$("#ex-sub .w.done").length === 0,
      $$("#ex-sub .w").map(x => x.className).join(","));

    await sleep(700);                      // ~1s into a 6s step
    const done = $$("#ex-sub .w.done").length;
    check("the silent clock still animates the caption", done >= 1, "done=" + done);
    check("exactly one word is current", $$("#ex-sub .w.cur").length === 1, String($$("#ex-sub .w.cur").length));
    check("the progress bar has moved off zero", parseFloat($("#ex-fill").style.width) > 0,
      $("#ex-fill").style.width);
    check("the time readout has advanced", $("#ex-now").textContent !== "0:00", $("#ex-now").textContent);
    const fillNow = parseFloat($("#ex-fill").style.width);
    await sleep(700);
    check("the bar keeps advancing on later frames",
      parseFloat($("#ex-fill").style.width) > fillNow, $("#ex-fill").style.width + " <= " + fillNow);
    check("the meter breathes: bars get a scale transform",
      /scaleY\(/.test($("#ex-sound i").style.transform), $("#ex-sound i").style.transform);
    ex.finish();
  }

  // -------------------------------------------------- a real word boundary corrects it
  {
    const w = makeWindow(); w.eval(SRC);
    const ex = new w.BeaconExplainer(w.document.getElementById("ex-mount"), {
      scenes: [{ id: "s1", art: "trial", title: "Alpha beta gamma",
        caption: "delta epsilon zeta eta theta iota kappa" },
        { id: "s2", art: "safety", title: "Omega", caption: "and that is the end of it" }],
      narration: {}, onDone: () => { closed = true; }, muted: false, tts: true });
    let closed = false;
    ex.start();
    const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
    await sleep(80);
    check("browser speech is asked to read the step when tts is on", w.spoken.length >= 1,
      "spoken=" + w.spoken.length);
    check("the utterance carries the step's text",
      /Alpha beta gamma/.test(w.__lastSpoken.text), w.__lastSpoken && w.__lastSpoken.text);

    // the platform says word 4 has started: the caption must follow it exactly
    const u = w.__lastSpoken, text = u.text;
    const at = text.indexOf("epsilon");
    u.onboundary({ charIndex: at, name: "word" });
    const words = $$("#ex-sub .w");
    check("a boundary event lights the reported word",
      words[4] && words[4].classList.contains("cur"), words[4] && words[4].className);
    check("words before the boundary are marked done", words[3] && words[3].classList.contains("done"),
      words[3] && words[3].className);
    check("words after the boundary are untouched", !words[5] || (!words[5].classList.contains("done") &&
      !words[5].classList.contains("cur")), words[5] && words[5].className);

    // once a boundary has been seen, the estimate must stop overwriting it
    await sleep(200);
    check("the boundary is not overwritten by the estimate on the next frame",
      words[4].classList.contains("cur") && words[3].classList.contains("done"),
      words[3].className + " | " + words[4].className);

    // the voice ending is what moves the step on - and a last step finishing closes it
    u.onend({});
    await sleep(60);
    check("the end of a spoken step advances the walkthrough", ex.i === 1, "i=" + ex.i);
    check("a later step gets its own utterance", w.spoken.length >= 3, "spoken=" + w.spoken.length);
    w.spoken[w.spoken.length - 1].onend({});
    await sleep(60);
    check("the end of the last spoken step closes the walkthrough", closed === true, "closed=" + closed);
  }

  // -------------------------------------------------- autoplay blocked asks, does not guess
  {
    const w = makeWindow({ playRejects: true }); w.eval(SRC);
    const ex = new w.BeaconExplainer(w.document.getElementById("ex-mount"), {
      scenes: [{ id: "s1", art: "trial", clip: "n1", title: "Blocked", caption: "The browser refused to play." }],
      narration: NARR, onDone: () => {}, muted: false, tts: false });
    ex.start();
    const $ = s => w.document.querySelector(s);
    check("the clip is attached to the step", ex.audio && /n1\.mp3/.test(String(ex.audio.src)),
      String(ex.audio && ex.audio.src));
    await sleep(120);                       // let the rejected play() promise settle
    check("a blocked autoplay shows the play-the-narration button", $("#ex-bigplay").hidden === false,
      "hidden=" + $("#ex-bigplay").hidden);
    check("the button names what it does", /Play the narration/.test($("#ex-bigplay").textContent),
      $("#ex-bigplay").textContent);
    $("#ex-bigplay").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(60);
    check("clicking it pauses rather than hiding the problem", ex.paused === true, "paused=" + ex.paused);
    ex.finish();
  }

  // -------------------------------------------------- mute kills the karaoke, not the walkthrough
  {
    const w = makeWindow(); w.eval(SRC);
    const ex = new w.BeaconExplainer(w.document.getElementById("ex-mount"), {
      scenes: SCENES, narration: {}, onDone: () => {}, muted: false, tts: false });
    ex.start();
    const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
    await sleep(500);
    check("unmuted, the caption animates", $$("#ex-sub .w.done").length >= 1);

    $("#ex-mute").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(80);
    check("mute is reflected on the shell", $("#ex-shell").classList.contains("muted"));
    check("muting also mutes the element", ex.audio.muted === true);
    check("muting stops the karaoke: no word left lit",
      !$("#ex-sub .w.done") && !$("#ex-sub .w.cur"),
      $$("#ex-sub .w").map(x => x.className).join(","));
    check("muting hides the meter", $("#ex-sound").classList.contains("off"));
    check("the words are all still there after muting", $$("#ex-sub .w").length >= 9);
    await sleep(300);
    check("the walkthrough keeps running while muted", ex.i === 0 || ex.i === 1, "i=" + ex.i);
    ex.finish();
  }

  // -------------------------------------------------- an attachment wins over the artwork
  {
    const w = makeWindow(); w.eval(SRC);
    const scenes = [
      { id: "a", art: "trial", title: "A slide", caption: "An uploaded image.",
        media: { kind: "image", src: "/media/deck1.png" } },
      { id: "b", art: "efficacy", title: "A clip", caption: "An uploaded video.",
        media: { kind: "video", src: "/media/deck1.mp4" } }
    ];
    const ex = new w.BeaconExplainer(w.document.getElementById("ex-mount"), {
      scenes: scenes, narration: {}, onDone: () => {}, muted: true, tts: false });
    ex.start();
    const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
    const onLayer = () => $$("#ex-shell .ex-art.on")[0];
    const img = onLayer().querySelector("img.scene-media");
    check("an image attachment takes the place of the drawn scene", !!img, onLayer().innerHTML.slice(0, 60));
    check("the image points at the author's upload",
      img && img.getAttribute("src") === "/media/deck1.png", img && img.getAttribute("src"));
    check("no drawn scene is left underneath it", !onLayer().querySelector("svg"));
    ex.loadScene(1); await sleep(60);
    const vid = onLayer().querySelector("video.scene-media");
    check("a video attachment becomes a scene-media element", !!vid, onLayer().innerHTML.slice(0, 60));
    check("the video is muted and looping so it can autoplay",
      vid && vid.hasAttribute("muted") && vid.hasAttribute("loop") && vid.hasAttribute("playsinline"),
      vid && vid.outerHTML.slice(0, 110));
    ex.finish();
  }

  // -------------------------------------------------- graceful degradation
  {
    const w = makeWindow();
    delete w.SpeechSynthesisUtterance; delete w.speechSynthesis;
    delete w.AudioContext; delete w.webkitAudioContext;
    let threw = null;
    try {
      w.eval(SRC);
      const ex = new w.BeaconExplainer(w.document.getElementById("ex-mount"), {
        scenes: SCENES, narration: {}, onDone: () => {}, muted: false, tts: true });
      ex.start();
      const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
      check("no speech engine is a non-event, not a crash", threw === null && ex.i === 0, "i=" + ex.i);
      await sleep(600);
      check("the estimate still animates the caption with no speech engine",
        $$("#ex-sub .w.done").length >= 1, "done=" + $$("#ex-sub .w.done").length);
      check("the timeline still runs with no speech engine",
        $("#ex-now").textContent !== "0:00", $("#ex-now").textContent);
      ex.toggle(); await sleep(40);
      check("pause works with no speech engine", ex.paused === true);
      const held = ex.elapsed();
      await sleep(500);
      check("a paused walkthrough holds its position", Math.abs(ex.elapsed() - held) < 0.02,
        held.toFixed(3) + " -> " + ex.elapsed().toFixed(3));
      const before = $("#ex-now").textContent;
      ex.toggle(); await sleep(1400);
      check("resuming continues it", ex.elapsed() > held + 1,
        held.toFixed(2) + " -> " + ex.elapsed().toFixed(2));
      check("the readout catches up with the resumed clock", $("#ex-now").textContent !== before,
        before + " -> " + $("#ex-now").textContent);
      ex.finish();
    } catch (e) { threw = e; }
    check("nothing threw in the degraded environment", threw === null, threw && threw.message);
  }

  // -------------------------------------------------- an uploaded clip drives the clock
  {
    const w = makeWindow(); w.eval(SRC);
    const ex = new w.BeaconExplainer(w.document.getElementById("ex-mount"), {
      scenes: [{ id: "s1", art: "trial", clip: "n1", title: "One two three four", caption: "five six seven eight" }],
      narration: NARR, onDone: () => {}, muted: false, tts: false });
    ex.start();
    const $ = s => w.document.querySelector(s);
    check("a produced clip is used in preference to browser speech", w.spoken.length === 0,
      "spoken=" + w.spoken.length);
    check("the clip's real length sets the step", ex.sceneDur === 30, "dur=" + ex.sceneDur);
    check("the total reflects the clip", $("#ex-total").textContent === "0:30", $("#ex-total").textContent);
    // 12s into the clip: 40% of the way through a 30s step
    ex.audio.currentTime = 12; ex.audio.duration = 30;
    ex.audio._ls.timeupdate.forEach(f => f());
    await sleep(80);
    check("the clip's own position drives the timeline readout", $("#ex-now").textContent === "0:12",
      $("#ex-now").textContent);
    check("the bar is at 40% of the track", Math.abs(parseFloat($("#ex-fill").style.width) - 40) < 1,
      $("#ex-fill").style.width);
    ex.finish();
  }

  console.log(fails ? "\n" + fails + " FAILED" : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
