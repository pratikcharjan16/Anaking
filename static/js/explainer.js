/*
 * PROJECT BEACON - animated product-profile explainer (v2).
 *
 * A scene-based visual walkthrough synced to the narration in /audio/. Each scene is inline
 * SVG with layered CSS animation - gradients, drawn curves, particles - so there are no video
 * files, no codecs and no external requests. Scenes advance on the narration clock rather
 * than on a timer, so the picture and the voice cannot drift apart if the audio stalls.
 *
 * v2: crossfading art layers, ambient per-scene backdrops, scene dots + prev/next, richer
 * clinical artwork (ECG trace, Kaplan-Meier curves, liquid vial, DNA helix, donut sweep).
 */
(function (global) {
  "use strict";

  // ---------------------------------------------------------------- scene artwork
  var ART = {
    patient:
      '<svg viewBox="0 0 400 240" class="scene-svg">' +
      '<defs><radialGradient id="gp-halo" cx="50%" cy="42%" r="60%">' +
      '<stop offset="0%" stop-color="#7fd4f0" stop-opacity=".35"/>' +
      '<stop offset="100%" stop-color="#7fd4f0" stop-opacity="0"/></radialGradient>' +
      '<linearGradient id="gp-body" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#b9d8e8"/><stop offset="100%" stop-color="#8fb8cd"/>' +
      '</linearGradient></defs>' +
      '<rect x="0" y="0" width="400" height="240" fill="url(#gp-halo)"/>' +
      '<g class="a-fade"><circle cx="140" cy="86" r="30" fill="url(#gp-body)"/>' +
      '<path d="M88 182c0-30 23-54 52-54s52 24 52 54v10H88z" fill="url(#gp-body)"/>' +
      '<circle cx="140" cy="86" r="30" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.5"/>' +
      '</g>' +
      '<g class="a-pulse"><circle cx="140" cy="110" r="58" fill="none" stroke="#12789e" stroke-width="2" opacity=".4"/></g>' +
      '<g class="a-pulse" style="animation-delay:.8s"><circle cx="140" cy="110" r="74" fill="none" stroke="#12789e" stroke-width="1.4" opacity=".25"/></g>' +
      '<path class="a-ecg" d="M20 210h60l8-14 10 26 10-38 10 30 8-4h56l8-12 10 22 10-32 10 26 8-2h150" ' +
      'fill="none" stroke="#2ea882" stroke-width="2.4" stroke-linejoin="round"/>' +
      '<g class="a-rise" style="animation-delay:.5s"><rect x="236" y="48" width="140" height="32" rx="16" fill="#0b4f6c"/>' +
      '<circle cx="254" cy="64" r="5" fill="#7fd4f0"/><text x="316" y="69" text-anchor="middle" fill="#fff" font-size="12.5" font-weight="600">Advanced NSCLC</text></g>' +
      '<g class="a-rise" style="animation-delay:1.1s"><rect x="236" y="90" width="140" height="32" rx="16" fill="#12789e"/>' +
      '<circle cx="254" cy="106" r="5" fill="#ffd166"/><text x="316" y="111" text-anchor="middle" fill="#fff" font-size="12" font-weight="600">Post-IO progression</text></g>' +
      '<g class="a-rise" style="animation-delay:1.7s"><rect x="236" y="132" width="140" height="32" rx="16" fill="#5f7284"/>' +
      '<circle cx="254" cy="148" r="5" fill="#fff" opacity=".7"/><text x="316" y="153" text-anchor="middle" fill="#fff" font-size="12" font-weight="600">ECOG 1</text></g>' +
      '<g class="a-float"><circle cx="330" cy="200" r="3" fill="#7fd4f0" opacity=".6"/></g>' +
      '<g class="a-float" style="animation-delay:1.2s"><circle cx="360" cy="186" r="2.2" fill="#7fd4f0" opacity=".45"/></g>' +
      '<g class="a-float" style="animation-delay:2s"><circle cx="300" cy="208" r="2.6" fill="#ffd166" opacity=".5"/></g>' +
      '</svg>',

    trial:
      '<svg viewBox="0 0 400 240" class="scene-svg">' +
      '<defs><linearGradient id="gt-arm" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#eaf5fb"/><stop offset="100%" stop-color="#d3e9f5"/>' +
      '</linearGradient></defs>' +
      '<g class="a-fade"><rect x="150" y="18" width="100" height="36" rx="10" fill="#0b4f6c"/>' +
      '<text x="200" y="41" text-anchor="middle" fill="#fff" font-size="13" font-weight="600">Patients</text></g>' +
      '<path class="a-ants" d="M200 54v34" stroke="#5f7284" stroke-width="2" fill="none"/>' +
      '<g class="a-fade" style="animation-delay:.5s"><rect x="146" y="88" width="108" height="34" rx="17" fill="#fff" stroke="#12789e" stroke-width="1.6"/>' +
      '<g class="a-spin" style="transform-origin:166px 105px"><path d="M166 98v14M159 105h14M161 100l10 10M171 100l-10 10" stroke="#12789e" stroke-width="1.6"/></g>' +
      '<text x="212" y="110" text-anchor="middle" fill="#0b4f6c" font-size="12.5" font-weight="700">Randomise 1:1</text></g>' +
      '<path class="a-ants" style="animation-delay:.9s" d="M178 122 L110 156" stroke="#5f7284" stroke-width="2" fill="none"/>' +
      '<path class="a-ants" style="animation-delay:.9s" d="M222 122 L290 156" stroke="#5f7284" stroke-width="2" fill="none"/>' +
      '<g class="a-rise" style="animation-delay:1.4s"><rect x="36" y="156" width="148" height="58" rx="12" fill="#f6f9fb" stroke="#dde5ec"/>' +
      '<text x="110" y="181" text-anchor="middle" fill="#5f7284" font-size="12.5" font-weight="700">Standard of care</text>' +
      '<text x="110" y="200" text-anchor="middle" fill="#8fa3b3" font-size="11">control arm</text></g>' +
      '<g class="a-rise" style="animation-delay:1.8s"><rect x="216" y="156" width="148" height="58" rx="12" fill="url(#gt-arm)" stroke="#12789e" stroke-width="1.6"/>' +
      '<rect x="216" y="156" width="148" height="58" rx="12" fill="none" stroke="#7fd4f0" stroke-width="4" opacity=".25" class="a-pulse"/>' +
      '<text x="290" y="181" text-anchor="middle" fill="#0b4f6c" font-size="12.5" font-weight="700">New therapy</text>' +
      '<text x="290" y="200" text-anchor="middle" fill="#3c7fa0" font-size="11">investigational arm</text></g>' +
      '<g class="a-pop" style="animation-delay:2.4s"><circle cx="200" cy="140" r="12" fill="#ffd166"/>' +
      '<text x="200" y="144.5" text-anchor="middle" fill="#6b4c00" font-size="10" font-weight="800">1:1</text></g>' +
      '</svg>',

    mechanism:
      '<svg viewBox="0 0 400 240" class="scene-svg">' +
      '<defs><linearGradient id="gm-liq" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#4db6dd"/><stop offset="100%" stop-color="#0b4f6c"/>' +
      '</linearGradient>' +
      '<clipPath id="gm-clip"><rect x="168" y="64" width="64" height="120" rx="14"/></clipPath></defs>' +
      '<g class="a-fade"><rect x="168" y="64" width="64" height="120" rx="14" fill="#eef6fa" stroke="#9cc3d8" stroke-width="2"/>' +
      '<rect x="184" y="44" width="32" height="24" rx="6" fill="#0b4f6c"/></g>' +
      '<g clip-path="url(#gm-clip)">' +
      '<path class="a-wave" d="M148 118q10-8 20 0t20 0 20 0 20 0 20 0 20 0v80h-120z" fill="url(#gm-liq)" opacity=".9"/>' +
      '<g class="a-bub"><circle cx="186" cy="170" r="3.4" fill="#fff" opacity=".55"/></g>' +
      '<g class="a-bub" style="animation-delay:1s"><circle cx="204" cy="176" r="2.4" fill="#fff" opacity=".5"/></g>' +
      '<g class="a-bub" style="animation-delay:1.8s"><circle cx="216" cy="168" r="2.9" fill="#fff" opacity=".5"/></g>' +
      '</g>' +
      '<g class="a-fade" style="animation-delay:.4s"><rect x="178" y="104" width="44" height="46" rx="8" fill="#fff" opacity=".92"/>' +
      '<text x="200" y="137" text-anchor="middle" fill="#0b4f6c" font-size="28" font-weight="800">?</text>' +
      '<rect x="178" y="104" width="44" height="46" rx="8" fill="none" stroke="#12789e" stroke-width="1.4"/></g>' +
      '<g class="a-orbit" style="transform-origin:200px 124px"><circle cx="200" cy="34" r="5" fill="#7fd4f0"/>' +
      '<circle cx="200" cy="214" r="3.6" fill="#ffd166"/></g>' +
      '<g class="a-pulse"><circle cx="200" cy="124" r="88" fill="none" stroke="#12789e" stroke-width="1.6" opacity=".3"/></g>' +
      '<g class="a-rise" style="animation-delay:1s"><rect x="268" y="98" width="116" height="52" rx="12" fill="#fff" stroke="#dde5ec"/>' +
      '<text x="326" y="120" text-anchor="middle" fill="#5f7284" font-size="11.5" font-weight="700">Novel mechanism</text>' +
      '<text x="326" y="137" text-anchor="middle" fill="#8fa3b3" font-size="10.5">blinded for this study</text></g>' +
      '</svg>',

    efficacy:
      '<svg viewBox="0 0 400 240" class="scene-svg">' +
      '<defs><linearGradient id="ge-area" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#12789e" stop-opacity=".28"/>' +
      '<stop offset="100%" stop-color="#12789e" stop-opacity="0"/></linearGradient></defs>' +
      '<line x1="56" y1="24" x2="56" y2="196" stroke="#c6d4de" stroke-width="1.6"/>' +
      '<line x1="56" y1="196" x2="372" y2="196" stroke="#c6d4de" stroke-width="1.6"/>' +
      '<text x="60" y="34" fill="#8fa3b3" font-size="10">% PFS</text>' +
      '<text x="300" y="214" fill="#8fa3b3" font-size="10">months</text>' +
      '<path class="a-km" d="M56 44h40v14h34v12h36v14h40v16h44v18h50v16h60" fill="none" stroke="#9db2c2" stroke-width="2.6"/>' +
      '<path class="a-km" style="animation-delay:.5s" d="M56 44h46v8h40v8h42v10h46v10h50v10h56v8h40" fill="none" stroke="#0b4f6c" stroke-width="3"/>' +
      '<path class="a-fade" style="animation-delay:1.6s" d="M56 44h46v8h40v8h42v10h46v10h50v10h56v8h40v80H56z" fill="url(#ge-area)"/>' +
      '<line class="a-fade" style="animation-delay:1.8s" x1="212" y1="44" x2="212" y2="196" stroke="#b26a00" stroke-width="1.4" stroke-dasharray="5 4"/>' +
      '<text class="a-fade" style="animation-delay:1.8s" x="216" y="208" fill="#b26a00" font-size="10">12 mo</text>' +
      '<g class="a-pop" style="animation-delay:2s"><rect x="120" y="118" width="58" height="26" rx="13" fill="#fff" stroke="#9db2c2"/>' +
      '<text x="149" y="135" text-anchor="middle" fill="#5f7284" font-size="12" font-weight="800">25%</text></g>' +
      '<g class="a-pop" style="animation-delay:2.3s"><rect x="196" y="78" width="58" height="26" rx="13" fill="#0b4f6c"/>' +
      '<text x="225" y="95" text-anchor="middle" fill="#fff" font-size="12" font-weight="800">45%</text></g>' +
      '<g class="a-rise" style="animation-delay:2.7s"><rect x="238" y="14" width="150" height="26" rx="13" fill="#fff4e2" stroke="#ecd6a8"/>' +
      '<text x="313" y="31" text-anchor="middle" fill="#b26a00" font-size="10.5" font-weight="700">Overall survival: not yet mature</text></g>' +
      '<g class="a-fade" style="animation-delay:.2s"><circle cx="70" cy="228" r="4" fill="#0b4f6c"/>' +
      '<text x="80" y="232" fill="#5f7284" font-size="10">New therapy</text>' +
      '<circle cx="160" cy="228" r="4" fill="#9db2c2"/>' +
      '<text x="170" y="232" fill="#5f7284" font-size="10">Standard of care</text></g>' +
      '</svg>',

    safety:
      '<svg viewBox="0 0 400 240" class="scene-svg">' +
      '<defs><linearGradient id="gs-arc" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0%" stop-color="#e09b2d"/><stop offset="100%" stop-color="#b26a00"/>' +
      '</linearGradient></defs>' +
      '<circle cx="146" cy="120" r="66" fill="none" stroke="#eef3f6" stroke-width="26"/>' +
      '<circle class="a-donut" cx="146" cy="120" r="66" fill="none" stroke="url(#gs-arc)" stroke-width="26" transform="rotate(-90 146 120)"/>' +
      '<g class="a-pop" style="animation-delay:.9s"><text x="146" y="116" text-anchor="middle" fill="#b26a00" font-size="32" font-weight="800">30%</text>' +
      '<text x="146" y="138" text-anchor="middle" fill="#5f7284" font-size="10.5">Grade 3+ treatment-related</text></g>' +
      '<g class="a-rise" style="animation-delay:1.3s"><rect x="244" y="76" width="136" height="40" rx="10" fill="#fff4e2" stroke="#ecd6a8"/>' +
      '<path d="M262 88l-7 12h14z" fill="#b26a00"/>' +
      '<text x="318" y="101" text-anchor="middle" fill="#b26a00" font-size="11.5" font-weight="700">Adverse events</text></g>' +
      '<g class="a-rise" style="animation-delay:1.7s"><rect x="244" y="126" width="136" height="40" rx="10" fill="#eefaf3" stroke="#bfe6d2"/>' +
      '<circle cx="262" cy="146" r="7" fill="none" stroke="#1a7f4b" stroke-width="2"/>' +
      '<path d="M258.6 146l2.6 2.8 4.6-5.4" fill="none" stroke="#1a7f4b" stroke-width="2"/>' +
      '<text x="320" y="151" text-anchor="middle" fill="#1a7f4b" font-size="11.5" font-weight="700">70% below Grade 3</text></g>' +
      '<g class="a-pulse"><circle cx="146" cy="120" r="92" fill="none" stroke="#e09b2d" stroke-width="1.4" opacity=".25"/></g>' +
      '</svg>',

    cdx:
      '<svg viewBox="0 0 400 240" class="scene-svg">' +
      '<g class="a-fade"><path class="a-helix" d="M60 40c30 26 30 54 0 80s-30 54 0 80" fill="none" stroke="#12789e" stroke-width="3"/>' +
      '<path class="a-helix" style="animation-delay:.15s" d="M96 40c-30 26-30 54 0 80s30 54 0 80" fill="none" stroke="#7fd4f0" stroke-width="3"/>' +
      '<path class="a-draw" d="M66 60h24M62 80h32M62 100h32M66 120h24M62 140h32M62 160h32M66 180h24" stroke="#9cc3d8" stroke-width="1.6"/></g>' +
      '<g class="a-rise" style="animation-delay:.4s"><rect x="132" y="34" width="150" height="52" rx="12" fill="#e8f2f7" stroke="#12789e"/>' +
      '<text x="207" y="57" text-anchor="middle" fill="#0b4f6c" font-size="13" font-weight="800">Broad NGS panel</text>' +
      '<text x="207" y="75" text-anchor="middle" fill="#5f7284" font-size="10">required to select patients</text></g>' +
      ['EGFR', 'ALK', 'ROS1', 'KRAS', 'BRAF', 'MET'].map(function (g, i) {
        return '<g class="a-pop" style="animation-delay:' + (0.9 + i * 0.25).toFixed(2) + 's">' +
          '<rect x="' + (140 + (i % 3) * 44) + '" y="' + (104 + Math.floor(i / 3) * 34) +
          '" width="38" height="26" rx="6" fill="#fff" stroke="#12789e"/>' +
          '<text x="' + (159 + (i % 3) * 44) + '" y="' + (121 + Math.floor(i / 3) * 34) +
          '" text-anchor="middle" fill="#0b4f6c" font-size="9" font-weight="700">' + g +
          '</text></g>';
      }).join("") +
      '<g class="a-stamp" style="animation-delay:2.6s"><rect x="292" y="104" width="92" height="36" rx="9" fill="#0b4f6c"/>' +
      '<text x="338" y="127" text-anchor="middle" fill="#fff" font-size="12" font-weight="800">Eligible</text></g>' +
      '<g class="a-float"><circle cx="320" cy="60" r="3" fill="#7fd4f0" opacity=".55"/></g>' +
      '<g class="a-float" style="animation-delay:1.4s"><circle cx="352" cy="76" r="2.2" fill="#ffd166" opacity=".5"/></g>' +
      '</svg>',

    attributes:
      '<svg viewBox="0 0 400 240" class="scene-svg">' +
      '<g class="a-pulse"><circle cx="200" cy="118" r="30" fill="none" stroke="#12789e" stroke-width="1.6" opacity=".4"/></g>' +
      '<g class="a-pop"><circle cx="200" cy="118" r="22" fill="#0b4f6c"/>' +
      '<text x="200" y="114" text-anchor="middle" fill="#7fd4f0" font-size="9" font-weight="700">YOUR</text>' +
      '<text x="200" y="126" text-anchor="middle" fill="#fff" font-size="9" font-weight="700">CHOICE</text></g>' +
      [["&#9203;", "Overall survival", 62, 44], ["&#128200;", "12-month PFS", 200, 30],
       ["&#9888;", "Grade 3+ AEs", 338, 44], ["&#128137;", "Administration", 48, 128],
       ["&#129516;", "Companion dx", 352, 128], ["&#128178;", "Annual cost", 62, 196],
       ["&#127973;", "Payer access", 338, 196]].map(function (p, i) {
        return '<path class="a-draw" style="animation-delay:' + (0.4 + i * 0.3).toFixed(2) +
          's" d="M200 118 L' + p[2] + ' ' + p[3] + '" stroke="#bcd6e4" stroke-width="1.4" fill="none"/>' +
          '<g class="a-pop" style="animation-delay:' + (0.5 + i * 0.3).toFixed(2) + 's">' +
          '<rect x="' + (p[2] - 52) + '" y="' + (p[3] - 17) + '" width="104" height="34" rx="17" fill="#e8f2f7" stroke="#12789e"/>' +
          '<text x="' + (p[2] - 34) + '" y="' + (p[3] + 5) + '" font-size="12">' + p[0] + '</text>' +
          '<text x="' + (p[2] + 8) + '" y="' + (p[3] + 4) + '" text-anchor="middle" fill="#0b4f6c" font-size="10.5" font-weight="700">' + p[1] +
          '</text></g>';
      }).join("") +
      '<g class="a-pop" style="animation-delay:2.9s"><rect x="148" y="200" width="104" height="30" rx="15" fill="#f6f9fb" stroke="#dde5ec" stroke-dasharray="5 4"/>' +
      '<text x="200" y="219" text-anchor="middle" fill="#5f7284" font-size="10" font-weight="700">or continue SOC</text></g>' +
      '</svg>',
    dosing:
      '<svg viewBox="0 0 400 240" class="scene-svg">' +
      '<g class="a-rise"><rect x="120" y="60" width="160" height="120" rx="14" fill="#e8f2f7" stroke="#12789e" stroke-width="1.5"/>' +
      '<rect x="120" y="60" width="160" height="26" rx="14" fill="#0b4f6c"/>' +
      '<text x="200" y="78" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">DOSING SCHEDULE</text></g>' +
      [0, 1, 2, 3, 4, 5, 6].map(function (d) {
        var on = d === 0 || d === 3;
        return '<g class="a-pop" style="animation-delay:' + (0.3 + d * 0.12).toFixed(2) + 's">' +
          '<rect x="' + (134 + d * 19) + '" y="100" width="15" height="15" rx="4" fill="' + (on ? "#12789e" : "#fff") +
          '" stroke="#12789e"/>' +
          (on ? '<circle cx="' + (141.5 + d * 19) + '" cy="107.5" r="3" fill="#fff"/>' : "") + "</g>";
      }).join("") +
      '<g class="a-float"><rect x="150" y="128" width="100" height="36" rx="18" fill="#fff" stroke="#dde5ec"/>' +
      '<circle cx="170" cy="146" r="9" fill="#7fd4f0"/><rect x="186" y="141" width="52" height="10" rx="5" fill="#cfdce6"/></g>' +
      '<g class="a-pulse"><circle cx="200" cy="120" r="88" fill="none" stroke="#12789e" stroke-width="1.4" opacity=".35"/></g>' +
      '</svg>',
    access:
      '<svg viewBox="0 0 400 240" class="scene-svg">' +
      '<g class="a-rise"><path d="M110 190 V96 l90-46 90 46v94z" fill="#e8f2f7" stroke="#12789e" stroke-width="1.5"/>' +
      '<rect x="176" y="130" width="48" height="60" rx="6" fill="#0b4f6c"/></g>' +
      '<g class="a-pop" style="animation-delay:.5s"><rect x="128" y="110" width="30" height="30" rx="5" fill="#fff" stroke="#12789e"/>' +
      '<rect x="242" y="110" width="30" height="30" rx="5" fill="#fff" stroke="#12789e"/></g>' +
      '<g class="a-pop" style="animation-delay:.9s"><circle cx="300" cy="70" r="22" fill="#1a7f4b"/>' +
      '<path d="M289 70l8 8 14-16" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></g>' +
      '<g class="a-fade" style="animation-delay:1.1s"><text x="300" y="112" text-anchor="middle" fill="#0b4f6c" font-size="11" font-weight="700">covered</text></g>' +
      '<g class="a-ants"><path d="M60 200 H340" stroke="#bcd6e4" stroke-width="2" fill="none"/></g>' +
      '</svg>',
    generic:
      '<svg viewBox="0 0 400 240" class="scene-svg">' +
      '<g class="a-pulse"><circle cx="200" cy="120" r="70" fill="none" stroke="#12789e" stroke-width="1.6" opacity=".4"/></g>' +
      '<g class="a-pop"><circle cx="200" cy="120" r="44" fill="#e8f2f7" stroke="#12789e" stroke-width="1.5"/>' +
      '<path d="M200 96v48M176 120h48" stroke="#0b4f6c" stroke-width="5" stroke-linecap="round"/></g>' +
      '<g class="a-orbit" style="transform-origin:200px 120px"><circle cx="200" cy="50" r="6" fill="#7fd4f0"/></g>' +
      '<g class="a-float"><rect x="90" y="176" width="220" height="14" rx="7" fill="#cfdce6"/>' +
      '<rect x="120" y="198" width="160" height="10" rx="5" fill="#dde5ec"/></g>' +
      '</svg>'
  };

  // Human labels for the Studio artwork picker. Order = display order.
  var ART_LABELS = [
    ["patient", "Patient"], ["trial", "Pivotal trial"], ["mechanism", "Mechanism of action"],
    ["efficacy", "Efficacy"], ["safety", "Safety"], ["cdx", "Companion diagnostic"],
    ["dosing", "Dosing / administration"], ["access", "Access / coverage"],
    ["attributes", "Choice attributes"], ["generic", "Generic"]
  ];

  // ---------------------------------------------------------------- player
  // The narration is the clock.  Everything visual - the caption, the progress bar, the
  // timeline, the audio meter - reads from one place, so the picture and the voice cannot
  // drift apart.  Three sources feed that clock and all three report the same two numbers:
  // how many seconds into this step we are, and which word is being spoken.
  //
  //   browser speech  exact when the platform fires `onboundary` (Chrome, Firefox);
  //                   estimated from elapsed time everywhere else - Safari never fires it
  //   uploaded clip   `timeupdate` against the clip's real duration
  //   muted / silent  a plain timer against the estimated length
  //
  // Estimating by default and correcting when a boundary arrives is deliberate: it keeps
  // the caption moving on every browser instead of freezing on the ones that do not report
  // word positions.
  var WPS = 2.5;                 // narration pace, words per second, for the estimate

  function wordsOf(text) {
    var out = [], starts = [];
    var re = /\S+/g, m;
    while ((m = re.exec(text || ""))) { out.push(m[0]); starts.push(m.index); }
    return { text: text || "", words: out, starts: starts };
  }

  function wordAt(w, charIndex) {
    // the last word that has started by charIndex
    var lo = 0, hi = w.starts.length - 1, best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (w.starts[mid] <= charIndex) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  function fmtTime(s) {
    s = Math.max(0, Math.round(s || 0));
    return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }

  // How long a step lasts, known before it plays, so the timeline can be drawn up front.
  function stepSeconds(sc, clip, nextSc) {
    if (clip && clip.seconds) {
      // several study-level scenes can share one clip and carve it up with `at` offsets
      var sameClip = !!(nextSc && (nextSc.clip || nextSc.src) && (nextSc.clip || nextSc.src) === (sc.clip || sc.src));
      if (sameClip && nextSc.at != null && sc.at != null && nextSc.at > sc.at) return nextSc.at - sc.at;
      if (sc.at != null) return Math.max(2, clip.seconds - sc.at);
      return clip.seconds;
    }
    var words = ((sc.title || "") + " " + (sc.caption || "")).trim().split(/\s+/).filter(Boolean).length;
    return Math.max(4, Math.min(22, words / WPS));
  }

  // A level meter that follows the narration without touching the audio graph: routing an
  // <audio> through an AnalyserNode hijacks its output, which would put mute, autoplay and
  // CORS at risk for no visible gain at this size.
  function vizLevel(t, bar) {
    var a = Math.sin(t * 7.3 + bar * 1.7) + Math.sin(t * 11.9 + bar * 3.1) * 0.6 +
            Math.sin(t * 3.7 + bar * 0.9) * 0.5;
    return Math.min(1, Math.max(0.08, 0.5 + a * 0.26));
  }

  function Explainer(root, opts) {
    this.root = root;
    this.scenes = opts.scenes || [];
    this.narration = opts.narration || {};
    this.onDone = opts.onDone || function () {};
    this.muted = !!opts.muted;
    this.tts = !!opts.tts;
    this.i = -1;
    this.paused = false;
    this.playingClip = null;
    this.noClip = false;
    this.raf = null;
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.build();
  }

  Explainer.prototype.build = function () {
    var self = this;
    this.root.innerHTML =
      '<div class="ex-shell" id="ex-shell">' +
      '  <div class="ex-ambient"></div>' +
      '  <div class="ex-stage">' +
      '    <div class="ex-art" id="ex-artA"></div>' +
      '    <div class="ex-art" id="ex-artB"></div>' +
      '    <div class="ex-vignette"></div>' +
      '    <div class="ex-sound" id="ex-sound" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>' +
      '  </div>' +
      '  <div class="ex-caption" id="ex-caption">' +
      '    <strong id="ex-title"></strong>' +
      '    <span id="ex-sub" role="status" aria-live="polite"></span>' +
      '  </div>' +
      '  <div class="ex-bar">' +
      '    <div class="ex-track" id="ex-track">' +
      '      <div class="ex-fill" id="ex-fill"></div>' +
      '      <div class="ex-chaps" id="ex-dots"></div>' +
      '    </div>' +
      '    <div class="ex-time"><span id="ex-now">0:00</span><span id="ex-total">0:00</span></div>' +
      '  </div>' +
      '  <div class="ex-controls">' +
      '    <button class="ex-btn ghost ic" id="ex-prev" type="button" title="Previous step" aria-label="Previous step">&#8249;</button>' +
      '    <button class="ex-btn primary" id="ex-play" type="button" aria-label="Pause">Pause</button>' +
      '    <button class="ex-btn ghost ic" id="ex-next" type="button" title="Next step" aria-label="Next step">&#8250;</button>' +
      '    <span class="ex-sound-ctl"><button class="ex-btn ghost ic" id="ex-mute" type="button" aria-label="Mute">&#128266;</button></span>' +
      '    <button class="ex-btn ghost ic" id="ex-replay" type="button" title="Play again" aria-label="Play again">&#8635;</button>' +
      '    <button class="ex-btn ghost" id="ex-skip" type="button">Skip</button>' +
      '    <span class="ex-scene" id="ex-scene"></span>' +
      '  </div>' +
      '  <button class="ex-bigplay" id="ex-bigplay" type="button" hidden>' +
      '    <span class="ex-bigplay-ring"></span><span class="ex-bigplay-tri">&#9654;</span>' +
      '    <em>Play the narration</em>' +
      '  </button>' +
      '</div>';

    this.shell = this.root.querySelector("#ex-shell");
    this.layers = [this.root.querySelector("#ex-artA"), this.root.querySelector("#ex-artB")];
    this.active = 0;
    this.title = this.root.querySelector("#ex-title");
    this.sub = this.root.querySelector("#ex-sub");
    this.cap = this.root.querySelector("#ex-caption");
    this.track = this.root.querySelector("#ex-track");
    this.fill = this.root.querySelector("#ex-fill");
    this.dotsWrap = this.root.querySelector("#ex-dots");
    this.nowEl = this.root.querySelector("#ex-now");
    this.totalEl = this.root.querySelector("#ex-total");
    this.counter = this.root.querySelector("#ex-scene");
    this.playBtn = this.root.querySelector("#ex-play");
    this.bigplay = this.root.querySelector("#ex-bigplay");
    this.sound = this.root.querySelector("#ex-sound");

    this.buildChapters();
    this.total = this.timelineTotal();
    this.totalEl.textContent = fmtTime(this.total);

    var dots = this.dotsWrap.children;
    for (var d = 0; d < dots.length; d++) {
      (function (el) {
        el.addEventListener("click", function () {
          self.loadScene(parseInt(el.getAttribute("data-i"), 10));
        });
      })(dots[d]);
    }

    this.playBtn.addEventListener("click", function () { self.toggle(); });
    this.bigplay.addEventListener("click", function () { self.toggle(); });
    this.root.querySelector("#ex-prev").addEventListener("click", function () {
      if (self.i > 0) self.loadScene(self.i - 1);
    });
    this.root.querySelector("#ex-next").addEventListener("click", function () { self.next(); });
    this.root.querySelector("#ex-mute").addEventListener("click", function () {
      self.setMuted(!self.muted);
    });
    this.root.querySelector("#ex-replay").addEventListener("click", function () {
      self.loadScene(0);
    });
    this.root.querySelector("#ex-skip").addEventListener("click", function () { self.finish(); });

    this.audio.addEventListener("ended", function () { self.onClipEnded(); });
    this.audio.addEventListener("error", function () {
      // narration unavailable: fall back to a readable timed walkthrough rather than stalling
      if (self.playingClip) self.useTimer();
    });
    this.audio.addEventListener("timeupdate", function () { self.syncFromAudio(); });
    this.setMuted(this.muted);
  };

  // One chapter marker per step, placed at its offset along the timeline, so the bar reads
  // as a video scrubber rather than a row of unrelated dots.
  Explainer.prototype.buildChapters = function () {
    var html = "", off = 0;
    for (var i = 0; i < this.scenes.length; i++) {
      var sc = this.scenes[i];
      var dur = stepSeconds(sc, this.clipFor(sc), this.scenes[i + 1]);
      html += '<span class="ex-dot" data-i="' + i + '" data-title="' +
        String(sc.title || ("Step " + (i + 1))).replace(/"/g, "&quot;") + '"' +
        ' style="left:' + (off / Math.max(0.001, this.timelineTotal()) * 100).toFixed(2) + '%"></span>';
      off += dur;
    }
    this.dotsWrap.innerHTML = html;
  };

  Explainer.prototype.clipFor = function (sc) {
    var clip = sc.clip ? this.narration[sc.clip] : null;
    if (!clip && sc.src) clip = { src: sc.src, seconds: sc.seconds || 0 };
    return clip || null;
  };

  Explainer.prototype.timelineTotal = function () {
    var t = 0;
    for (var i = 0; i < this.scenes.length; i++) {
      t += stepSeconds(this.scenes[i], this.clipFor(this.scenes[i]), this.scenes[i + 1]);
    }
    return t;
  };

  Explainer.prototype.offsetBefore = function (i) {
    var t = 0;
    for (var k = 0; k < i; k++) t += stepSeconds(this.scenes[k], this.clipFor(this.scenes[k]), this.scenes[k + 1]);
    return t;
  };

  Explainer.prototype.setMuted = function (m) {
    this.muted = !!m;
    this.audio.muted = this.muted;
    var vids = this.layers[this.active] ? this.layers[this.active].querySelectorAll("video") : [];
    for (var i = 0; i < vids.length; i++) { try { vids[i].muted = this.muted; } catch (e) {} }
    var btn = this.root.querySelector("#ex-mute");
    if (btn) {
      btn.innerHTML = this.muted ? "&#128263;" : "&#128266;";
      btn.setAttribute("aria-label", this.muted ? "Unmute" : "Mute");
    }
    if (this.sound) this.sound.classList.toggle("off", this.muted);
    this.shell.classList.toggle("muted", this.muted);
    if (this.muted) this.stopSpeech();
  };

  Explainer.prototype.start = function () {
    this.i = -1;
    this.loadScene(0);
  };

  Explainer.prototype.stopSpeech = function () {
    try { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); } catch (e) {}
    this.utterance = null;
  };

  Explainer.prototype.useTimer = function () {
    // no usable audio at all: run the step on the clock and let the caption still animate
    var self = this;
    if (this.muted) { this.noClip = true; return; }
    this.noClip = true;
    this.paused = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(function f() { self.frame(); self.raf = requestAnimationFrame(f); });
  };

  Explainer.prototype.setClip = function (sc) {
    var self = this;
    this.clearTimers();
    this.stopSpeech();
    var clip = this.clipFor(sc);
    if (sc.clip && !clip && !sc.src) { this.finish(); return; }

    this.sc = sc;
    this.words = wordsOf((sc.title ? sc.title + ". " : "") + (sc.caption || ""));
    this.sceneDur = stepSeconds(sc, clip, this.scenes[this.i + 1]);
    this.sceneStart = Date.now();
    this.acc = 0;
    this.advanced = false;
    this.boundarySeen = false;
    this.renderCaption(0);

    if (!clip) {
      // No produced narration for this step: speak it with the browser's speech engine, or
      // run timed when muted / unsupported, so the walkthrough always follows the text the
      // researcher wrote.
      this.noClip = true;
      this.playingClip = null;
      if (this.tts && !this.muted && "speechSynthesis" in window && this.words.text.trim()) {
        try {
          var u = new SpeechSynthesisUtterance(this.words.text);
          u.lang = "en-US";
          u.onboundary = function (e) {
            if (typeof e.charIndex !== "number") return;
            self.boundarySeen = true;
            // remember the drift so the estimate tightens for the rest of the step
            self.drift = (self.elapsed() / Math.max(0.5, self.sceneDur)) - (e.charIndex / Math.max(1, self.words.text.length));
            self.renderCaption(wordAt(self.words, e.charIndex));
          };
          u.onend = function () { self.advance(); };
          u.onerror = function () { self.useTimer(); };
          this.utterance = u;
          window.speechSynthesis.speak(u);
        } catch (e) { this.useTimer(); }
      }
      this.paused = false;
      this.runClock();
      return;
    }

    this.noClip = false;
    var key = sc.clip || sc.src;
    if (key === this.playingClip && !this.audio.paused) return;
    this.playingClip = key;
    this.audio.pause();
    try {
      this.audio.src = clip.src ? clip.src : "/audio/" + clip.file;
      this.audio.muted = this.muted;
      var p = this.audio.play();
      if (p && p.catch) {
        p.catch(function () {
          // autoplay blocked: offer the button rather than silently running a timer the
          // respondent never asked for
          self.bigplay.hidden = false;
          self.shell.classList.add("needs-play");
          self.useTimer();
        });
      }
      if (sc.at) {
        this.audio.addEventListener("loadedmetadata", function once() {
          try { self.audio.currentTime = sc.at; } catch (e) {}
          self.audio.removeEventListener("loadedmetadata", once);
        });
      }
    } catch (e) { this.useTimer(); }
    this.paused = false;
    this.runClock();
  };

  // seconds into the current step, from whichever source is live
  Explainer.prototype.elapsed = function () {
    if (this.noClip) return this.acc + (this.paused ? 0 : (Date.now() - this.sceneStart) / 1000);
    return (this.audio && this.audio.currentTime) || 0;
  };

  Explainer.prototype.syncFromAudio = function () {
    if (this.noClip || this.i < 0) return;
    var dur = this.audio.duration;
    if (dur && isFinite(dur) && dur > 0 && Math.abs(dur - (this.clipFor(this.sc) || {}).seconds || 0) > 0.5) {
      var clip = this.clipFor(this.sc);
      if (clip) clip.seconds = Math.round(dur * 10) / 10;   // mutagen could not read it
    }
    this.renderCaption(this.wordIndexFromTime());
  };

  Explainer.prototype.wordIndexFromTime = function () {
    if (!this.words || !this.words.words.length || !this.sceneDur) return 0;
    var frac = Math.min(1, Math.max(0, this.elapsed() / this.sceneDur));
    return Math.min(this.words.words.length - 1, Math.floor(frac * this.words.words.length));
  };

  // The caption is the animation: words light up as they are spoken, so the text on screen
  // moves with the voice instead of sitting there as a paragraph.
  Explainer.prototype.renderCaption = function (idx) {
    if (!this.words) return;
    // nothing is being spoken only when the respondent muted it
    var spoken = this.muted;
    var html = "";
    for (var k = 0; k < this.words.words.length; k++) {
      var cls = "w";
      if (!spoken) {
        if (k < idx) cls += " done";
        else if (k === idx) cls += " cur";
      }
      html += '<span class="' + cls + '">' + escapeHtml(this.words.words[k]) + "</span> ";
    }
    this.sub.innerHTML = html;
    if (!spoken && idx >= 0 && idx < this.words.words.length) {
      var cur = this.sub.children[idx];
      if (cur && cur.scrollIntoView) { try { cur.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) {} }
    }
  };

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  Explainer.prototype.runClock = function () {
    var self = this;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(function f() {
      self.frame();
      self.raf = requestAnimationFrame(f);
    });
  };

  Explainer.prototype.clearTimers = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.sceneTimer) { clearTimeout(this.sceneTimer); this.sceneTimer = null; }
    if (this.fallbackTimer) { clearInterval(this.fallbackTimer); this.fallbackTimer = null; }
  };

  // One frame of everything visual.  Called from a single loop so the caption, the bar, the
  // timeline and the meter can never disagree.
  Explainer.prototype.frame = function () {
    if (this.i < 0 || !this.sc) return;
    var pos = this.elapsed();
    var sc = this.sc, nextSc = this.scenes[this.i + 1];
    var frac = this.sceneDur > 0 ? Math.min(1, Math.max(0, pos / this.sceneDur)) : 1;

    // caption follows the estimate until a word boundary corrects it
    if (!this.boundarySeen) this.renderCaption(this.wordIndexFromTime());

    // the bar is the whole timeline, not just this step
    var total = this.total || 1;
    var at = Math.min(pos, this.sceneDur);
    var done = (this.offsetBefore(this.i) + at) / total;
    this.fill.style.width = (Math.min(1, Math.max(0, done)) * 100).toFixed(2) + "%";
    this.nowEl.textContent = fmtTime(this.offsetBefore(this.i) + at);

    // the meter breathes with the narration
    if (this.sound && !this.muted) {
      var bars = this.sound.children;
      for (var b = 0; b < bars.length; b++) {
        bars[b].style.transform = "scaleY(" + vizLevel(pos, b).toFixed(3) + ")";
      }
    }

    // several study-level scenes can share one clip and carve it up with `at` offsets
    if (!this.noClip && nextSc && sc.at != null && nextSc.at != null &&
        (nextSc.clip || nextSc.src) === (sc.clip || sc.src) && pos >= nextSc.at) {
      this.loadScene(this.i + 1);
      return;
    }

    // safety net: a speech engine that never reports `end` must not strand the respondent
    if (this.noClip && !this.advanced && pos >= this.sceneDur + 1.5) this.advance();
  };

  Explainer.prototype.advance = function () {
    if (this.advanced) return;
    this.advanced = true;
    this.next();
  };

  Explainer.prototype.onClipEnded = function () {
    if (this.noClip) return;
    this.advance();
  };

  Explainer.prototype.loadScene = function (i) {
    if (i >= this.scenes.length) return this.finish();
    if (i < 0) i = 0;
    var sc = this.scenes[i];
    this.i = i;
    this.bigplay.hidden = true;
    this.shell.classList.remove("needs-play");

    // crossfade: draw into the hidden layer, then bring it in with a slow drift so the
    // picture is never completely still
    var show = 1 - this.active;
    var layer = this.layers[show];
    layer.innerHTML = mediaFor(sc) || ART[sc.art] || ART[sc.id] || ART.generic;
    // a fresh Ken Burns direction per step: the same scene twice never pans the same way
    var kx = (i % 2 ? 1 : -1) * (2.2 + (i % 3) * 0.9);
    var ky = (i % 3 === 2 ? 1 : -1) * (1.4 + (i % 2) * 0.8);
    layer.style.setProperty("--kb-x", kx.toFixed(2) + "%");
    layer.style.setProperty("--kb-y", ky.toFixed(2) + "%");
    void layer.offsetWidth;                       // restart the CSS animations
    layer.classList.add("on");
    this.layers[this.active].classList.remove("on");
    this.active = show;

    this.shell.setAttribute("data-scene", sc.art || sc.id);
    this.title.textContent = sc.title || ("Step " + (i + 1));
    var cap = this.cap || this.title.parentElement;
    if (cap) { cap.classList.remove("cap-in"); void cap.offsetWidth; cap.classList.add("cap-in"); }

    this.counter.textContent = (i + 1) + " / " + this.scenes.length;
    var dots = this.dotsWrap.children;
    for (var d = 0; d < dots.length; d++) dots[d].classList.toggle("cur", d === i);

    this.setClip(sc);
  };

  Explainer.prototype.next = function () {
    this.loadScene(this.i + 1);
  };

  Explainer.prototype.startFallback = function () {
    // kept for callers outside this file: the clock now owns the fallback
    this.useTimer();
  };

  Explainer.prototype.toggle = function () {
    if (this.muted) { this.setMuted(false); return; }
    this.paused = !this.paused;
    this.playBtn.textContent = this.paused ? "Play" : "Pause";
    this.playBtn.setAttribute("aria-label", this.paused ? "Play" : "Pause");
    this.shell.classList.toggle("paused", this.paused);
    if (this.noClip) {
      if ("speechSynthesis" in window) {
        try {
          if (this.paused) window.speechSynthesis.pause();
          else window.speechSynthesis.resume();
        } catch (e) {}
      }
      if (this.paused) { this.acc = this.elapsed(); } else { this.sceneStart = Date.now(); }
      return;
    }
    try {
      if (this.paused) this.audio.pause();
      else { var p = this.audio.play(); if (p && p.catch) p.catch(function () {}); }
    } catch (e) {}
  };

  Explainer.prototype.finish = function () {
    this.clearTimers();
    this.stopSpeech();
    this.raf = null;
    try { this.audio.pause(); } catch (e) {}
    this.onDone();
  };

  // An author-supplied attachment wins over the built-in artwork: a step with an image or a
  // video shows that, everything else falls back to the animated scene.
  function mediaFor(sc) {
    var m = sc.media;
    if (!m || !m.src) return "";
    var kind = m.kind || (/\.(mp4|webm|mov)(\?|$)/i.test(m.src) ? "video" : "image");
    if (kind === "video") {
      return '<video class="scene-media" src="' + m.src + '" autoplay muted loop playsinline></video>';
    }
    return '<img class="scene-media" src="' + m.src + '" alt="">';
  }

  global.BeaconExplainer = Explainer;
  global.BEACON_ART = ART;
  global.BEACON_ART_LABELS = ART_LABELS;
})(window);
