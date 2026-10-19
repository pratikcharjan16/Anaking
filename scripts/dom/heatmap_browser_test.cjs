/* Creates/deletes its own test study. Requires dev-only Playwright and Chromium. */
const assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const base=process.env.BASE||'http://127.0.0.1:8000';
(async()=>{
 const binary=require('@sparticuz/chromium');
 const browser=await chromium.launch({executablePath:await binary.executablePath(),args:binary.args,headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const slug='heatmap-browser-'+Date.now();
 async function post(url,data){const r=await page.request.post(base+url,{data});assert.equal(r.status(),200,await r.text());return r.json();}
 try{
  const q={id:'H',section:'S',type:'heatmap',stem:'Rate each association',required:true,
    rows:[{code:'c_row',label:'First row'},{code:'two',label:'Second row'}],cols:Array.from({length:6},(_,i)=>({code:'c'+i,label:'Column '+(i+1)}))};
  const cfg={language:'en-US',gamify:false,sections:[{id:'S',title:'Main'}],questions:[q]};
  await post('/api/studio/save',{slug,title:'Heatmap browser verification',cfg});
  await post('/api/studio/status',{slug,status:'live'});
  await page.goto(base+'/survey/'+slug+'?new=1');
  const starting=page.waitForResponse(r=>r.url().endsWith('/api/start')&&r.request().method()==='POST');
  await page.locator('#start-btn').click();const session=await(await starting).json();
  await page.locator('.hm-cell').first().waitFor();
  assert.equal(await page.locator('.hm-cell').count(),12);
  assert.equal(await page.locator('.hm-scroll').evaluate(n=>n.scrollWidth>n.clientWidth),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile page overflow');
  const initial=page.locator('.hm-cell').first();
  for(const value of [1,2,3,0]){
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/save')&&r.request().method()==='POST');
    await initial.click();assert.equal((await saved).status(),200);
    assert.equal(await initial.getAttribute('data-lvl'),String(value));
  }
  let progress=await(await page.request.get(base+'/api/progress?sid='+session.session_id)).json();
  assert.equal(progress.answers.H.c_row_c0,'','clear must replace the previously saved selection');
  await page.reload();
  if(await page.locator('#start-btn').count())await page.locator('#start-btn').click();
  await page.locator('.hm-cell').first().waitFor();
  assert.equal(await page.locator('.hm-cell').first().getAttribute('data-lvl'),'0');
  await page.locator('#app .nav .btn').filter({hasText:/Next|Submit/}).click();
  assert.match(await page.locator('#err').innerText(),/required/i);
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/save')&&r.request().method()==='POST');
  await page.locator('.hm-cell').first().focus();await page.keyboard.press('2');await saved;
  assert.match(await page.locator('.hm-cell').first().getAttribute('aria-label'),/2 — Moderate/);
  await page.locator('.hm-cell').last().scrollIntoViewIfNeeded();await page.locator('.hm-cell').last().click();
  assert.equal(await page.locator('.hm-cell').last().getAttribute('data-lvl'),'1');
  assert.equal(await page.locator('.hm-scroll').evaluate(n=>n.scrollLeft>0),true);
  const submitted=page.waitForResponse(r=>r.url().endsWith('/api/submit'));
  await page.locator('#app .nav .btn').filter({hasText:/Next|Submit/}).click();assert.equal((await submitted).status(),200);
  const report=await(await page.request.get(base+'/api/workspace/analysis?study='+slug)).json();
  assert.equal(report.questions[0].base,1);
  assert.equal(report.questions[0].heatmap.cells[0].mean,2);
  await page.goto(base+'/workspace/#'+slug+'/analysis');await page.locator('.results-heatmap').waitFor();
  assert.match(await page.locator('.results-heatmap').innerText(),/n = 1/);
  // Studio uses this same renderer, without making respondent save requests.
  await page.goto(base+'/studio/#'+slug);await page.waitForFunction(()=>!!window.BeaconSurveyPreview);
  await page.locator('[data-tab=analysis]').click();
  await page.getByRole('region',{name:'Heatmap results'}).waitFor();
  assert.match(await page.getByRole('region',{name:'Heatmap results'}).innerText(),/n = 1/);
  await page.evaluate(q=>{const host=document.createElement('div');host.id='heatmap-test-preview';host.className='survey-skin';host.style.width='300px';document.body.appendChild(host);window.BeaconSurveyPreview.render(host,q,{questions:[q],sections:[]});},q);
  await page.locator('#heatmap-test-preview .hm-cell').first().click();
  await page.locator('#heatmap-test-preview > button').click();
  assert.match(await page.locator('#heatmap-test-preview .prev-err').innerText(),/Valid/);
  assert.equal(await page.locator('#heatmap-test-preview .hm-scroll').evaluate(n=>n.scrollWidth>n.clientWidth),true);
  assert.deepEqual(errors,[]);
  console.log('PASS heatmap mobile scroll / cycle / saved clear / reload / required validation / keyboard / completion / analysis / Studio renderer');
 }finally{await page.request.post(base+'/api/studio/delete',{data:{slug}});await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
