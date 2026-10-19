/* Dev-only: creates and deletes its own study. Run against a local preview, never production. */
const assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const base=process.env.BASE||'http://127.0.0.1:8000';
(async()=>{
  const binary=process.env.CHROMIUM_PATH?null:require('@sparticuz/chromium');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||await binary.executablePath(),args:binary?binary.args:[],headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const slug='validation-browser-'+Date.now();
  async function post(path,data){const r=await page.request.post(base+path,{data});assert.equal(r.status(),200,await r.text());return r.json();}
  async function audit(name){await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));await page.addScriptTag({path:require.resolve('axe-core')});const issues=await page.evaluate(async()=>(await axe.run()).violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})));assert.deepEqual(issues,[],name);console.log('PASS accessibility:',name);}
  try{
    const cfg={language:'en-US',gamify:false,sections:[{id:'S',title:'Main'}],research_brief:'Browser verification.',privacy_notice:'Test only.',invites:{recipients:[{email:'nonstarter@example.invalid',name:'Invited user'}]},questions:[{id:'Q1',section:'S',type:'single_select',stem:'Which do you prefer?',options:[{code:1,label:'Alpha'},{code:2,label:'Beta'}]},{id:'Q2',section:'S',type:'numeric',stem:'How many?',min:0,max:10}]};
    await post('/api/studio/save',{slug,title:'Validation browser test',cfg});
    const study=await(await page.request.get(base+'/api/workspace/study?study='+slug)).json();
    await post('/api/workspace/review',{slug,state:'approved',digest:study.digest});await post('/api/workspace/publish',{slug});
    const completed=await post('/api/start',{study:slug});
    await post('/api/submit',{session_id:completed.session_id,answers:{Q1:{_:1},Q2:{_:0}},elapsed_seconds:30});
    await post('/api/start',{study:slug});
    const progress=await post('/api/start',{study:slug});await post('/api/save',{session_id:progress.session_id,answers:{Q2:{_:0}},elapsed_seconds:20});
    const test=await post('/api/start',{study:slug,is_test:true});
    const listing=await(await page.request.get(base+'/api/workspace/validation?study='+slug)).json();
    const rid=listing.rows.find(r=>r.status==='complete').respondent_id;
    await page.goto(base+'/workspace/#'+slug+'/validation');await page.locator('.validation-table tbody tr').first().waitFor();
    assert.equal(await page.locator('.validation-table tbody tr').count(),5);
    assert.equal(await page.locator('tr[data-response-id=""] button').count(),0);
    await audit('Data Validation desktop list');
    await page.locator('[data-dv-review="'+rid+'"]').click();await page.locator('#data-validation-dialog').waitFor();
    await page.getByText('Inspect saved answers (2 questions)',{exact:true}).click();
    assert.match(await page.locator('.validation-answers').innerText(),/Alpha/);
    assert.match(await page.locator('.validation-answers').innerText(),/Answer: 0/);
    const form=page.locator('#dv-decision-form');await form.locator('[name=reason]').selectOption('other');
    assert.equal(await form.locator('[name=notes]').evaluate(n=>n.required),true);
    await form.locator('[name=confirmed]').check();await form.locator('button[type=submit]').click();
    assert.equal(await form.locator('[name=notes]').evaluate(n=>n.validity.valueMissing),true);
    await form.locator('[name=notes]').fill('Manual browser review: irrelevant answer.');await audit('response review dialog');
    await form.locator('button[type=submit]').click();await page.locator('#data-validation-dialog').waitFor({state:'detached'});
    await page.locator('tr[data-response-id="'+rid+'"] .invalid').waitFor();
    await page.reload();await page.locator('tr[data-response-id="'+rid+'"] .invalid').waitFor();
    assert.equal((await(await page.request.get(base+'/admin/export.json?study='+slug)).json()).some(r=>r.id===rid),false);
    await page.locator('#dv-filters [name=validity]').selectOption('invalidated');await page.getByRole('button',{name:'Apply filters',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.validation-table tbody tr').length===1);
    await page.locator('[data-dv-review="'+rid+'"]').click();
    await page.locator('#dv-decision-form [name=action]').selectOption('restore');
    await page.locator('#dv-decision-form [name=notes]').fill('Reviewed context; response is acceptable.');await page.locator('#dv-decision-form [name=confirmed]').check();
    await page.locator('#dv-decision-form button[type=submit]').click();await page.locator('#data-validation-dialog').waitFor({state:'detached'});await page.getByRole('heading',{name:'No matching users or responses'}).waitFor();
    await page.locator('[data-dv-reset]').click();await page.locator('[data-dv-review="'+rid+'"]').waitFor();
    await page.locator('[data-dv-review="'+rid+'"]').click();await page.getByText('Decision history (2)',{exact:true}).click();
    assert.match(await page.locator('.validation-history').innerText(),/irrelevant answer/);
    assert.match(await page.locator('.validation-history').innerText(),/response is acceptable/);
    await audit('restored response history');await page.keyboard.press('Escape');
    await page.setViewportSize({width:390,height:844});await audit('Data Validation mobile');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile page overflow');
    await page.locator('[data-dv-review="'+rid+'"]').click();await audit('mobile response dialog');await page.keyboard.press('Escape');
    await page.goto(base+'/admin/?study='+slug);await page.locator('#data-validation-link').waitFor();
    await page.waitForFunction(slug=>document.querySelector('#data-validation-link').getAttribute('href').includes(slug),slug);
    await page.locator('#data-validation-link').click();await page.locator('.validation-table tbody tr').first().waitFor();
    assert.deepEqual(errors,[],'JavaScript errors');
    console.log('PASS statuses / saved answers / Other requirement / invalidate / reload / filtered exports / restore / history / admin entry / mobile');
  } finally {await page.request.post(base+'/api/studio/delete',{data:{slug}});await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
