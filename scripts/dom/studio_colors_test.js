/* jsdom check of the rich-text colour palettes in the Studio: the standard palette offered
   for font colour and for text highlight, the custom colour area (hex / R-G-B / picker),
   recently-used colours, the legibility warning, and the fact that "Automatic" / "No colour"
   take the colour off without touching the author's other formatting.
   Needs the server on :8000 and jsdom.
   node scripts/dom/studio_colors_test.js */let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch (e) { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
const http=require("http"); const BASE=process.env.BASE||"http://127.0.0.1:8000";
function req(method,p,body){return new Promise((res,rej)=>{const u=new URL(BASE+p);const h={};if(body)h["Content-Type"]="application/json";
  const r=http.request(u,{method,headers:h},x=>{let d="";x.on("data",c=>d+=c);x.on("end",()=>res({status:x.statusCode,body:d}));});r.on("error",rej);if(body)r.write(body);r.end();});}
const get=p=>req("GET",p).then(r=>r.body);
let fails=0; const check=(l,c,d="")=>{console.log((c?"PASS  ":"\u003e\u003e\u003e---FAIL  ")+l+(c?"":"  -> "+d)); if(!c)fails++;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const cfg={sections:[{id:"S1",title:"Main"}],
    questions:[{id:"Q1",section:"S1",type:"open_text",stem:"Which therapy do you use most?"}],tpp:{},explainer_scenes:[]};
  const slug=JSON.parse((await req("POST","/api/studio/save",JSON.stringify({title:"Colour Test",cfg}))).body).slug;
  const dom=new JSDOM(await get("/studio/"),{url:BASE+"/studio/#"+slug,runScripts:"outside-only",pretendToBeVisual:true}); const w=dom.window;
  w.BEACON_PREVIEW_MODE=true; w.requestAnimationFrame=fn=>setTimeout(fn,0); w.scrollTo=()=>{};
  w.Element.prototype.scrollIntoView=function(){}; w.confirm=()=>true;
  w.fetch=(u,o)=>{const U=new URL(u,BASE); return req((o&&o.method)||"GET",U.pathname+U.search,o&&o.body).then(
    x=>({ok:x.status<400,status:x.status,json:()=>Promise.resolve(JSON.parse(x.body))}));};
  // jsdom has no execCommand: stub it to return false so the span-wrapping fallback is exercised
  w.document.execCommand=()=>false;
  const errs=[]; w.addEventListener("error",e=>errs.push(e.message));
  for (const f of ["qlogic.js","survey.js","explainer.js","studio.js"]) w.eval(await get("/static/js/"+f));
  await sleep(700);
  const doc=w.document, $=s=>doc.querySelector(s), $$=s=>[...doc.querySelectorAll(s)];
  const click=el=>el.dispatchEvent(new w.MouseEvent("click",{bubbles:true,cancelable:true}));
  const type=(el,v)=>{el.value=v; el.dispatchEvent(new w.Event("input",{bubbles:true}));};
  const P=s=>$(".st-color-pop.open "+s);                      // scope to the open palette
  // select a substring wherever it currently lives (the DOM is re-wrapped after each colour)
  const pick=sub=>{const w=doc.createTreeWalker(stem,4),ns=[];while(w.nextNode())ns.push(w.currentNode);
    for(const n of ns){const i=n.nodeValue.indexOf(sub);if(i<0)continue;
      const r=doc.createRange();r.setStart(n,i);r.setEnd(n,i+sub.length);
      const s=w2.getSelection();s.removeAllRanges();s.addRange(r);return;}
    throw new Error("not found: "+sub);};
  const inHost=()=>{const s=w2.getSelection();return !!(s&&s.rangeCount&&stem.contains(s.anchorNode));};
  // what a real browser does when focus leaves the editable: the selection goes with it
  const loseSelection=()=>{const r=doc.createRange();r.selectNodeContents(doc.body);
    const s=w2.getSelection();s.removeAllRanges();s.addRange(r);};
  const toastText=()=>[...doc.querySelectorAll("[class*=toast]")].map(t=>t.textContent).join(" ");
  const set=txt=>{stem.innerHTML=txt;};
  const pickSwatch=title=>{const c=$(`.st-color-pop.open .st-color-cell[title="${title}"]`);
    const hex=c.getAttribute("data-color");click(c);return hex;};
  const rgb=h=>{const m=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
    return m?`rgb(${parseInt(m[1],16)}, ${parseInt(m[2],16)}, ${parseInt(m[3],16)})`:h;};
  // open the palette of this kind, whatever is currently open
  const openPalette=k=>{ if(!$(".st-color-pop.open") ||
      $(".st-color-pop.open").getAttribute("data-palette-kind")!==k) click($("[data-color-trigger="+k+"]")); };
  const stem=$("#f-stem-rich"), selectAll=el=>{const r=doc.createRange();r.selectNodeContents(el);
    const s=w.getSelection();s.removeAllRanges();s.addRange(r);};
  const w2=w;

  // ---------------- both pickers are on both rich-text fields -------------------------
  check("question text toolbar has a font-colour and a highlight button",
    !!$(".st-toolbar[data-for=f-stem-rich] [data-color-trigger=foreColor]") &&
    !!$(".st-toolbar[data-for=f-stem-rich] [data-color-trigger=hiliteColor]"));
  check("help text toolbar has them too",
    !!$(".st-toolbar[data-for=f-help-rich] [data-color-trigger=foreColor]") &&
    !!$(".st-toolbar[data-for=f-help-rich] [data-color-trigger=hiliteColor]"));

  // ---------------- the font-colour palette -------------------------------------------
  click($("[data-color-trigger=foreColor]"));
  check("clicking A opens the font-colour palette", $(".st-color-pop.open") &&
    $(".st-color-pop.open").getAttribute("data-palette-kind")==="foreColor");
  check("Automatic is what is selected to start with",
    $(".st-color-none.on") && /Automatic/.test($(".st-color-none.on").textContent));
  check("the palette is a standard 10-column grid", /repeat\(10,/.test(
    (await get("/static/css/studio.css")).match(/\.st-color-grid\{[^}]*\}/)[0]));
  check("theme colours: 10 hues x 5 tints",
    $$(".st-color-pop.open .st-color-grid").some(g=>g.querySelectorAll(".st-color-cell").length===50));
  check("plus a Standard colours row of 10",
    $$(".st-color-pop.open .st-color-group").some(g=>/Standard colours/.test(g.textContent)));
  check("swatches are tooltipped by name, not by hex code",
    [...$(".st-color-pop.open").querySelectorAll(".st-color-cell")].some(c=>/^[A-Za-z]/.test(c.title)) &&
    [...$(".st-color-pop.open").querySelectorAll(".st-color-cell")].every(c=>!/^#[0-9a-f]{6}$/.test(c.title)));
  const gold=$('.st-color-pop.open .st-color-cell[title^="Gold"]');
  selectAll(stem); click(gold);
  check("picking a theme swatch colours the selected text", /color:\s*#f/.test(stem.innerHTML), stem.innerHTML);
  check("the toolbar swatch mirrors the colour you just used",
    $(".st-toolbar[data-for=f-stem-rich] .st-tb-color:not(.hl) .st-color-swatch").style.background===rgb(gold.getAttribute("data-color")),
    $(".st-toolbar[data-for=f-stem-rich] .st-tb-color:not(.hl) .st-color-swatch").style.background);
  check("the palette closes once a colour is picked", !$(".st-color-pop.open"));
  openPalette("foreColor");
  check("recently used colours come back next time",
    $$(".st-color-pop.open .st-color-group").some(g=>/Recently used/.test(g.textContent)));
  openPalette("foreColor");

  // ---------------- the highlight palette ---------------------------------------------
  click($("[data-color-trigger=hiliteColor]"));
  const hp=$(".st-color-pop.open");
  check("clicking the highlighter opens the highlight palette", hp &&
    hp.getAttribute("data-palette-kind")==="hiliteColor");
  check("its first entry is No colour, not Automatic", /No colour/.test($(".st-color-none-label").textContent));
  check("it is grouped as Highlight colours",
    $$(".st-color-pop.open .st-color-group").some(g=>/Highlight colours/.test(g.textContent)));
  const cells=[...hp.querySelectorAll(".st-color-cell")];
  check("same 10 x 5 standard layout", cells.length===50, String(cells.length));
  const lum=h=>{const m=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(h);
    return (0.2126*parseInt(m[1],16)+0.7152*parseInt(m[2],16)+0.0722*parseInt(m[3],16))/255;};
  check("every highlight swatch is a soft tint, so black text on it stays readable",
    cells.every(c=>lum(c.getAttribute("data-color"))>0.55),
    cells.map(c=>c.getAttribute("data-color")).filter(c=>lum(c)<=0.55).join(","));
  selectAll(stem); click(cells[0]);
  check("picking a highlight swatch sets the background", /background-color:\s*#/.test(stem.innerHTML), stem.innerHTML);

  // ---------------- Automatic / No colour keep the rest of the formatting -------------
  stem.innerHTML='<b style="font-size:18px"><span style="color: #ff9900">Very important</span></b>';
  selectAll(stem);
  openPalette("foreColor");
  click(P(".st-color-none"));
  check("Automatic takes the colour off the selection", !/color:\s*#/i.test(stem.innerHTML), stem.innerHTML);
  check("Automatic keeps bold and the font size", /<b[^>]*font-size:18px/.test(stem.innerHTML), stem.innerHTML);
  check("Automatic leaves no empty span behind", !/style=""/.test(stem.innerHTML), stem.innerHTML);
  check("Automatic keeps the words themselves", stem.textContent.includes("Very important"), stem.innerHTML);
  stem.innerHTML='<b>plain</b> <span style="background-color: #fff2cc">marked</span>';
  selectAll(stem);
  click($("[data-color-trigger=hiliteColor]"));
  click(P(".st-color-none"));
  check("No colour removes the highlight", !/background-color:\s*#/i.test(stem.innerHTML), stem.innerHTML);
  check("No colour keeps the bold beside it", /<b>plain<\/b>/.test(stem.innerHTML), stem.innerHTML);

  // ---------------- custom colour: hex / R-G-B / picker -------------------------------
  openPalette("foreColor");
  const custom=P(".st-color-custom");
  check("the custom area starts collapsed", custom.hasAttribute("hidden"));
  click(P("[data-color-more]"));
  check("Custom colour ... opens hex, R/G/B and the browser picker", !custom.hasAttribute("hidden") &&
    !!P(".st-color-hex") && !!P(".st-color-picker") && !!P(".st-color-r") && !!P(".st-color-g") && !!P(".st-color-b"));
  type(P(".st-color-picker"),"#1a2b3c");
  check("the hex box follows the picker", P(".st-color-hex").value==="#1a2b3c", P(".st-color-hex").value);
  check("R / G / B follow the picker",
    [P(".st-color-r").value,P(".st-color-g").value,P(".st-color-b").value].join(",")==="26,43,60",
    [P(".st-color-r").value,P(".st-color-g").value,P(".st-color-b").value].join(","));
  check("the preview shows the colour you are about to apply",
    /1a2b3c|26, 43, 60/i.test(P(".st-color-preview-a").style.color), P(".st-color-preview-a").style.color);
  type(P(".st-color-hex"),"#ff9900");
  check("the picker follows a typed hex code", P(".st-color-picker").value==="#ff9900", P(".st-color-picker").value);
  type(P(".st-color-b"),"7");
  check("editing R / G / B writes the hex code back",
    P(".st-color-hex").value==="#ff9907", P(".st-color-hex").value);
  selectAll(stem); click(P("[data-color-apply]"));
  check("Apply puts the custom colour on the text", stem.innerHTML.toLowerCase().includes("#ff9907"), stem.innerHTML);
  check("the palette stays open after a custom apply, so you can fine-tune", !!$(".st-color-pop.open"));
  type(P(".st-color-picker"),"#ffffff");
  check("a very light text colour earns a legibility warning",
    !P(".st-color-warn").hasAttribute("hidden") && /light text/.test(P(".st-color-warn").textContent),
    P(".st-color-warn").textContent);
  type(P(".st-color-picker"),"#123456");
  check("a readable colour clears the warning again", P(".st-color-warn").hasAttribute("hidden"));
  click($("[data-color-trigger=hiliteColor]"));
  click(P("[data-color-more]"));
  type(P(".st-color-picker"),"#000033");
  check("a very dark highlight earns a warning instead",
    !P(".st-color-warn").hasAttribute("hidden") && /dark highlight/.test(P(".st-color-warn").textContent),
    P(".st-color-warn").textContent);

  // ---------------- opening / closing --------------------------------------------------
  doc.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
  check("Escape closes the palette", !$(".st-color-pop.open"));
  click($("[data-color-trigger=foreColor]"));
  check("the trigger is marked expanded while open", $("[data-color-trigger=foreColor]").getAttribute("aria-expanded")==="true");
  click(doc.body);
  check("clicking outside closes the palette", !$(".st-color-pop.open"));
  check("and resets aria-expanded", $("[data-color-trigger=foreColor]").getAttribute("aria-expanded")==="false");
  click($("[data-color-trigger=foreColor]"));
  click($("[data-color-trigger=hiliteColor]"));
  check("only one palette is open at a time", $$(".st-color-pop.open").length===1);
  check("the second one to open is the highlight", $(".st-color-pop.open").getAttribute("data-palette-kind")==="hiliteColor");


  // ---- the palette must not lose the selection it is colouring ------------------------
  // Clicking a palette control (or typing a hex code) moves focus out of the editable, which
  // throws the selection away - so every colour after the first would land on nothing.
  set("Alpha bravo charlie delta echo");
  pick("charlie delta");
  openPalette("foreColor");
  check("opening the palette kept the selection", inHost());
  loseSelection();                                    // worst case: assume focus already moved
  const hexSel=pickSwatch("Blue, lighter 80%");
  check("the colour lands on the words that were selected",
    new RegExp('<span style="color: '+hexSel+'">charlie delta</span>').test(stem.innerHTML), stem.innerHTML);
  check("and the words around them are untouched", stem.textContent==="Alpha bravo charlie delta echo", stem.innerHTML);

  set("Alpha bravo charlie");
  pick("bravo");
  openPalette("foreColor");
  click(P("[data-color-more]"));
  P(".st-color-hex").focus();
  loseSelection();
  check("typing a hex code really does take the selection away", !inHost());
  P(".st-color-hex").value="#ff9900";
  P(".st-color-hex").dispatchEvent(new w.Event("input",{bubbles:true}));
  click(P("[data-color-apply]"));
  check("a custom hex colour still lands on the right words",
    /<span style="color: #ff9900">bravo<\/span>/.test(stem.innerHTML), stem.innerHTML);

  // ---- several colours on one line, each on its own words -----------------------------
  set("One two three four five six");
  pick("two three");
  openPalette("foreColor");
  const hexA=pickSwatch("Red");
  check("the first colour is on its own words",
    new RegExp('<span style="color: '+hexA+'">two three</span>').test(stem.innerHTML), stem.innerHTML);
  pick("five six");
  openPalette("foreColor");
  const hexB=pickSwatch("Gold");
  check("a second colour applies to its own selection",
    new RegExp('<span style="color: '+hexB+'">five six</span>').test(stem.innerHTML), stem.innerHTML);
  check("both colours are on the line at once", stem.innerHTML.includes(hexA)&&stem.innerHTML.includes(hexB), stem.innerHTML);
  check("no words were lost or duplicated", stem.textContent==="One two three four five six", stem.innerHTML);

  // ---- changing a highlight replaces it instead of stacking another span --------------
  set("marked text here");
  pick("marked text");
  openPalette("hiliteColor");
  const hlCells=[...doc.querySelectorAll(".st-color-pop.open .st-color-cell")];
  click(hlCells[0]);
  const hl1=hlCells[0].getAttribute("data-color");
  check("the first highlight is on", new RegExp("background-color: "+hl1).test(stem.innerHTML), stem.innerHTML);
  pick("marked text");
  openPalette("hiliteColor");
  const cells2=[...doc.querySelectorAll(".st-color-pop.open .st-color-cell")];
  click(cells2[cells2.length-1]);
  const hl2=cells2[cells2.length-1].getAttribute("data-color");
  check("picking another highlight replaces it rather than nesting",
    stem.innerHTML.includes(hl2)&&!stem.innerHTML.includes(hl1), stem.innerHTML);

  // ---- nothing selected: say so, change nothing ---------------------------------------
  set("plain words");
  loseSelection();
  openPalette("foreColor");
  pickSwatch("Red");
  check("with nothing selected the text is left alone", !/color:\s*#/.test(stem.innerHTML), stem.innerHTML);
  check("and the author is told to select text first", /select the text/i.test(toastText()), toastText());

  // ---- a caret (no selection) still means "format what I type next" -------------------
  set("type here");
  const caretNode=doc.createTreeWalker(stem,4).nextNode();
  const cr=doc.createRange(); cr.setStart(caretNode,4); cr.collapse(true);
  const cs=w.getSelection(); cs.removeAllRanges(); cs.addRange(cr);
  openPalette("foreColor");
  pickSwatch("Gold");
  check("a caret with no selection still colours what you type next", /color:\s*#/.test(stem.innerHTML), stem.innerHTML);
  check("and the words survive", stem.textContent.includes("type here"), stem.innerHTML);

  // ---------------- the markup this produces is what the sanitiser allows -------------
  stem.innerHTML='Which <b style="font-size:18px">therapy</b>, and <span style="color: #4472c4">why</span>? '+
                 '<span style="background-color: #fff2cc">Note this</span>';
  check("the client sanitiser keeps the colour and the highlight",
    /color: #4472c4/.test(w.BeaconQ.sanitize(stem.innerHTML)) &&
    /background-color: #fff2cc/.test(w.BeaconQ.sanitize(stem.innerHTML)) &&
    /font-size: 18px/.test(w.BeaconQ.sanitize(stem.innerHTML)), w.BeaconQ.sanitize(stem.innerHTML));

  check("no JS errors", errs.length===0, errs.join(" | "));
  console.log(fails? "\n"+fails+" CHECK(S) FAILED" : "\nall checks passed");
  process.exit(fails?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
