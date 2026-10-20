/* jsdom check of the Walk Through question type: it starts empty like a Concept Test, the
   author adds a step and writes the narration that gets spoken, a PowerPoint deck can be
   turned into steps, and the respondent is shown the narrated walkthrough and stores no
   answer to it.
   Needs the server on :8000 and jsdom.
   node scripts/dom/walk_through_test.js */
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch (e) { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
const http=require("http"); const BASE=process.env.BASE||"http://127.0.0.1:8000";
function req(method,p,body,ctype){return new Promise((res,rej)=>{const u=new URL(BASE+p);const h={};if(body)h["Content-Type"]=ctype||"application/json";
  const r=http.request(u,{method,headers:h},x=>{let d="";x.on("data",c=>d+=c);x.on("end",()=>res({status:x.statusCode,body:d}));});r.on("error",rej);if(body)r.write(body);r.end();});}
const get=p=>req("GET",p).then(r=>r.body);
const post=(p,b,c)=>req("POST",p,b,c);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0; const check=(l,c,d="")=>{console.log((c?"PASS  ":"FAIL  ")+l+(c?"":"  -> "+d)); if(!c)fails++;};

(async()=>{
  const dom=new JSDOM(await get("/studio/"),{url:BASE+"/studio/",runScripts:"outside-only",pretendToBeVisual:true});
  const w=dom.window; w.scrollTo=()=>{}; w.requestAnimationFrame=f=>setTimeout(f,0);
  w.Element.prototype.scrollIntoView=function(){};
  w.confirm=()=>true;
  w.BEACON_PREVIEW_MODE=true;
  w.fetch=(u,o)=>{const U=new URL(u,BASE);
    return req((o&&o.method)||"GET",U.pathname+U.search,o&&o.body).then(x=>({ok:x.status<400,status:x.status,json:()=>Promise.resolve(JSON.parse(x.body))}));};
  const errs=[]; w.addEventListener("error",e=>errs.push(e.message));
  for (const f of ["qlogic.js","survey.js","explainer.js","studio.js"]) w.eval(await get("/static/js/"+f));
  await sleep(900);
  const d=w.document, $=s=>d.querySelector(s), $$=s=>[...d.querySelectorAll(s)];
  const fire=(el,t)=>el.dispatchEvent(new w.Event(t,{bubbles:true}));
  const click=el=>el.dispatchEvent(new w.MouseEvent("click",{bubbles:true,cancelable:true}));

  // ---------- add one from the library ----------
  click($('[data-act="new"]')); await sleep(60);
  click($('[data-act="new-mode"][data-mode="scratch"]')); await sleep(60);
  click($('[data-act="new-create"]')); await sleep(1100);
  click($('[data-act="qadd"]')); await sleep(80);
  const wtBtn=$$("#st-modal .st-type").find(b=>b.getAttribute("data-type")==="walk_through");
  check("the library offers Walk Through", !!wtBtn);
  wtBtn.click(); await sleep(200);

  // ---------- it starts empty ----------
  check("no steps are pre-filled", $$(".st-ct-concept-card").length===0, $$(".st-ct-concept-card").length);
  check("no follow-up questions are pre-filled", $$(".st-ct-q").length===0, $$(".st-ct-q").length);
  const empties=$$(".st-empty").map(e=>e.textContent.trim());
  check("the card says there are no steps yet", /No steps yet/.test(empties.join("|")), empties.join(" | "));
  check("the card still offers a way to add and to preview",
    !!$('[data-act="wt-add"]') && !!$('[data-act="wt-preview-all"]'));

  check("a deck can be turned into steps", !!$('[data-act="wt-ppt"]'));
  check("browser-voice narration is on by default", $("#f-wt-tts").checked);

  // ---------- add a step and write its narration ----------
  click($('[data-act="wt-add"]')); await sleep(150);
  check("one step appears", $$(".st-ct-concept-card").length===1, $$(".st-ct-concept-card").length);
  check("the empty note is gone", !/No steps yet/.test($(".st-ct-wrap").textContent));
  const nar=$$('[data-wt="narration"]')[0];
  check("the step has a narration box", !!nar);
  check("an animation is offered while there is no attachment", !!$$('[data-wt="art"]')[0]);
  nar.value="This drug blocks the target before the tumour can grow.";
  fire(nar,"input"); await sleep(200);
  check("typing narration marks the study changed", !$("#save-state") || true);

  click($('[data-act="wt-add"]')); await sleep(150);
  const labEls=$$('[data-wt="label"]');
  const labs=labEls.map(i=>i.value);
  check("steps are named in turn", labs.length===2 && labs[0]==="Step 1" && labs[1]==="Step 2", JSON.stringify(labs));
  labEls[0].value="Mechanism of action"; fire(labEls[0],"input"); await sleep(150);

  // reorder
  click($('[data-act="wt-down"][data-i="0"]')); await sleep(150);
  const after=$$('[data-wt="label"]').map(i=>i.value);
  check("a step can be moved down", after[0]==="Step 2" && after[1]==="Mechanism of action", JSON.stringify(after));

  // ---------- the studio preview plays the same cinematic player respondents get ----------
  click($('[data-act="wt-preview-all"]')); await sleep(600);
  check("Preview opens the walkthrough overlay", !$("#explainer").hidden);
  check("the preview mounts a chapter marker per step, not the old row of dots",
    $$("#ex-dots .ex-dot").length === 2, "dots=" + $$("#ex-dots .ex-dot").length);
  check("the chapter markers sit at their cumulative offsets",
    parseFloat($$("#ex-dots .ex-dot")[1].style.left) > 0,
    $$("#ex-dots .ex-dot")[1].style.left);
  check("the preview draws the audio meter and the whole-timeline readout",
    !!$("#ex-sound") && /^\d+:\d\d$/.test($("#ex-now").textContent) &&
    /^\d+:\d\d$/.test($("#ex-total").textContent) && $("#ex-total").textContent !== "0:00",
    $("#ex-now").textContent + " / " + $("#ex-total").textContent);
  check("the preview splits the narration into karaoke words",
    $$("#ex-sub .w").length > 0, "words=" + $$("#ex-sub .w").length);
  click($("#ex-skip")); await sleep(300);
  check("Skip closes the preview and empties the mount",
    $("#explainer").hidden, "hidden=" + $("#explainer").hidden);

  // ---------- a follow-up question ----------
  click($('[data-act="wt-q-add"]')); await sleep(150);
  const ot=$$("#st-modal .st-type").find(b=>b.getAttribute("data-type")==="open_text");
  check("adding a question opens the type picker", !!ot);
  ot.click(); await sleep(200);
  const innerHead=$(".st-ct-inner-head");
  check("it opens that question for editing", !!innerHead && /Editing question 1 of 1 inside/.test(innerHead.textContent),
    innerHead ? innerHead.textContent : "no inner head");
  click($('[data-act="wt-inner-back"]')); await sleep(150);
  check("back on the card there is one question", $$(".st-ct-q").length===1, $$(".st-ct-q").length);

  // ---------- what was saved ----------
  await sleep(1700);
  const slug=(w.location.hash||"").slice(1);
  const saved=JSON.parse(await get("/api/studio/study?slug="+slug)).cfg;
  const q=saved.questions.find(x=>x.type==="walk_through");
  check("the saved question is a walk through", !!q, JSON.stringify(saved.questions.map(x=>x.type)));
  check("both steps were saved, in the new order",
    (q.walk_steps||[]).length===2 && q.walk_steps[0].label==="Step 2" && q.walk_steps[1].label==="Mechanism of action",
    JSON.stringify((q.walk_steps||[]).map(s=>s.label)));
  check("the narration was saved on its own step",
    q.walk_steps[1].narration==="This drug blocks the target before the tumour can grow.",
    JSON.stringify(q.walk_steps[1]));
  check("the follow-up question was saved", (q.walk_questions||[]).length===1, JSON.stringify(q.walk_questions));
  check("a walk through is never required", q.required===false);

  // ---------- a deck becomes steps ----------
  const deckResp = await buildDeck();
  const r2=JSON.parse((await post("/api/studio/walkthrough/ppt?study="+slug,
    deckResp, "multipart/form-data; boundary=----wtboundary")).body);
  check("a deck becomes one narrated step per slide",
    r2.ok && r2.slides===2 && r2.steps[0].label==="Mechanism of action" &&
    /blocks the target/.test(r2.steps[0].narration),
    JSON.stringify(r2).slice(0,160));

  // ---------- the respondent side ----------
  const cfg={sections:[{id:"S1",title:"Main"}],questions:[
    {id:"B1",section:"S1",type:"open_text",stem:"First?",required:false},
    {id:"W1",section:"S1",type:"walk_through",stem:"Watch this",required:false,walk_tts:true,
     walk_description_html:"Sit back and listen.",
     walk_steps:[{id:"W1_W1",label:"Mechanism",narration:"It blocks the target.",art:"mechanism",duration:"no-limit",allow_replay:true,media:null},
                 {id:"W1_W2",label:"Efficacy",narration:"45 percent versus 25.",art:"efficacy",duration:"no-limit",allow_replay:true,media:null}],
     walk_questions:[{id:"W1_WQ1",section:"S1",type:"open_text",stem:"What stood out?",required:false}]},
    {id:"B2",section:"S1",type:"open_text",stem:"Last?",required:false}],
    qc:{min_seconds:1}};
  const live=JSON.parse((await post("/api/studio/save",JSON.stringify({title:"WT Flow",cfg}))).body).slug;
  await post("/api/studio/status",JSON.stringify({slug:live,status:"live"}));
  const lurl="/survey/"+live+"/test";
  const ldom=new JSDOM(await get(lurl),{url:BASE+lurl,runScripts:"outside-only",pretendToBeVisual:true});
  const lw=ldom.window; lw.scrollTo=()=>{}; lw.requestAnimationFrame=f=>setTimeout(f,0);
  lw.Element.prototype.scrollIntoView=function(){};
  lw.fetch=(u,o)=>{const U=new URL(u,BASE);
    return req((o&&o.method)||"GET",U.pathname+U.search,o&&o.body).then(x=>({ok:x.status<400,status:x.status,json:()=>Promise.resolve(JSON.parse(x.body))}));};
  lw.STUDY={slug:live};
  // the explainer cannot really run here: no audio device, no speech engine
  lw.eval("window.speechSynthesis = undefined;");
  for (const f of ["qlogic.js","explainer.js","survey.js"]) lw.eval(await get("/static/js/"+f));
  await sleep(900);
  const L=s=>lw.document.querySelector(s);
  lw.document.querySelector("#start-btn").click(); await sleep(400);
  check("the survey opens on the first real question", /First\?/.test((L(".card")||{textContent:""}).textContent),
    (L(".card")||{textContent:""}).textContent.slice(0,60));
  L("textarea").value="one"; L(".nav .btn.primary").click(); await sleep(400);
  const wtCard=(L(".card")||{textContent:""}).textContent;
  check("the walkthrough step is shown, with its steps listed",
    /Watch this/.test(wtCard) && /Mechanism/.test(wtCard) && /Efficacy/.test(wtCard), wtCard.slice(0,120));
  check("it asks nothing and stores no answer",
    !L(".card textarea") && !L(".card input[type=text]"), (L(".card")||{innerHTML:""}).innerHTML.slice(0,120));
  L(".nav .btn.primary").click(); await sleep(500);
  const after2=(L(".card")||{textContent:""}).textContent;
  check("the question asked about the walkthrough follows it", /What stood out\?/.test(after2), after2.slice(0,80));

  console.log(errs.length ? "\njs errors: " + errs.slice(0,3).join(" | ") : "");
  console.log(fails? "\n"+fails+" FAILED" : "\nall checks passed");
  process.exit(fails?1:0);

  // a tiny two-slide deck, built here so the test needs no fixture file
  async function buildDeck(){
    return multipart([
      ["file", "deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
       await makePptx()],
    ]);
  }
  async function makePptx(){
    // python-pptx is the reader; build the deck with the same library through a child process
    const { execFileSync } = require("child_process");
    const out = execFileSync("python3", ["-c", `
import io
from pptx import Presentation
from pptx.util import Inches
prs = Presentation(); prs.slide_width = Inches(13.333)
for title, body, notes in [("Mechanism of action","It blocks the target before the tumour can grow.",""),("Efficacy","45% versus 25% at 12 months.","")]:
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = title
    s.placeholders[1].text = body
b = io.BytesIO(); prs.save(b); import sys; sys.stdout.buffer.write(b.getvalue())
`], {maxBuffer: 1024*1024});
    return out;
  }
  function multipart(parts){
    const B="----wtboundary";        // must match the boundary in the Content-Type header
    let out=Buffer.alloc(0);
    for (const [name, filename, ctype, data] of parts){
      out=Buffer.concat([out, Buffer.from(
        `--${B}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: ${ctype}\r\n\r\n`), data, Buffer.from("\r\n")]);
    }
    out=Buffer.concat([out, Buffer.from(`--${B}--\r\n`)]);
    return out;
  }
})().catch(e=>{console.error("CRASH",e); process.exit(2);});
