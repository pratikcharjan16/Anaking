/* Research workspace. All writes are explicit; model output is text, never executable HTML. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s), main = $('#main');
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const plain = v => String(v || '').replace(/<[^>]+>/g, '').trim();
  const enc = encodeURIComponent;
  let projects = [], caps = {}, current = null, filter = 'all', query = '', sequence = 0, activeTab = 'overview';
  let currentAnalysisParams = '&scope=real', latestAnalysisData = null;
  const tabs = {overview:'Overview',checks:'Design checks',review:'Review',versions:'Versions',validation:'Data Validation',analysis:'Analyze',coding:'Verbatims',settings:'Settings'};
  const editable = () => ['owner','editor'].includes(caps.role);
  const owner = () => caps.role === 'owner';
  const reviewer = () => ['owner','editor','reviewer'].includes(caps.role);
  const dataRole = () => ['owner','editor','analyst'].includes(caps.role);
  async function api(path, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(path, {method:body === undefined ? 'GET':'POST', credentials:'same-origin', signal:controller.signal,
        headers:body === undefined ? {} : {'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body)});
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.error) throw new Error(result.error || 'Request failed (' + response.status + '). Please reload or sign in again.');
      return result;
    } finally { clearTimeout(timer); }
  }
  function toast(text) { const n = $('#toast'); n.textContent = text; n.hidden = false; clearTimeout(n.timer); n.timer = setTimeout(() => n.hidden = true, 6000); }
  function open(id) { const n = document.getElementById(id); if (n.showModal) n.showModal(); else n.setAttribute('open',''); }
  function close(n) { const d = n.closest('dialog'); if (d.close) d.close(); else d.removeAttribute('open'); }
  function notice(text, kind='') { return '<div class="notice '+kind+'">'+esc(text)+'</div>'; }
  function empty(title, text) { return '<div class="empty-state"><span aria-hidden="true">◎</span><h2>'+esc(title)+'</h2><p>'+esc(text)+'</p></div>'; }
  function pill(state) { return '<span class="pill '+esc(state)+'">'+esc(state.replace(/_/g,' '))+'</span>'; }
  function metric(label, value, note) { return '<div class="metric"><small>'+esc(label)+'<i aria-hidden="true">↗</i></small><b>'+esc(value == null ? '—':value)+'</b><span>'+esc(note)+'</span></div>'; }
  function link(slug, tab='overview') { return '#'+enc(slug)+'/'+tab; }
  function endpoint(name, extra='') { return '/api/workspace/'+name+'?study='+enc(current.slug)+extra; }
  function selectOptions(qs) { return qs.map(q => '<option value="'+esc(q.id)+'">'+esc(q.id+' · '+(q.stem || q.title || q.type))+'</option>').join(''); }
  async function loadProjects() {
    const d = await api('/api/workspace/projects'); projects = d.projects; caps = d.capabilities;
    $('#project-count').textContent = projects.length;
    $('#role-label').textContent = caps.auth ? caps.role+' access' : 'Local preview · access open';
    $('#deployment-mode').textContent = caps.auth ? 'Staff access protected' : 'Preview · no sign-in';
    $('#assistant-study').innerHTML = projects.map(p => '<option value="'+esc(p.slug)+'">'+esc(p.title)+'</option>').join('');
    $('#model-choice').disabled = !caps.ai;
    $('#assistant-capability').textContent = caps.ai ? 'Optional model: '+caps.ai_model+'. Suggestions require human review.' : 'Automated guidance is available. No language model is configured; no external AI service is required.';
  }
  function dashboard() {
    current = null; $('#breadcrumb').textContent = 'Projects';
    const sum = key => projects.reduce((n,p) => n+(Number(p[key])||0),0);
    main.innerHTML = '<div class="page-heading"><div><span class="eyebrow green">A CLEARER VIEW OF YOUR RESEARCH</span><h1>Good questions start here.</h1><p>Your studies, your team, your next discovery. All in one place.</p></div>'+
      (editable()?'<button class="primary" data-action="new">+ New project</button>':'')+'</div>'+
      (!caps.auth ? notice('Preview workspace: staff pages are open to anyone with this link. Configure staff authentication before collecting sensitive data.','warning'):'')+
      '<div class="metric-grid">'+metric('All projects',projects.length,'Across your accessible workspace')+metric('In the field',projects.filter(p=>p.status==='live').length,'Live studies')+metric('Completed responses',sum('complete'),'Includes test and real responses')+metric('Draft projects',projects.filter(p=>p.status==='draft').length,'Ready for your next idea')+'</div>'+
      '<div class="welcome-banner"><div><span class="eyebrow green">THOUGHTFUL BY DESIGN</span><h2>From a research question to a confident next step.</h2><p>Design your study, review it together, and follow the evidence. Automated guidance is here when you need a second look.</p></div><div class="banner-mark" aria-hidden="true">✧</div></div>'+
      '<div class="projects-toolbar"><div class="filter-tabs" aria-label="Project status">'+['all','live','draft','paused','closed'].map(x=>'<button data-filter="'+x+'" class="'+(filter===x?'on':'')+'" aria-pressed="'+(filter===x)+'">'+(x==='all'?'All projects':x[0].toUpperCase()+x.slice(1))+' <span>'+projects.filter(p=>x==='all'||p.status===x).length+'</span></button>').join('')+'</div><label class="search-box"><span aria-hidden="true">⌕</span><input id="project-search" type="search" aria-label="Search projects" placeholder="Search your projects" value="'+esc(query)+'"></label></div><div class="projects-grid" id="project-grid"></div><p class="section-kicker">Every project starts as a draft. Published versions and real responses are kept separate from your design work.</p>';
    drawCards();
  }
  function drawCards() {
    const visible = projects.filter(p => (filter==='all'||p.status===filter) && (p.title+' '+p.slug).toLowerCase().includes(query.toLowerCase()));
    $('#project-grid').innerHTML = visible.map((p,i) => {
      const complete = Number(p.complete)||0, started=Number(p.started)||0, pct = started ? Math.round(100*complete/started):0;
      return '<article class="project-card"><div class="project-card-main"><div class="project-card-top"><span class="project-icon '+(['','lavender','sand'][i%3])+'" aria-hidden="true">'+(['◈','▥','◎'][i%3])+'</span>'+pill(p.status)+'</div><h2><a href="'+link(p.slug)+'">'+esc(p.title)+'</a></h2><p>'+esc(p.parent ? 'Translation of '+p.parent : p.study_id || p.slug)+'</p><div class="project-meta"><span>'+p.questions+' questions</span><span>~'+p.minutes+' min</span><span>'+ (p.errors ? p.errors+' blocking checks' : 'No blocking checks')+'</span></div><div class="project-progress-label"><span>Responses · all data</span><b>'+complete+' / '+started+' completed</b></div><div class="progress-line" aria-hidden="true"><i style="width:'+pct+'%"></i></div></div><div class="project-card-footer"><span>'+esc(p.publication?'Published v'+p.publication:'Not version-published')+'</span><a href="'+link(p.slug)+'">Open project →</a></div></article>';
    }).join('')+(editable()?'<article class="project-card new"><button class="new-card-button" data-action="new"><span aria-hidden="true">+</span><b>Your next discovery</b><small>Create a new research project</small></button></article>':'');
    if (!visible.length && !editable()) $('#project-grid').innerHTML = empty('No matching projects','Try a different search or ask your owner for study access.');
  }
  function header() {
    const s=current;
    return '<div class="page-heading"><div><a href="#" class="text-button">← All projects</a><h1>'+esc(s.title)+'</h1><div class="study-subtitle">'+pill(s.status)+'<span>'+esc(s.slug)+(s.parent?' · Translation child':'')+'</span></div></div><div class="heading-actions"><a class="primary-link" href="/studio/#'+enc(s.slug)+'">Open in Studio ↗</a><a class="primary-link secondary-link" href="/survey/'+enc(s.slug)+'/test" target="_blank" rel="noopener">Test survey ↗</a></div></div><nav class="detail-tabs" aria-label="Project sections">'+Object.entries(tabs).filter(([id])=>!['coding','validation'].includes(id)||dataRole()).map(([id,title])=>'<a class="'+(activeTab===id?'on':'')+'" aria-current="'+(activeTab===id?'page':'false')+'" href="'+link(s.slug,id)+'">'+title+'</a>').join('')+'</nav><div id="detail-content"></div>';
  }
  function overview() {
    const s=current, checks=s.checks;
    return '<div class="metric-grid">'+metric('Questions',checks.questions,'Current design')+metric('Estimated time',checks.estimated_minutes+' min','Rule-based reading-time estimate')+metric('Blocking checks',checks.errors,'Resolve before publishing')+metric('Published version',s.publication?'v'+s.publication.revision_id:'—','Versioned release, not autosave')+'</div><div class="two-col"><section class="panel"><h2>Your research journey</h2><ol class="journey">'+[
      ['1','Design your questionnaire','Structure, wording, logic and translations','/studio/#'+enc(s.slug),'Open Studio'],
      ['2','Test every path',checks.errors+' blockers · '+checks.warnings+' warnings',link(s.slug,'checks'),'Review checks'],
      ['3','Review together','Comment, request changes, approve the current draft',link(s.slug,'review'),'Review'],
      ['4','Understand your results','Descriptive findings with clear sample bases',link(s.slug,'analysis'),'Analyze']
    ].map(x=>'<li><span class="step-num">'+x[0]+'</span><div><strong>'+x[1]+'</strong><small>'+esc(x[2])+'</small></div><a href="'+x[3]+'">'+x[4]+' →</a></li>').join('')+'</ol></section><section class="panel"><h2>Research brief</h2><p class="preserve-lines">'+esc(s.cfg.research_brief||'A clear brief makes every design decision easier. Add your objectives and intended audience in Settings.')+'</p><a href="'+link(s.slug,'settings')+'" class="text-button">Edit project settings →</a><h2 class="section-spaced">Recent activity</h2>'+(s.activity.length?s.activity.slice(0,6).map(a=>'<div class="activity-row">'+esc(a.action)+'<small>'+esc(a.actor+' · '+a.created_at)+'</small></div>').join(''):'<p>No recorded staff activity yet.</p>')+'</section></div>';
  }
  function checksView() {
    const c=current.checks;
    return notice(c.method)+'<div class="two-col"><section class="panel"><h2>Questionnaire readiness</h2>'+(c.issues.length?c.issues.map(i=>'<div class="issue '+esc(i.level)+'"><span class="issue-icon" aria-hidden="true">'+(i.level==='error'?'!':'○')+'</span><div><b>'+esc((i.question||'Study')+' · '+i.level)+'</b><p>'+esc(i.message)+'</p></div></div>').join(''):empty('No rule-based issues found','Manually test routing, devices, accessibility and wording before launch.'))+'</section><section class="panel"><h2>Logic references</h2><p>This is a reference map, not proof that every possible route is valid.</p>'+(c.edges.length?c.edges.map(e=>'<div class="logic-node"><span>'+esc(e.from)+'</span><em>→ '+esc(e.operator)+' →</em><span>'+esc(e.to)+'</span></div>').join(''):empty('No conditional references','Question order follows the current questionnaire.'))+'</section></div>';
  }
  function reviewView() {
    const s=current, r=s.review, fresh=r&&r.digest===s.digest;
    return '<section class="panel"><h2>Review this draft</h2>'+notice(r?(fresh?'Current review: '+r.state+' by '+r.actor:'The draft changed after the last review. A new approval is needed.'):'Request a review, then approve the exact draft before publishing.',fresh?'':'warning')+
      '<div class="toolbar">'+(reviewer()?'<button data-review="requested">Request review</button><button data-review="changes_requested">Request changes</button><button data-review="approved">Approve this draft</button>':'')+(owner()?'<button class="primary" data-action="publish" '+(!fresh||r.state!=='approved'||s.checks.errors?'disabled':'')+'>Publish approved version</button>':'')+'</div><p>Publishing freezes a questionnaire snapshot. Further design edits remain drafts. Older studies retain their legacy live-edit behaviour until first version publication.</p>'+(s.parent?notice('A translation child is available to respondents only while its parent is live.','warning'):'')+'</section><section class="panel"><h2>Team discussion</h2>'+(reviewer()?'<form id="comment-form"><label>Question<select name="question"><option value="">Whole study</option>'+selectOptions(s.cfg.questions||[])+'</select></label><label>Comment<textarea name="body" required maxlength="4000" rows="3" placeholder="Leave specific, actionable feedback"></textarea></label><button class="primary">Post comment</button><p class="form-error" role="alert"></p></form>':'')+(s.comments.length?s.comments.map(c=>'<div class="review-comment"><b>'+esc(c.actor)+' · '+esc(c.question||'Study')+'</b><small>'+esc(c.created_at)+'</small><p>'+esc(c.body)+'</p></div>').join(''):empty('Start a thoughtful conversation','Comments stay attached to this project.'))+'</section>';
  }
  function versionsView() {
    return notice('Restore changes the editable draft, not an existing published version. Review and publish again to release it.')+'<section class="panel"><h2>Saved revisions</h2>'+(current.revisions.length?'<div class="table-scroll"><table><thead><tr><th scope="col">Version</th><th scope="col">Saved</th><th scope="col">Author</th><th scope="col">Action</th></tr></thead><tbody>'+current.revisions.map(r=>'<tr><td><b>v'+r.id+'</b><br><span class="version-hash">'+esc(r.digest.slice(0,12))+'</span></td><td>'+esc(r.created_at)+'</td><td>'+esc(r.actor)+'</td><td><button data-revision="'+r.id+'">Compare with draft</button></td></tr>').join('')+'</tbody></table></div>':empty('No saved revisions yet','Save a change in Studio to start version history.'))+'</section>';
  }
  function settingsView() {
    const c=current.cfg;
    if(current.parent) return notice('These research settings belong to the parent study. Use Studio to edit this child’s translations.');
    return '<section class="panel"><h2>Research settings</h2><form id="settings-form"><label>Research brief<textarea name="research_brief" rows="4">'+esc(c.research_brief||'')+'</textarea></label><div class="form-grid"><label>Research contact<input name="research_contact" value="'+esc(c.research_contact||'')+'" placeholder="Research team contact details"></label><label>Completion target (monitoring only)<input name="quota_target" type="number" min="0" max="10000000" value="'+esc(c.quota_target||0)+'"></label></div><label>Privacy notice<textarea name="privacy_notice" rows="4">'+esc(c.privacy_notice||'')+'</textarea></label><label>Consent statement<textarea name="consent_statement" rows="2">'+esc(c.consent_statement||'I agree to take part in this research.')+'</textarea></label><label class="inline-check"><input name="require_consent" type="checkbox" '+(c.require_consent?'checked':'')+'> Require affirmative consent before answering</label><label class="inline-check"><input name="gamify" type="checkbox" '+(c.gamify!==false?'checked':'')+'> Enable optional gamification</label>'+notice('Research settings apply to the draft. A version-published survey changes only after review and republication.')+(editable()?'<button class="primary">Save settings</button>':'<p>Your role has read-only access.</p>')+'<p class="form-error" role="alert"></p></form></section>';
  }
  function analysisShell() {
    const qs=(current.cfg.questions||[]).filter(q=>q.type==='single_select'||q.type==='multi_select');
    return '<section class="panel">' +
      '<div class="panel-head">' +
        '<h2>Dynamic Research Dashboard</h2>' +
        '<div class="export-toolbar">' +
          '<span class="live-pill"><span class="live-dot"></span> Live survey data linked</span>' +
          (dataRole() ? '<button type="button" class="btn primary" id="btn-dl-full-ppt">Download full report (PPT) ↓</button>' +
                        '<button type="button" class="btn" id="btn-dl-custom-ppt">Customize PPT download ⚙ ↓</button>' +
                        '<a id="report-download" class="btn ghost" href="'+endpoint('export','&scope=real')+'">Download JSON ↓</a>' : '') +
        '</div>' +
      '</div>' +
      '<form id="analysis-form" class="toolbar">' +
        '<label>Data scope<select name="scope"><option value="real">Real responses</option><option value="test">Test responses</option><option value="all">All responses</option></select></label>' +
        '<label>Define data cut<select name="cut_q"><option value="">No data cut (Total)</option>'+selectOptions(qs)+'</select></label>' +
        '<label class="inline-check" style="align-self:center;margin-top:14px"><input type="checkbox" name="show_sig" checked> Statistical significance</label>' +
        '<label>Confidence level<select name="alpha"><option value="0.05">95% confidence (p &lt; 0.05)</option><option value="0.01">99% confidence (p &lt; 0.01)</option><option value="0.10">90% confidence (p &lt; 0.10)</option></select></label>' +
        '<button class="primary">Apply data cut &amp; filters</button>' +
        '<button type="button" class="btn ghost" id="btn-refresh-analysis">↻ Live refresh</button>' +
      '</form>' +
      '<p class="section-kicker">Interactive visualizations, dynamic legends, data labels, and statistical significance testing (two-proportion z-tests and Welch’s t-tests). Download full or customized question decks in editable PowerPoint format.</p>' +
    '</section>' +
    '<div id="analysis-results" aria-live="polite">Loading results…</div>' +
    '<section class="panel"><h2>Cross-tabulate two questions</h2><form id="cross-form" class="toolbar"><label>Rows<select name="x" required>'+selectOptions(qs)+'</select></label><label>Columns<select name="y" required>'+selectOptions(qs)+'</select></label><button '+(qs.length?'':'disabled')+'>Build cross-tab</button></form><div id="cross-results" aria-live="polite"></div></section>';
  }

  function renderQuestionVisual(q, isCut, cut) {
    var t = q.type;
    // 1. Single Select & Multi Select
    if ((t === 'single_select' || t === 'multi_select') && q.options && q.options.length) {
      var html = '<div class="chart-box">';
      html += '<div class="chart-title">Response Distribution (%)</div>';
      if (isCut) {
        html += '<div class="chart-legend">' +
          '<span class="legend-item"><span class="legend-swatch" style="background:#12789e"></span><b>' + esc(cut.segA_label) + '</b> (n=' + cut.segA_n + ')</span>' +
          '<span class="legend-item"><span class="legend-swatch" style="background:#f59e0b"></span><b>' + esc(cut.segB_label) + '</b> (n=' + cut.segB_n + ')</span>' +
          '<span class="legend-item"><span class="sig-star">★</span> Statistically significant difference (p &lt; ' + (cut.alpha || 0.05) + ')</span>' +
        '</div>';
        html += q.options.map(function (o) {
          var sig = o.sig_test && o.sig_test.significant;
          var sigStar = sig ? '<span class="sig-star" title="Significant difference: p=' + o.sig_test.p_value + '">★</span><span class="sig-badge">Sig (p=' + o.sig_test.p_value + ')</span>' : '';
          var pA = o.segA_pct || 0, pB = o.segB_pct || 0;
          return '<div class="chart-bar-row">' +
            '<span class="chart-bar-label" title="' + esc(o.label) + '">' + esc(o.label) + '</span>' +
            '<div class="chart-bar-track-wrap">' +
              '<div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + Math.max(0, Math.min(100, pA)) + '%"></div></div>' +
              '<div class="chart-bar-track"><div class="chart-bar-fill seg-b" style="width:' + Math.max(0, Math.min(100, pB)) + '%"></div></div>' +
            '</div>' +
            '<div class="chart-bar-val"><span><b>' + pA + '%</b> (' + (o.segA_count || 0) + ')</span> / <span style="color:#b45309"><b>' + pB + '%</b> (' + (o.segB_count || 0) + ')</span>' + sigStar + '</div>' +
          '</div>';
        }).join('');
      } else {
        html += '<div class="chart-legend"><span class="legend-item"><span class="legend-swatch" style="background:#12789e"></span>Share of total respondents (%)</span></div>';
        html += q.options.map(function (o) {
          var pct = o.pct || 0;
          return '<div class="chart-bar-row">' +
            '<span class="chart-bar-label" title="' + esc(o.label) + '">' + esc(o.label) + '</span>' +
            '<div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></div></div>' +
            '<div class="chart-bar-val"><b>' + pct + '%</b> <small style="color:#64748b">(n=' + o.count + ')</small></div>' +
          '</div>';
        }).join('');
      }
      html += '</div>';
      return html;
    }

    // 2. Rating Scale / Grids / Multi-row Gauge Meter
    if ((t === 'rating_scale' || t === 'rating_grid' || t === 'semantic_diff' || t === 'numeric_matrix' || (t === 'gauge_meter' && q.rows)) && q.rows && q.rows.length) {
      var sMin = q.scale_min != null ? q.scale_min : 1;
      var sMax = q.scale_max != null ? q.scale_max : 5;
      var sRange = (sMax - sMin) || 1;
      var html = '<div class="chart-box">';
      html += '<div class="chart-title">Mean Rating Score Comparison (Scale ' + sMin + ' - ' + sMax + ')</div>';
      if (isCut) {
        html += '<div class="chart-legend">' +
          '<span class="legend-item"><span class="legend-swatch" style="background:#12789e"></span><b>' + esc(cut.segA_label) + '</b> Mean</span>' +
          '<span class="legend-item"><span class="legend-swatch" style="background:#f59e0b"></span><b>' + esc(cut.segB_label) + '</b> Mean</span>' +
          '<span class="legend-item"><span class="sig-star">★</span> Welch’s t-test p &lt; ' + (cut.alpha || 0.05) + '</span>' +
        '</div>';
        html += q.rows.map(function (r) {
          var mA = r.segA_mean != null ? r.segA_mean : 0;
          var mB = r.segB_mean != null ? r.segB_mean : 0;
          var pctA = Math.max(0, Math.min(100, ((mA - sMin) / sRange) * 100));
          var pctB = Math.max(0, Math.min(100, ((mB - sMin) / sRange) * 100));
          var sig = r.sig_test && r.sig_test.significant;
          var sigStar = sig ? '<span class="sig-star">★</span><span class="sig-badge">Sig (p=' + r.sig_test.p_value + ')</span>' : '';
          return '<div class="chart-bar-row">' +
            '<span class="chart-bar-label" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
            '<div class="chart-bar-track-wrap">' +
              '<div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + pctA + '%"></div></div>' +
              '<div class="chart-bar-track"><div class="chart-bar-fill seg-b" style="width:' + pctB + '%"></div></div>' +
            '</div>' +
            '<div class="chart-bar-val"><span><b>' + (r.segA_mean != null ? r.segA_mean : '—') + '</b></span> / <span style="color:#b45309"><b>' + (r.segB_mean != null ? r.segB_mean : '—') + '</b></span>' + sigStar + '</div>' +
          '</div>';
        }).join('');
      } else {
        html += '<div class="chart-legend"><span class="legend-item"><span class="legend-swatch" style="background:#12789e"></span>Mean score on ' + sMin + ' to ' + sMax + ' scale</span>' +
          (q.min_label ? '<span class="legend-item">Low: <i>' + esc(q.min_label) + '</i></span>' : '') +
          (q.max_label ? '<span class="legend-item">High: <i>' + esc(q.max_label) + '</i></span>' : '') +
        '</div>';
        html += q.rows.map(function (r) {
          var m = r.mean != null ? r.mean : 0;
          var pct = Math.max(0, Math.min(100, ((m - sMin) / sRange) * 100));
          return '<div class="chart-bar-row">' +
            '<span class="chart-bar-label" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
            '<div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + pct + '%"></div></div>' +
            '<div class="chart-bar-val"><b>' + (r.mean != null ? r.mean : '—') + '</b> <small style="color:#64748b">(n=' + r.base + ')</small></div>' +
          '</div>';
        }).join('');
      }
      html += '</div>';
      return html;
    }

    // 3. Single Gauge Meter Visual
    if (t === 'gauge_meter' && !q.rows) {
      var m = q.mean != null ? q.mean : (q.min || 0);
      var gMin = q.min != null ? q.min : 0;
      var gMax = q.max != null ? q.max : 100;
      var frac = gMax === gMin ? 0.5 : Math.max(0, Math.min(1, (m - gMin) / (gMax - gMin)));
      var angle = 180 + frac * 180;
      var rot = angle - 90;
      var zones = q.zones || [];

      var html = '<div class="chart-box">';
      html += '<div class="chart-title">Gauge Meter Performance Dashboard</div>';
      html += '<div class="dashboard-gauge-card">' +
        '<svg class="dash-gauge-svg" viewBox="0 0 240 140">' +
          '<path d="M 25 120 A 95 95 0 0 1 215 120" fill="none" stroke="#e2e8f0" stroke-width="16" stroke-linecap="round"/>' +
          '<path d="M 27 120 A 95 95 0 0 1 103 36" fill="none" stroke="#ef4444" stroke-width="14" opacity="0.85"/>' +
          '<path d="M 106 34 A 95 95 0 0 1 154 39" fill="none" stroke="#f59e0b" stroke-width="14" opacity="0.85"/>' +
          '<path d="M 157 41 A 95 95 0 0 1 213 120" fill="none" stroke="#10b981" stroke-width="14" opacity="0.85"/>' +
          '<g style="transform-origin:120px 120px;transform:rotate(' + rot + 'deg);transition:transform 0.4s ease">' +
            '<polygon points="116,120 124,120 120,38" fill="#0f2b48"/>' +
            '<circle cx="120" cy="120" r="9" fill="#0f2b48"/>' +
            '<circle cx="120" cy="120" r="3" fill="#ffffff"/>' +
          '</g>' +
        '</svg>' +
        '<div class="dash-gauge-readout"><strong class="dash-gauge-val">' + (q.mean != null ? q.mean : '—') + '</strong><span class="dash-gauge-unit">' + esc(q.unit || '%') + '</span></div>' +
        (q.target != null ? '<div style="font-size:11.5px;color:#64748b;margin-top:2px">Target benchmark: <b>' + q.target + esc(q.unit || '%') + '</b></div>' : '') +
        '<div class="dash-zones-strip">' +
          zones.map(function(z) {
            return '<span class="dash-zone-tag ' + (z.cls || 'low') + '"><b>' + esc(z.label) + ':</b> ' + z.pct + '% (n=' + z.count + ')</span>';
          }).join('') +
        '</div>' +
      '</div></div>';
      return html;
    }

    // 4. NPS Visual
    if (t === 'nps') {
      return '<div class="chart-box">' +
        '<div class="chart-title">NPS Distribution</div>' +
        '<p>Mean recommendation rating: <strong>' + (q.mean != null ? q.mean : '—') + '</strong> · Median: ' + (q.median != null ? q.median : '—') + '</p>' +
      '</div>';
    }

    // 5. Heatmap Visual
    if (t === 'heatmap' && q.heatmap) {
      return heatmapView(q.heatmap);
    }

    // 6. Numeric / Slider
    if ((t === 'numeric' || t === 'slider' || t === 'delta') && q.mean !== null) {
      return '<div class="chart-box">' +
        '<div class="chart-title">Statistical Summary</div>' +
        '<div style="display:flex;gap:20px;flex-wrap:wrap;font-size:12px;margin:8px 0">' +
          '<div><b>Mean:</b> ' + q.mean + '</div>' +
          '<div><b>Median:</b> ' + (q.median != null ? q.median : '—') + '</div>' +
          (q.std_dev != null ? '<div><b>Std Dev:</b> ' + q.std_dev + '</div>' : '') +
          (q.min_val != null && q.max_val != null ? '<div><b>Range:</b> ' + q.min_val + ' to ' + q.max_val + '</div>' : '') +
        '</div>' +
      '</div>';
    }

    return '<p>Detailed response data available via PowerPoint and raw exports.</p>';
  }

  function heatmapView(h) {
    return '<p>'+esc(h.note)+'</p><div class="table-scroll" tabindex="0" role="region" aria-label="Heatmap results"><table class="results-heatmap"><thead><tr><th scope="col">Row / column</th>'+h.cols.map(c=>'<th scope="col">'+esc(c.label)+'</th>').join('')+'</tr></thead><tbody>'+h.rows.map(r=>'<tr><th scope="row">'+esc(r.label)+'</th>'+h.cols.map(c=>{
      const cell=h.cells.find(x=>x.row_code===r.code&&x.col_code===c.code), mean=cell?cell.mean:null;
      const color=mean==null?'#f5f6f4':mean<1.5?'#e8f4fa':mean<2.5?'#bfe3f2':'#7fc4e0';
      return '<td style="background:'+color+';color:#153d4c"><strong>'+(mean==null?'—':esc(mean))+'</strong><small>n = '+(cell?cell.base:0)+'</small></td>';
    }).join('')+'</tr>').join('')+'</tbody></table></div>';
  }

  async function loadAnalysis(params='&scope=real') {
    currentAnalysisParams = params;
    const slug = current.slug, node = $('#analysis-results');
    try {
      const d = await api(endpoint('analysis', params));
      if (!node.isConnected || current.slug !== slug) return;
      latestAnalysisData = d;
      const isCut = d.data_cut && d.data_cut.active;
      const cut = d.data_cut || {};

      let html = '<div class="metric-grid">' +
        metric('Started', d.started, d.scope + ' scope') +
        metric('Completed', d.complete, d.completion_pct + '% of starts') +
        metric('Median duration', d.median_minutes == null ? '—' : d.median_minutes + ' min', 'Completed respondents') +
        metric('Screened out', d.screened, 'Not included in answer bases') +
      '</div>' + notice(d.note);

      if (isCut) {
        html += '<div class="notice" style="background:#f0f9ff;border-color:#bae6fd;color:#0369a1">' +
          '<strong>Data Cut Active:</strong> Comparing <b>' + esc(cut.segA_label) + '</b> (n=' + cut.segA_n + ') vs <b>' +
          esc(cut.segB_label) + '</b> (n=' + cut.segB_n + ') with statistical significance tested at <b>' + cut.conf_pct + '% confidence</b>. Significant differences flagged with ★.' +
        '</div>';
      }

      if (d.quota_target) {
        html += notice('Completion target: ' + d.complete + ' / ' + d.quota_target + '. Monitoring only; this does not enforce a quota.');
      }

      if (d.questions && d.questions.length) {
        html += d.questions.map(function (q) {
          return '<section class="panel result-card" id="qcard-' + esc(q.id) + '">' +
            '<h2>' + esc(q.id + ' · ' + q.title) + '</h2>' +
            '<div class="result-meta">Answered base: ' + q.base + ' · Missing/not shown: ' + q.missing_or_not_shown + ' ' + (q.small_base ? '<span class="pill small-base">Small base — interpret cautiously</span>' : '') + '</div>' +
            '<div class="insight-banner"><span class="insight-badge">✦ KEY INSIGHT</span><p class="insight-text">' + esc(q.insight || ('Answered base: ' + q.base)) + '</p></div>' +
            renderQuestionVisual(q, isCut, cut) +
            '<div class="card-footer-actions">' +
              '<span>Format: <b>' + esc((q.type || '').replace('_', ' ')) + '</b></span>' +
              (dataRole() ? '<button type="button" class="btn sm ghost btn-dl-single-ppt" data-qid="' + esc(q.id) + '">Download slide (PPT) ↓</button>' : '') +
            '</div>' +
          '</section>';
        }).join('');
      } else {
        html += empty('No questions yet', 'Add questions in Studio.');
      }

      node.innerHTML = html;
      const download = $('#report-download');
      if (download) download.href = endpoint('export', params);
    } catch (e) {
      if (node.isConnected) node.innerHTML = notice(e.message, 'danger');
    }
  }
  function codingShell() { return '<section class="panel"><h2>Listen to the words behind the numbers.</h2><form id="coding-filter" class="toolbar"><label>Scope<select name="scope"><option value="real">Real responses</option><option value="test">Test responses</option></select></label><label>Suggested code keywords<input name="terms" placeholder="price, quality, access"></label><button>Find matches</button></form></section><div id="coding-results" aria-live="polite">Loading verbatims…</div>'; }
  async function loadCoding(params='&scope=real') {
    const node=$('#coding-results');try{const d=await api(endpoint('verbatims',params));if(!node.isConnected)return;
      node.innerHTML=notice(d.note)+(d.total>500?notice('Showing the first 500 of '+d.total+' answers. Use exports for a complete review.','warning'):'')+(d.items.length?d.items.map(r=>'<section class="panel"><span class="eyebrow">'+esc(r.code+' · '+r.question)+'</span><blockquote class="quote">'+esc(r.text)+'</blockquote><div class="tags">'+r.suggested.map(t=>'<span>Suggested: '+esc(t)+'</span>').join('')+'</div><form class="code-form" data-respondent="'+r.respondent+'" data-question="'+esc(r.question)+'"><label>Approved codes (comma separated)<input name="codes" value="'+esc(r.codes.join(', '))+'"></label><button>Save reviewed codes</button><p class="form-error" role="alert"></p></form></section>').join(''):empty('No written answers in this scope','Responses to open-text questions will appear here.'));
    }catch(e){if(node.isConnected)node.innerHTML=notice(e.message,'danger');}
  }
  async function route() {
    if(window.AnakingValidation) window.AnakingValidation.unmount();
    const turn=++sequence;
    try {
      if(!projects.length)await loadProjects();
      let [slug,tab]=location.hash.slice(1).split('/');slug=decodeURIComponent(slug||'');activeTab=tabs[tab]?tab:'overview';
      if(!slug){dashboard();return;}
      main.innerHTML='<div class="skeleton" aria-label="Loading project"></div>';
      const d=await api('/api/workspace/study?study='+enc(slug));if(turn!==sequence)return;
      current=d;$('#breadcrumb').textContent=d.title;main.innerHTML=header();
      const render={overview,checks:checksView,review:reviewView,versions:versionsView,settings:settingsView,analysis:analysisShell,coding:codingShell,validation:()=>'<div id="validation-host"></div>'};
      if(['coding','validation'].includes(activeTab)&&!dataRole())throw new Error('Your role cannot access written responses.');
      $('#detail-content').innerHTML=render[activeTab]();
      if(activeTab==='validation')window.AnakingValidation.mount($('#validation-host'),{slug:current.slug,onChange:toast});
      if(activeTab==='analysis')await loadAnalysis();if(activeTab==='coding')await loadCoding();
    }catch(e){main.innerHTML=notice(e.message,'danger')+'<button data-action="retry">Try again</button> <a href="/studio/">Open existing Studio</a>';}
  }
  function assistant() { if(current)$('#assistant-study').value=current.slug;open('assistant-dialog'); }
  document.addEventListener('click',async e=>{
    const b=e.target.closest('button, a');if(!b)return;
    if(b.hasAttribute('data-close')){close(b);return;}
    if(b.dataset.filter){filter=b.dataset.filter;dashboard();return;}
    if(['open-assistant'].includes(b.id)){assistant();return;}
    if(['guide-button','help-button'].includes(b.id)){open('guide-dialog');return;}
    if(b.dataset.action==='new'){open('new-dialog');return;}
    if(b.dataset.action==='retry'){await loadProjects().then(route).catch(x=>toast(x.message));return;}
    if(b.dataset.action==='publish'){
      if(!confirm('Publish the approved questionnaire? New respondents will receive this version.'))return;
      b.disabled=true;try{await api('/api/workspace/publish',{slug:current.slug});toast('Version published. New sessions use the frozen questionnaire.');await loadProjects();await route();}catch(x){toast(x.message);b.disabled=false;}return;
    }
    if(b.dataset.review){b.disabled=true;try{await api('/api/workspace/review',{slug:current.slug,state:b.dataset.review,digest:current.digest});toast('Review recorded.');await route();}catch(x){toast(x.message);b.disabled=false;}return;}
    if(b.dataset.revision){b.disabled=true;try{const r=await api(endpoint('revision','&revision='+enc(b.dataset.revision)));$('#revision-content').innerHTML=notice('Fields different from the current draft: '+(r.changed_fields.join(', ')||'none'))+'<details><summary>View saved configuration</summary><pre>'+esc(JSON.stringify(r.cfg,null,2))+'</pre></details>'+(owner()?'<button class="danger section-spaced" data-restore="'+r.revision+'">Restore this version as a draft</button>':'');open('revision-dialog');}catch(x){toast(x.message);}finally{b.disabled=false;}return;}
    if(b.dataset.restore){if(!confirm('Restore this saved draft? Your current draft is retained in history.'))return;b.disabled=true;try{await api('/api/workspace/restore',{slug:current.slug,revision:Number(b.dataset.restore)});close(b);toast('Draft restored. Published version unchanged.');await route();}catch(x){toast(x.message);b.disabled=false;}}
    if (b.id === 'btn-dl-full-ppt') {
      window.location.href = endpoint('export_ppt', currentAnalysisParams);
      return;
    }
    if (b.id === 'btn-dl-custom-ppt') {
      const qs = (current.cfg.questions || []);
      const listNode = $('#ppt-question-list');
      if (listNode) {
        listNode.innerHTML = qs.map(q => {
          return '<div class="ppt-q-item"><label><input type="checkbox" name="ppt_q" value="' + esc(q.id) + '" checked> <b>' + esc(q.id) + '</b> - ' + esc(plain(q.stem_html || q.stem || q.id).slice(0, 75)) + '</label></div>';
        }).join('') || '<p>No questions found in this study.</p>';
      }
      open('ppt-dialog');
      return;
    }
    if (b.id === 'ppt-select-all') {
      const boxes = document.querySelectorAll('#ppt-question-list input[name="ppt_q"]');
      boxes.forEach(cb => { cb.checked = true; });
      return;
    }
    if (b.id === 'ppt-deselect-all') {
      const boxes = document.querySelectorAll('#ppt-question-list input[name="ppt_q"]');
      boxes.forEach(cb => { cb.checked = false; });
      return;
    }
    if (b.id === 'ppt-start-download') {
      const checked = Array.from(document.querySelectorAll('#ppt-question-list input[name="ppt_q"]:checked')).map(cb => cb.value);
      if (!checked.length) { alert('Please select at least one question to include in the PowerPoint deck.'); return; }
      close(b);
      const qsParam = '&questions=' + enc(checked.join(','));
      window.location.href = endpoint('export_ppt', currentAnalysisParams + qsParam);
      return;
    }
    if (b.classList.contains('btn-dl-single-ppt')) {
      const qid = b.dataset.qid;
      window.location.href = endpoint('export_ppt', currentAnalysisParams + '&q=' + enc(qid));
      return;
    }
    if (b.id === 'btn-refresh-analysis') {
      await loadAnalysis(currentAnalysisParams);
      toast('Live analysis refreshed from survey database.');
      return;
    }
  });
  document.addEventListener('input',e=>{if(e.target.id==='project-search'){query=e.target.value;drawCards();}});
  $('#model-choice').addEventListener('change',e=>{$('#model-consent').hidden=!e.target.checked;});
  document.addEventListener('submit',async e=>{
    const f=e.target;if(!f.matches('#new-form,#assistant-form,#comment-form,#settings-form,#analysis-form,#cross-form,#coding-filter,.code-form'))return;e.preventDefault();
    const fields=new FormData(f), button=f.querySelector('button:not([type="button"])'), err=f.querySelector('.form-error');if(err)err.textContent='';if(button)button.disabled=true;
    try {
      if(f.id==='new-form'){
        const title=String(fields.get('title')).trim();const slug='study-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);
        const d=await api('/api/studio/save',{slug,title,cfg:{title,language:'en-US',research_brief:fields.get('brief'),gamify:false,sections:[{id:'S1',title:'Main survey'}],questions:[]}});
        close(f);f.reset();await loadProjects();location.hash=link(d.slug);toast('Project created. Open Studio to add your questions.');
      } else if(f.id==='assistant-form'){
        const node=$('#assistant-output');node.textContent='Preparing suggestions…';
        const d=await api('/api/workspace/assistant',{slug:$('#assistant-study').value,task:fields.get('task'),prompt:fields.get('prompt'),use_model:fields.has('model'),approved:fields.has('approved')});node.textContent=d.mode+'\n\n'+d.text;
      } else if(f.id==='comment-form'){
        await api('/api/workspace/comments',{slug:current.slug,question:fields.get('question'),body:fields.get('body')});toast('Comment posted.');await route();
      } else if(f.id==='settings-form'){
        await api('/api/workspace/settings',{slug:current.slug,...Object.fromEntries(fields),gamify:fields.has('gamify'),require_consent:fields.has('require_consent')});toast('Draft settings saved.');await route();
      } else if(f.id==='analysis-form') { await loadAnalysis('&'+new URLSearchParams(fields));
      } else if(f.id==='coding-filter') { await loadCoding('&'+new URLSearchParams(fields));
      } else if(f.classList.contains('code-form')) {await api('/api/workspace/coding',{slug:current.slug,respondent:Number(f.dataset.respondent),question:f.dataset.question,codes:String(fields.get('codes')).split(',').map(x=>x.trim()).filter(Boolean)});toast('Reviewed codes saved.');
      } else if(f.id==='cross-form'){
        const scope=$('#analysis-form select[name="scope"]').value;
        const d=await api(endpoint('crosstab','&scope='+enc(scope)+'&'+new URLSearchParams(fields)));
        $('#cross-results').innerHTML=notice(d.note)+'<div class="table-scroll"><table><caption>Answered bases and row percentages</caption><thead><tr><th scope="col">Row</th><th scope="col">Base</th>'+((d.rows[0]||{}).cells||[]).map(c=>'<th scope="col">'+esc(c.label)+'</th>').join('')+'</tr></thead><tbody>'+d.rows.map(r=>'<tr><th scope="row">'+esc(r.label)+'</th><td>'+r.base+'</td>'+r.cells.map(c=>'<td>'+c.count+' ('+(c.pct==null?'—':c.pct+'%')+')</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
      }
    }catch(x){if(err)err.textContent=x.message;else if(f.id==='assistant-form')$('#assistant-output').textContent='Could not prepare suggestions: '+x.message;else toast(x.message);}finally{if(button)button.disabled=false;}
  });
  window.addEventListener('hashchange',route);
  loadProjects().then(route).catch(e=>{main.innerHTML=notice(e.message,'danger')+'<button data-action="retry">Retry loading</button>';});
})();
