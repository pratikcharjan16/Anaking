/* jsdom check of the Studio Concept Test card: adding one starts it empty (no three
   ready-made executions, no five ready-made questions), the card says what is missing,
   the author adds what they need one at a time, "concepts per respondent" is left off
   so it cannot silently hide an execution, and an empty Concept Test never reaches a
   respondent.
   Needs the server on :8000 and jsdom.
   node scripts/dom/concept_test_empty_test.js */
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch (e) { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
const http=require("http"); const BASE=process.env.BASE||"http://127.0.0.1:8000";
function req(method,p,body){return new Promise((res,rej)=>{const u=new URL(BASE+p);const h={};if(body)h["Content-Type"]="application/json";
  const r=http.request(u,{method,headers:h},x=>{let d="";x.on("data",c=>d+=c);x.on("end",()=>res({status:x.statusCode,body:d}));});r.on("error",rej);if(body)r.write(body);r.end();});}
const get=p=>req("GET",p).then(r=>r.body);
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
  for (const f of ["qlogic.js","survey.js","explainer.js","studio.js"]) w.eval(await get("/static/js/"+f));
  await sleep(800);
  const d=w.document, $=s=>d.querySelector(s), $$=s=>[...d.querySelectorAll(s)];
  const click=el=>el.dispatchEvent(new w.MouseEvent("click",{bubbles:true,cancelable:true}));

  // a brand new study, then one Concept Test added from the library
  click($('[data-act="new"]')); await sleep(60);
  click($('[data-act="new-mode"][data-mode="scratch"]')); await sleep(60);
  click($('[data-act="new-create"]')); await sleep(1100);
  click($('[data-act="qadd"]')); await sleep(80);
  const ctBtn=$$("#st-modal .st-type").find(b=>b.getAttribute("data-type")==="concept_test");
  check("the library offers Concept Test", !!ctBtn);
  ctBtn.click(); await sleep(150);

  // ---- the card is empty ----
  check("no executions are pre-filled", $$(".st-ct-concept-card").length===0, $$(".st-ct-concept-card").length);
  check("no concept questions are pre-filled", $$(".st-ct-q").length===0, $$(".st-ct-q").length);
  const empties=$$(".st-empty").map(e=>e.textContent.trim());
  check("the card says there are no concepts yet", /No concepts yet/.test(empties.join("|")), empties.join(" | "));
  check("the card says there are no questions yet", /No questions yet/.test(empties.join("|")), empties.join(" | "));
  check("both still offer a way to add", !!$('[data-act="ct-add"]') && !!$('[data-act="ct-q-add"]'));
  check("concepts per respondent is left off, so it cannot hide an execution",
    !$("#f-ct-cper-on").checked && $("#f-ct-cper").disabled);

  // ---- the author adds what they need ----
  click($('[data-act="ct-add"]')); await sleep(120);
  click($('[data-act="ct-add"]')); await sleep(120);
  check("adding twice gives exactly two executions", $$(".st-ct-concept-card").length===2, $$(".st-ct-concept-card").length);
  check("the empty note is gone once a concept exists", !/No concepts yet/.test($(".st-ct-wrap").textContent));
  const labs=$$('.input[data-ct="label"], .st-ct-label-input').map(i=>i.value);
  check("each execution is labelled in turn", labs.length===2 && labs[0]==="EXECUTION A" && labs[1]==="EXECUTION B", JSON.stringify(labs));

  click($('[data-act="ct-q-add"]')); await sleep(120);
  const openText=$$("#st-modal .st-type").find(b=>b.getAttribute("data-type")==="open_text");
  check("adding a question opens the type picker", !!openText);
  openText.click(); await sleep(200);
  const innerHead=$(".st-ct-inner-head");
  check("adding a question opens that question for editing",
    !!innerHead && /Editing question 1 of 1 inside/.test(innerHead.textContent),
    innerHead ? innerHead.textContent : "no inner head");
  click($('[data-act="ct-inner-back"]')); await sleep(150);
  check("back on the card there is exactly one question", $$(".st-ct-q").length===1, $$(".st-ct-q").length);
  check("the questions empty note is gone", !/No questions yet/.test($(".st-ct-wrap").textContent));
  check("the card still counts the two executions", $$(".st-ct-concept-card").length===2, $$(".st-ct-concept-card").length);

  // ---- what actually got saved ----
  await sleep(1600);
  const slug=(w.location.hash||"").slice(1);
  const saved=JSON.parse(await get("/api/studio/study?slug="+slug)).cfg;
  const q=saved.questions.find(x=>x.type==="concept_test");
  check("the saved question is a concept test", !!q, JSON.stringify(saved.questions.map(x=>x.type)));
  check("saved with the two executions the author added", (q.concepts||[]).length===2, JSON.stringify((q.concepts||[]).map(c=>c.label)));
  check("saved with the one question the author added", (q.concept_questions||[]).length===1, JSON.stringify((q.concept_questions||[]).map(c=>c.type)));
  check("nothing else was invented", q.concept_concepts_per_enabled===false);

  // ---- an empty Concept Test never reaches a respondent ----
  const prev=w.BeaconSurveyPreview;
  const host=d.createElement("div");
  const blank={id:"CT",type:"concept_test",stem:"Concept",section:"S1",concepts:[],concept_questions:[]};
  const legacy={id:"CT2",type:"concept_test",stem:"Rate",section:"S1",concept:"A new idea",
                scale:{min:1,max:7},rows:[{code:"r1",label:"Clear"}]};
  prev.render(host, blank, {answers:{},questions:[blank],sections:[]}, "kblank");
  check("an empty concept test previews as guidance, not a blank screen",
    /Add at least one concept/.test(host.textContent), host.textContent.slice(0,80));
  prev.render(host, legacy, {answers:{},questions:[legacy],sections:[]}, "klegacy");
  check("an older single-question concept test still previews its rating rows",
    /A new idea/.test(host.textContent) && host.querySelectorAll('[role="slider"]').length===1,
    host.textContent.slice(0,80));

  // ---- and in the live survey it is left out of the flow altogether ----
  const cfg={sections:[{id:"S1",title:"Main"}],questions:[
    {id:"BQ1",section:"S1",type:"open_text",stem:"First?",required:false},
    {id:"BCT",section:"S1",type:"concept_test",stem:"Empty concept test",required:false,
     concepts:[],concept_questions:[]},
    {id:"BQ2",section:"S1",type:"open_text",stem:"Second?",required:false}],
    qc:{min_seconds:1}};
  const live=JSON.parse((await req("POST","/api/studio/save",JSON.stringify({title:"CT Flow",cfg}))).body).slug;
  await req("POST","/api/studio/status",JSON.stringify({slug:live,status:"live"}));
  const lurl="/survey/"+live+"/test";
  const ldom=new JSDOM(await get(lurl),{url:BASE+lurl,runScripts:"outside-only",pretendToBeVisual:true});
  const lw=ldom.window; lw.scrollTo=()=>{}; lw.requestAnimationFrame=f=>setTimeout(f,0);
  lw.Element.prototype.scrollIntoView=function(){};
  lw.fetch=(u,o)=>{const U=new URL(u,BASE);
    return req((o&&o.method)||"GET",U.pathname+U.search,o&&o.body).then(x=>({ok:x.status<400,status:x.status,json:()=>Promise.resolve(JSON.parse(x.body))}));};
  lw.STUDY={slug:live};
  for (const f of ["qlogic.js","explainer.js","survey.js"]) lw.eval(await get("/static/js/"+f));
  await sleep(900);
  const L=s=>lw.document.querySelector(s);
  lw.document.querySelector("#start-btn").click(); await sleep(500);
  check("the survey opens on the first real question", /First\?/.test((L(".card")||{textContent:""}).textContent),
    (L(".card")||{textContent:""}).textContent.slice(0,60));
  L("textarea").value="answer one"; lw.document.querySelector(".nav .btn.primary").click(); await sleep(600);
  const after=(L(".card")||{textContent:""}).textContent;
  check("an empty concept test is skipped, so the next question is the one after it",
    /Second\?/.test(after) && !/Add at least one concept/.test(after), after.slice(0,80));

  console.log(fails? "\n"+fails+" FAILED" : "\nall checks passed");
  process.exit(fails?1:0);
})().catch(e=>{console.error("CRASH",e); process.exit(2);});
