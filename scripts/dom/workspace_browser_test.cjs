/* Optional dev-only check. See docs/workspace-release.md for tooling and safety. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright-core');
const base = process.env.BASE || 'http://127.0.0.1:8000';
(async () => {
  const binary = process.env.CHROMIUM_PATH ? null : require('@sparticuz/chromium');
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || await binary.executablePath(),args:binary ? binary.args : [],headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let slug;
  async function audit(name) {
    await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
    await page.addScriptTag({path:require.resolve('axe-core')});
    const violations=await page.evaluate(async()=> (await axe.run()).violations.map(v=>({id:v.id,impact:v.impact,targets:v.nodes.map(n=>n.target)})));
    assert.deepEqual(violations,[],name+' accessibility violations: '+JSON.stringify(violations));
    console.log('PASS accessibility:',name);
  }
  try {
    await page.goto(base+'/'); await page.locator('.project-card').first().waitFor();
    await audit('desktop projects');
    await page.locator('#project-search').fill('no-such-project-xyz');
    assert.equal(await page.locator('.project-card:not(.new)').count(),0);
    await page.locator('#project-search').fill('');
    await page.getByRole('button',{name:'New project',exact:false}).first().click();
    await page.locator('#new-form input[name=title]').fill('Workspace browser test '+Date.now());
    await page.locator('#new-form textarea[name=brief]').fill('Test project only; safe to delete.');
    await audit('new project dialog');
    await page.locator('#new-form button.primary').click();
    await page.locator('.journey').waitFor();slug=decodeURIComponent(new URL(page.url()).hash.slice(1).split('/')[0]);
    const cfg={language:'en-US',gamify:false,sections:[{id:'S',title:'Main'}],research_brief:'Evaluate a preference.',privacy_notice:'Test only.',questions:[{id:'Q1',section:'S',type:'single_select',stem:'Which do you prefer?',options:[{code:1,label:'A'},{code:2,label:'B'}]}]};
    const saved=await page.request.post(base+'/api/studio/save',{data:{slug,title:'Workspace browser test',cfg}});assert.equal(saved.status(),200);
    await page.reload();await page.locator('.journey').waitFor();
    for(const tab of ['checks','review','versions','analysis','coding','settings']) {
      await page.locator('.detail-tabs a[href$="/'+tab+'"]').click();
      await page.locator('#detail-content').waitFor();
      if(tab==='analysis')await page.locator('#analysis-results .metric-grid').waitFor();
      if(tab==='coding')await page.locator('#coding-results .notice').waitFor();
      await audit(tab);
    }
    await page.locator('#settings-form textarea[name=research_brief]').fill('Updated through the workspace.');
    await page.locator('#settings-form button.primary').click();
    await page.getByText('Draft settings saved.',{exact:true}).waitFor();
    await page.locator('.detail-tabs a[href$="/review"]').click();
    await page.locator('#comment-form textarea').fill('Reviewed in browser.');
    await page.locator('#comment-form button.primary').click();await page.locator('.review-comment').first().waitFor();
    await page.locator('[data-review=approved]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-action=publish]').disabled);
    page.once('dialog',dialog=>dialog.accept());await page.locator('[data-action=publish]').click();
    await page.getByText('Version published. New sessions use the frozen questionnaire.',{exact:true}).waitFor();
    const spec=await (await page.request.get(base+'/api/spec/'+slug)).json();assert.equal(spec.questions[0].stem,'Which do you prefer?');
    await page.locator('#open-assistant').click();await page.locator('#assistant-form button.primary').click();
    await page.waitForFunction(()=>document.getElementById('assistant-output').textContent.includes('automated guidance'));
    await audit('assistant dialog');await page.keyboard.press('Escape');
    await page.setViewportSize({width:390,height:844});await page.goto(base+'/');await page.locator('.project-card').first().waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile overflow');
    await audit('mobile projects');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('.project-card').first().evaluate(n=>getComputedStyle(n).transitionDuration),'0s');
    assert.deepEqual(errors,[],'JavaScript errors');console.log('PASS create / settings / review / publication / assistant / mobile / reduced motion');
  } finally {if(slug)await page.request.post(base+'/api/studio/delete',{data:{slug}});await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
