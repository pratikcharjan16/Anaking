/* Browser regression test for Gauge Meter pointer/keyboard input, respondent persistence,
   Studio autosave + outline counters, and responsive Studio controls.
   Requires the dev-only browser stack (playwright-core, @sparticuz/chromium), a running app,
   and DEV_LOGIN=1. Run with: node scripts/dom/gauge_meter_browser_test.cjs */
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const base = process.env.BASE || 'http://127.0.0.1:8000';

(async () => {
  const chromiumPackage = process.env.CHROMIUM_PATH ? null : require('@sparticuz/chromium');
  const binary = chromiumPackage && (chromiumPackage.default || chromiumPackage);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || await binary.executablePath(),
    args: binary ? binary.args.filter(arg => arg !== '--single-process') : [],
    headless: true
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const slug = 'gauge-browser-' + Date.now();
  let csrfHeaders = {};

  async function post(path, data) {
    const response = await page.request.post(base + path, { data, headers: csrfHeaders });
    assert.equal(response.status(), 200, path + ': ' + await response.text());
    return response.json();
  }

  try {
    const login = await page.request.post(base + '/auth/dev', {
      data: { email: 'qa@example.com', name: 'Gauge Browser QA', mode: 'register', role: 'admin' }
    });
    assert.equal(login.status(), 200, 'dev QA sign-in requires DEV_LOGIN=1');
    await page.goto(base + '/studio/');
    const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content');
    csrfHeaders = { 'X-CSRF-Token': csrf };

    const cfg = {
      language: 'en-US', gamify: false,
      sections: [{ id: 'S1', title: 'Main survey' }],
      questions: [{
        id: 'G1', section: 'S1', type: 'gauge_meter', stem: 'Rate the experience', required: true,
        min: 0, max: 120, step: 10, unit: '%', target: 90,
        min_label: 'Poor', mid_label: 'Average', max_label: 'Excellent'
      }]
    };
    await post('/api/studio/save', { slug, title: 'Gauge browser verification', cfg });

    // Respondent dial: check a smooth upper half-circle, correct colors, intermediate values,
    // keyboard operation and saved answer JSON—not just the visual needle.
    const startResponse = page.waitForResponse(response =>
      response.url().includes('/api/start') && response.request().method() === 'POST');
    await page.goto(base + '/survey/' + slug + '/test?new=1');
    await page.locator('#start-btn').waitFor();
    const session = await (await startResponse).json();
    await page.locator('#start-btn').click();

    const gauge = page.locator('.gauge-box');
    const svg = page.locator('.gauge-svg');
    await gauge.waitFor();
    await page.waitForTimeout(250); // let the question/study transition finish before measuring pointer targets
    assert.equal(await gauge.getAttribute('role'), 'slider');
    assert.equal(await gauge.getAttribute('aria-orientation'), 'horizontal');
    assert.equal(await gauge.getAttribute('aria-valuemax'), '120');
    assert.match(await gauge.getAttribute('aria-label'), /Poor.*Excellent/);
    const arc = await svg.locator('path').first().evaluate(node => {
      const box = node.getBBox();
      return { y: box.y, height: box.height };
    });
    assert.ok(arc.y < 50 && arc.height > 80, 'dial arc must rise above the pivot');
    const strokes = await svg.locator('path').evaluateAll(nodes => nodes.map(node => node.getAttribute('stroke')));
    assert.ok(strokes.includes('#ef4444'), 'poor/low side is red');
    assert.ok(strokes.includes('#10b981'), 'excellent/high side is green');

    for (const [fraction, expected] of [[0.25, '30'], [0.5, '60'], [0.75, '90']]) {
      // Re-read the rendered box each time; the survey HUD can settle vertically after input.
      const box = await svg.boundingBox();
      const angle = Math.PI * (1 - fraction);
      const x = box.x + box.width * (0.5 + 0.365 * Math.cos(angle));
      const y = box.y + box.height * (130 - 95 * Math.sin(angle)) / 155;
      await page.mouse.click(x, y);
      assert.equal(await gauge.getAttribute('aria-valuenow'), expected,
        'pointer position ' + fraction + ' must select an intermediate gauge value');
      assert.equal(await page.locator('.gauge-val').textContent(), expected);
    }

    await gauge.focus();
    await page.keyboard.press('Home');
    assert.equal(await gauge.getAttribute('aria-valuenow'), '0');
    assert.match(await gauge.getAttribute('aria-valuetext'), /Poor/);
    const lowColor = await page.locator('.gauge-zone-pill').evaluate(node => getComputedStyle(node).backgroundColor);
    await page.keyboard.press('End');
    assert.equal(await gauge.getAttribute('aria-valuenow'), '120');
    assert.match(await gauge.getAttribute('aria-valuetext'), /Excellent/);
    const highColor = await page.locator('.gauge-zone-pill').evaluate(node => getComputedStyle(node).backgroundColor);
    assert.notEqual(lowColor, highColor, 'low and high zones must have distinct color treatments');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    assert.equal(await gauge.getAttribute('aria-valuenow'), '10', 'arrow keys adjust by the configured step');

    // Check the respondent experience at phone, tablet and desktop widths before submitting.
    for (const [width, height] of [[320, 640], [390, 844], [768, 1024], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        gauge: document.querySelector('.gauge-box').getBoundingClientRect().toJSON(),
        dial: document.querySelector('.gauge-svg').getBoundingClientRect().toJSON()
      }));
      assert.ok(layout.document <= width, 'respondent page overflows at ' + width + 'px');
      assert.ok(layout.dial.left >= 0 && layout.dial.right <= width, 'gauge dial is clipped at ' + width + 'px');
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const finalBox = await svg.boundingBox();
    const finalAngle = Math.PI * (1 - 0.75);
    await page.mouse.click(
      finalBox.x + finalBox.width * (0.5 + 0.365 * Math.cos(finalAngle)),
      finalBox.y + finalBox.height * (130 - 95 * Math.sin(finalAngle)) / 155
    );
    assert.equal(await gauge.getAttribute('aria-valuenow'), '90');
    const submit = page.waitForResponse(response =>
      response.url().endsWith('/api/submit') && response.request().method() === 'POST');
    await page.locator('#app .nav .btn.primary').click();
    await submit;
    const progress = await (await page.request.get(base + '/api/progress?sid=' + encodeURIComponent(session.session_id))).json();
    assert.equal(progress.answers.G1._, '90', 'the selected intermediate gauge response must persist into answer JSON');

    // Studio: settings autosave must persist typed numbers/labels as a JSON number/string;
    // adding sections/questions must refresh both visible counts immediately.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base + '/studio/#' + slug);
    await page.locator('.st-ws').waitFor();
    assert.equal(await page.locator('.st-tab[data-tab="questions"] .st-count').textContent(), '1');
    assert.match(await page.locator('.st-outline-head .st-meta').textContent(), /1 question.*1 section/);

    const widthRange = page.locator('[name="outline-width"]');
    for (const width of [210, 400]) {
      await widthRange.evaluate((input, value) => {
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, width);
      assert.equal(await page.locator('#builder-outline-width-value').evaluate(node => node.value), width + ' px');
      const layout = await page.evaluate(() => {
        const outline = document.querySelector('.st-outline').getBoundingClientRect();
        const action = document.querySelector('.st-outline-addsec').getBoundingClientRect();
        return { width: outline.width, right: outline.right, buttonRight: action.right,
          columns: getComputedStyle(document.querySelector('.st-ws')).gridTemplateColumns };
      });
      assert.ok(Math.abs(layout.width - width) <= 2, 'outline width slider must set the outline column');
      assert.ok(layout.buttonRight <= layout.right + 1, '+ Add section must stay inside the outline');
      assert.ok(!layout.columns.includes('NaN'), 'grid columns remain valid when the width changes');
    }

    await page.locator('.st-outline-head [data-act="addsec"]').click();
    assert.match(await page.locator('.st-outline-head .st-meta').textContent(), /1 question.*2 sections/);
    await page.locator('.st-sec [data-act="qadd"]').nth(1).click();
    await page.locator('#st-modal [data-act="qadd-type"][data-type="single_select"]').click();
    assert.equal(await page.locator('.st-tab[data-tab="questions"] .st-count').textContent(), '2');
    assert.match(await page.locator('.st-outline-head .st-meta').textContent(), /2 questions.*2 sections/);

    await page.locator('.st-qi[data-qi="0"]').click();
    await page.locator('#f-gmax').fill('150');
    await page.locator('#f-gmaxl').fill('Excellent plus');
    await page.waitForFunction(() => document.querySelector('#st-savestate').textContent.includes('All changes saved'), null, { timeout: 8000 });
    const saved = await (await page.request.get(base + '/api/studio/study?slug=' + slug)).json();
    const storedGauge = saved.cfg.questions[0];
    assert.equal(storedGauge.max, 150, 'autosave stores numeric gauge limits');
    assert.equal(storedGauge.max_label, 'Excellent plus', 'autosave stores updated gauge labels');
    assert.equal(saved.cfg.questions.length, 2);
    assert.equal(saved.cfg.sections.length, 2);

    // Check responsive space ownership and the close/section controls at phone/tablet/desktop sizes.
    for (const [width, height] of [[320, 640], [390, 844], [768, 1024], [1024, 900], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(80);
      const check = await page.evaluate(() => {
        const doc = document.documentElement;
        const box = document.querySelector('.st-outline-addsec').getBoundingClientRect();
        const outline = document.querySelector('.st-outline').getBoundingClientRect();
        const scroll = Math.max(doc.scrollWidth, document.body.scrollWidth);
        return { viewport: innerWidth, scroll, button: { left: box.left, right: box.right }, outline: { left: outline.left, right: outline.right } };
      });
      assert.ok(check.scroll <= width, 'Studio builder has horizontal page overflow at ' + width + 'px');
      assert.ok(check.button.left >= check.outline.left - 1 && check.button.right <= check.outline.right + 1,
        '+ Add section falls outside its outline at ' + width + 'px');
    }

    await page.setViewportSize({ width: 320, height: 640 });
    await page.locator('.st-qi[data-qi="0"]').click();
    await page.locator('#st-editor .st-etab.prev').click();
    await page.locator('#qtest').waitFor({ state: 'visible' });
    const close = await page.locator('#qtest-close').boundingBox();
    assert.ok(close.width >= 40 && close.height >= 40, 'question test close button must be a usable touch target');
    assert.ok(close.x >= 0 && close.x + close.width <= 320, 'question test close button must stay on-screen');
    await page.locator('#qtest-close').click();
    assert.deepEqual(pageErrors, []);
    console.log('PASS Gauge Meter: upward arc / red-poor-green-excellent zones / 30-60-90 values on a 0-120 step-10 scale / keyboard / saved response JSON / Studio autosave / question + section counters / outline sizing / responsive layouts.');
  } finally {
    if (csrfHeaders['X-CSRF-Token']) {
      await page.request.post(base + '/api/studio/delete', { headers: csrfHeaders, data: { slug } }).catch(() => {});
    }
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
