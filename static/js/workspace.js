/* Research workspace. All writes are explicit; model output is text, never executable HTML. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s), main = $('#main');
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const plain = v => String(v || '').replace(/<[^>]+>/g, '').trim();
  const enc = encodeURIComponent;
  let projects = [], sharedSurveys = [], teamsList = [], incomingInvites = [], changelogsList = [], changelogFileUrl = '/api/workspace/changelog.log', kartState = null, caps = {}, current = null, filter = 'all', query = '', sequence = 0, activeTab = 'overview';
  let currentAnalysisParams = '&scope=real', latestAnalysisData = null;
  const tabs = {overview:'Overview',team:'Team & Changes',checks:'Design checks',review:'Review',versions:'Versions',validation:'Data Validation',analysis:'Analyze',coding:'Verbatims',settings:'Settings'};
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
    const d = await api('/api/workspace/projects');
    projects = d.projects;
    sharedSurveys = d.shared_surveys || [];
    teamsList = d.teams || [];
    incomingInvites = d.incoming_invites || [];
    changelogsList = d.changelogs || [];
    changelogFileUrl = d.changelog_file_url || '/api/workspace/changelog.log';
    kartState = d.kart || null;
    caps = d.capabilities;
    $('#project-count').textContent = projects.length;
    $('#role-label').textContent = caps.auth ? caps.role+' access' : 'Local preview · access open';
    $('#deployment-mode').textContent = caps.auth ? 'Staff access protected' : 'Preview · no sign-in';
    $('#assistant-study').innerHTML = projects.map(p => '<option value="'+esc(p.slug)+'">'+esc(p.title)+'</option>').join('');
    $('#model-choice').disabled = !caps.ai;
    $('#assistant-capability').textContent = caps.ai ? 'Optional model: '+caps.ai_model+'. Suggestions require human review.' : 'Automated guidance is available. No language model is configured; no external AI service is required.';
    const badge = $('#team-invite-badge');
    if (badge) {
      badge.hidden = !incomingInvites.length;
      badge.textContent = incomingInvites.length ? (incomingInvites.length + ' INVITE') : 'NEW';
    }
    const newProjTeam = $('#new-project-team');
    if (newProjTeam) {
      newProjTeam.innerHTML = '<option value="">Personal Workspace (Points debited from my Kart)</option>' +
        teamsList.map(t => '<option value="'+t.id+'">👥 Team: '+esc(t.name)+' (Points debited from '+esc(t.creator_name)+')</option>').join('');
    }
    const teamSel = $('#team-select');
    if (teamSel) {
      teamSel.innerHTML = '<option value="">+ Create a New Team</option>' +
        teamsList.map(t => '<option value="'+t.id+'">'+esc(t.name)+' ('+t.members.length+' members)</option>').join('');
    }
    const teamStudySel = $('#team-study-select');
    if (teamStudySel) {
      teamStudySel.innerHTML = '<option value="">— None / Choose later —</option>' +
        projects.map(p => '<option value="'+esc(p.slug)+'">'+esc(p.title)+' ('+esc(p.slug)+')</option>').join('');
    }
  }
  function renderShortChangelogRows(entries, maxRows=8) {
    if (!entries || !entries.length) {
      return '<p style="font-size:12.5px;color:var(--an-muted);margin:0">No project or link changes recorded yet.</p>';
    }
    return '<div class="ws-changelog-list">' + entries.slice(0, maxRows).map(c => {
      const who = c.actor_name || c.actor_email || 'Team member';
      const emailPart = (c.actor_email && c.actor_email !== who) ? ' <span style="opacity:.75">&lt;'+esc(c.actor_email)+'&gt;</span>' : '';
      const scopeTag = c.study_slug ? '<a href="'+link(c.study_slug)+'" class="ws-cl-scope">'+esc(c.study_slug)+'</a>' : (c.team_name ? '<span class="ws-cl-scope">'+esc(c.team_name)+'</span>' : '');
      return '<div class="ws-changelog-item">' +
        '<div class="ws-cl-main"><strong>'+esc(who)+'</strong>'+emailPart+' &middot; <span class="ws-cl-summary">'+esc(c.short_summary)+'</span></div>' +
        '<div class="ws-cl-meta">'+scopeTag+'<time>'+esc((c.created_at||'').replace('T',' '))+'</time></div>' +
      '</div>';
    }).join('') + '</div>';
  }
  function dashboard() {
    current = null; $('#breadcrumb').textContent = 'Projects';
    const sum = key => projects.reduce((n,p) => n+(Number(p[key])||0),0);
    const kartTile = kartState
      ? (kartState.is_admin ? metric('Kart balance', 'Unlimited', 'Master Admin rights')
         : metric('Kart balance', kartState.points_balance + ' / ' + kartState.points_limit + ' pts', kartState.points_used + ' pts used across owned projects'))
      : metric('Draft projects', projects.filter(p=>p.status==='draft').length, 'Ready for your next idea');

    const incomingBox = incomingInvites.length
      ? '<section class="panel ws-incoming-banner" style="margin-bottom:18px;border:2px solid #d97706;background:linear-gradient(135deg,#fffbeb,#fef3c7)">' +
          '<div class="panel-head"><div><span class="eyebrow" style="color:#b45309">🤝 INCOMING COLLABORATION / TEAM REQUEST</span><h2 style="margin:2px 0 0">You have '+incomingInvites.length+' collaboration invite'+(incomingInvites.length>1?'s':'')+' waiting on your workspace</h2></div></div>' +
          '<div class="ws-invite-cards">' +
          incomingInvites.map(inv => {
            const fullUrl = location.origin + inv.share_url;
            return '<div class="ws-invite-card">' +
              '<div class="ws-invite-info">' +
                '<strong>Team: '+esc(inv.team_name||'Shared Research Team')+'</strong>' +
                (inv.study_title ? ' &middot; Project: <b>'+esc(inv.study_title)+'</b>' : '') +
                '<p style="margin:4px 0;font-size:12.5px">Invited by <strong>'+esc(inv.inviter_name)+'</strong>'+(inv.inviter_email?' (<code>'+esc(inv.inviter_email)+'</code>)':'')+' &middot; <strong style="color:#15803d">0 Kart points will be debited from your account</strong> (all project points are sponsored by '+esc(inv.inviter_name)+').</p>' +
                '<div style="font-size:11.5px;color:#57534e">Collaboration Link: <a href="'+esc(inv.share_url)+'" style="font-weight:700;color:#0f766e">'+esc(fullUrl)+'</a></div>' +
              '</div>' +
              '<div class="ws-invite-actions">' +
                '<button type="button" class="primary" data-accept-invite="'+esc(inv.token)+'">✓ Click to Accept &amp; Form Team →</button>' +
                '<a class="btn sm" href="'+esc(inv.share_url)+'">Open Link ↗</a>' +
              '</div>' +
            '</div>';
          }).join('') +
          '</div></section>'
      : '';

    const teamsSection = '<section class="panel ws-teams-hub" style="margin-bottom:18px">' +
      '<div class="panel-head">' +
        '<div><span class="eyebrow green">SHARED TEAM WORKSPACE · 0 PTS DEBITED FROM TEAMMATES</span><h2>Teams &amp; Collaborative Space</h2><p style="margin:2px 0 0;font-size:12.5px;color:var(--an-muted)">Invite a teammate by their Mail ID (Google ID). Once they click the link, the team forms, you see each other with your Account Names, and build together on shared projects while points are debited only from the Team Creator.</p></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button type="button" class="primary" data-action="open-team">👥 Collaborate / Make a Team</button>' +
          '<button type="button" class="btn" data-action="open-changelog">📄 Backend Change Log (workspace_changes.log)</button>' +
        '</div>' +
      '</div>' +
      (teamsList.length ? '<div class="ws-teams-grid">' + teamsList.map(t => {
        const statusBadge = t.team_formed
          ? '<span class="pill live">✓ Team Formed · Shared Space Active</span>'
          : '<span class="pill draft">⏳ Invite Sent · Waiting for Teammate Link Click</span>';
        const membersHtml = t.members.map(m => {
          const isAccepted = m.status === 'accepted';
          const dispName = m.account_name || m.name || m.email;
          const shareUrl = m.share_url ? (location.origin + m.share_url) : '';
          return '<div class="ws-member-chip '+(isAccepted?'accepted':'pending')+'">' +
            '<div class="ws-member-main">' +
              '<span class="ws-member-avatar">'+esc((dispName||'U').slice(0,1).toUpperCase())+'</span>' +
              '<div>' +
                '<strong>'+esc(dispName)+'</strong> ' +
                (m.email ? '<small>&lt;'+esc(m.email)+'&gt;</small>' : '') +
                '<div class="ws-member-sub">' +
                  (m.role === 'creator'
                    ? '<span style="color:#0f766e;font-weight:700">Team Creator &amp; Points Sponsor</span>'
                    : (isAccepted
                        ? '<span style="color:#15803d;font-weight:700">✓ Joined Team · 0 pts debited</span>'
                        : '<span style="color:#b45309;font-weight:700">⏳ Pending click on invite link · 0 pts debited</span>')) +
                '</div>' +
              '</div>' +
            '</div>' +
            (!isAccepted && shareUrl ? '<div class="ws-member-link"><input readonly value="'+esc(shareUrl)+'" aria-label="Collaboration invite link"><button type="button" class="btn sm" data-copy-url="'+esc(shareUrl)+'">Copy Link</button></div>' : '') +
          '</div>';
        }).join('');

        const projHtml = t.projects.length
          ? t.projects.map(tp =>
              '<div class="ws-team-proj-row">' +
                '<div class="ws-tp-info">' +
                  '<a href="'+link(tp.slug)+'" style="font-weight:750;color:var(--an-ink)">'+esc(tp.title)+'</a> ' +
                  pill(tp.status) +
                  ' <small>'+tp.questions_count+' Qs &middot; '+(tp.points_debited ? (tp.points_used+' pts (Creator)') : '0 pts debited from you')+'</small>' +
                '</div>' +
                '<div class="ws-tp-actions">' +
                  '<a class="btn sm primary" href="/studio/#'+enc(tp.slug)+'">Build in Studio ↗</a>' +
                  '<a class="btn sm" href="/survey/'+enc(tp.slug)+'" target="_blank" rel="noopener">Preview Survey ↗</a>' +
                  '<a class="btn sm" href="/survey/'+enc(tp.slug)+'/test" target="_blank" rel="noopener">Test Link ↗</a>' +
                  '<button type="button" class="btn sm" data-copy-respondent-link="'+esc(tp.slug)+'">Copy Single-use Link</button>' +
                '</div>' +
              '</div>'
            ).join('')
          : '<p style="font-size:12px;color:var(--an-muted);margin:6px 0">No shared projects in this team yet — create or attach one below.</p>';

        return '<article class="ws-team-card">' +
          '<div class="ws-team-head">' +
            '<div><h3>👥 '+esc(t.name)+'</h3><small>Points Sponsor: <strong>'+esc(t.creator_name)+'</strong> ('+esc(t.creator_email)+') &middot; Only creator points are debited</small></div>' +
            statusBadge +
          '</div>' +
          '<div class="ws-team-block"><span class="ws-block-label">TEAM MEMBERS &amp; ACCOUNT NAMES ('+t.members.length+')</span><div class="ws-members-list">'+membersHtml+'</div></div>' +
          '<div class="ws-team-block"><span class="ws-block-label">SHARED TEAM PROJECTS ('+t.projects.length+')</span><div class="ws-team-projs">'+projHtml+'</div></div>' +
          '<div class="ws-team-foot">' +
            '<button type="button" class="btn sm primary" data-action="new-team-project" data-team-id="'+t.id+'">+ Create Shared Project</button>' +
            '<button type="button" class="btn sm" data-action="open-team" data-team-id="'+t.id+'">+ Invite Teammate by Mail ID</button>' +
            '<button type="button" class="btn sm" data-action="open-changelog" data-team-id="'+t.id+'">📄 Team Change Log</button>' +
          '</div>' +
        '</article>';
      }).join('') + '</div>' : '<div class="ws-empty-team"><p style="margin:0 0 8px;font-size:13px">No active teams yet. Click <strong>Collaborate / Make a Team</strong> to invite a teammate by Mail ID (Google ID) and build projects together in a shared space!</p></div>') +
      '<div class="ws-changelog-strip">' +
        '<div class="ws-cl-strip-head"><strong>📄 Recent Shared Workspace Changes (in short · <code>data/workspace_changes.log</code>)</strong><a href="'+esc(changelogFileUrl)+'" target="_blank" rel="noopener" class="text-button">Open raw backend log file ↗</a></div>' +
        renderShortChangelogRows(changelogsList, 5) +
      '</div>' +
    '</section>';

    const sharedBox = sharedSurveys.length
      ? '<section class="panel" style="margin-bottom:18px"><h2>Shared Surveys to Fill Out (0 Kart pts debited)</h2><div class="projects-grid">' +
        sharedSurveys.map(sh => '<article class="project-card"><div class="project-card-main"><h2>'+esc(sh.study_title)+'</h2><p>Shared by '+esc(sh.shared_by_email||'SurveyKart creator')+' · <strong>0 pts debited</strong></p></div><div class="project-card-footer"><span>Respondent link</span><a href="/survey/'+enc(sh.study_slug)+'">Fill out survey →</a></div></article>').join('') +
        '</div></section>'
      : '';
    main.innerHTML = '<div class="page-heading"><div><span class="eyebrow green">SURVEYKART · INSIGHTS DELIVERED</span><h1>Good questions start here.</h1><p>Shop question types in Studio, form a team by Mail ID (Google ID), collaborate on shared projects at zero Kart cost to teammates, and preview or test every survey link.</p></div>'+
      '<div style="display:flex;gap:8px;flex-wrap:wrap">'+(editable()?'<button class="btn" data-action="open-team">👥 Collaborate / Make Team</button><button class="primary" data-action="new">+ New project</button>':'')+'</div></div>'+
      (!caps.auth ? notice('Preview workspace: staff pages are open to anyone with this link. Configure staff authentication before collecting sensitive data.','warning'):'')+
      incomingBox+
      '<div class="metric-grid">'+metric('All projects',projects.length,'Owned & shared studies')+metric('Active teams',teamsList.length,'Shared collaboration spaces')+metric('Completed responses',sum('complete'),'Includes test and real responses')+kartTile+'</div>'+
      teamsSection+
      sharedBox+
      '<div class="welcome-banner"><div><span class="eyebrow green">SURVEYKART POINT SYSTEM &amp; TEAM COLLABORATION</span><h2>100 free Kart points on registration · 0 points debited from invited team members.</h2><p>Create a team or invite a collaborator by Mail ID (Google ID), build projects together in Studio, preview or test survey links in one click, and inspect who changed what in the short backend change log.</p></div><div class="banner-mark" aria-hidden="true">🛒</div></div>'+
      '<div class="projects-toolbar"><div class="filter-tabs" aria-label="Project status">'+['all','live','draft','paused','closed'].map(x=>'<button data-filter="'+x+'" class="'+(filter===x?'on':'')+'" aria-pressed="'+(filter===x)+'">'+(x==='all'?'All projects':x[0].toUpperCase()+x.slice(1))+' <span>'+projects.filter(p=>x==='all'||p.status===x).length+'</span></button>').join('')+'</div><label class="search-box"><span aria-hidden="true">⌕</span><input id="project-search" type="search" aria-label="Search projects" placeholder="Search your projects" value="'+esc(query)+'"></label></div><div class="projects-grid" id="project-grid"></div><p class="section-kicker">Every project starts as a draft. Published versions and real responses are kept separate from your design work.</p>';
    drawCards();
  }
  function drawCards() {
    const visible = projects.filter(p => (filter==='all'||p.status===filter) && (p.title+' '+p.slug).toLowerCase().includes(query.toLowerCase()));
    $('#project-grid').innerHTML = visible.map((p,i) => {
      const complete = Number(p.complete)||0, started=Number(p.started)||0, pct = started ? Math.round(100*complete/started):0;
      const ptsTag = p.is_shared
        ? ('🤝 Shared · 0 pts debited (Sponsored by ' + (p.owner_name || p.owner_email || 'Creator') + ')')
        : ('🛒 ' + (p.points_used||0) + ' Kart pts');
      const collabs = (p.collaborators || []);
      const collabNames = collabs.map(c => (c.account_name || c.name || c.email) + (c.status === 'accepted' ? ' ✓' : ' (invited)')).join(', ');
      const teamLine = (p.team_name || collabNames)
        ? '<div class="ws-card-team-line">👥 ' + (p.team_name ? '<strong>'+esc(p.team_name)+'</strong>' : 'Team') +
          (p.owner_name ? ' &middot; Creator: <b>'+esc(p.owner_name)+'</b>' : '') +
          (collabNames ? ' &middot; With: <b>'+esc(collabNames)+'</b>' : '') + '</div>'
        : '';
      return '<article class="project-card"><div class="project-card-main"><div class="project-card-top"><span class="project-icon '+(['','lavender','sand'][i%3])+'" aria-hidden="true">'+(['◈','▥','◎'][i%3])+'</span>'+pill(p.status)+'</div><h2><a href="'+link(p.slug)+'">'+esc(p.title)+'</a></h2><p>'+esc(p.parent ? 'Translation of '+p.parent : p.study_id || p.slug)+'</p>'+teamLine+'<div class="project-meta"><span>'+p.questions+' questions</span><span>'+esc(ptsTag)+'</span><span>~'+p.minutes+' min</span></div><div class="project-progress-label"><span>Responses · all data</span><b>'+complete+' / '+started+' completed</b></div><div class="progress-line" aria-hidden="true"><i style="width:'+pct+'%"></i></div></div><div class="project-card-footer ws-card-actions"><a href="/studio/#'+enc(p.slug)+'" title="Build together in Studio">Build in Studio →</a><a href="/survey/'+enc(p.slug)+'" target="_blank" rel="noopener" title="Preview live respondent survey link">Preview Link ↗</a><a href="/survey/'+enc(p.slug)+'/test" target="_blank" rel="noopener" title="Test survey in research test mode">Test Link ↗</a><a href="'+link(p.slug,'analysis')+'" title="Open this study’s analytics and charts">📊 Analytics</a><a href="'+link(p.slug,'team')+'" title="Team members & short change log">👥 Team &amp; Log</a></div></article>';
    }).join('')+(editable()?'<article class="project-card new"><button class="new-card-button" data-action="new"><span aria-hidden="true">+</span><b>Your next discovery</b><small>Create a new research project</small></button></article>':'');
    if (!visible.length && !editable()) $('#project-grid').innerHTML = empty('No matching projects','Try a different search or ask your owner for study access.');
  }
  function header() {
    const s=current;
    const sponsorNote = s.is_shared
      ? ' · 🤝 Shared Team Project (0 pts debited from you · Sponsored by ' + (s.owner_name || s.owner_email || 'Creator') + ')'
      : (' · 🛒 ' + (s.points_used || 0) + ' Kart pts');
    return '<div class="page-heading"><div><a href="#" class="text-button">← All projects</a><h1>'+esc(s.title)+'</h1><div class="study-subtitle">'+pill(s.status)+'<span>'+esc(s.slug)+(s.parent?' · Translation child':'')+esc(sponsorNote)+'</span></div></div><div class="heading-actions"><a class="primary-link" href="/studio/#'+enc(s.slug)+'">Build in Studio ↗</a><a class="primary-link secondary-link" href="/survey/'+enc(s.slug)+'" target="_blank" rel="noopener">Preview Survey Link ↗</a><a class="primary-link secondary-link" href="/survey/'+enc(s.slug)+'/test" target="_blank" rel="noopener">Test Survey ↗</a><button type="button" class="btn" data-action="open-team" data-study-slug="'+esc(s.slug)+'">👥 Invite / Collaborate</button></div></div><nav class="detail-tabs" aria-label="Project sections">'+Object.entries(tabs).filter(([id])=>!['coding','validation'].includes(id)||dataRole()).map(([id,title])=>'<a class="'+(activeTab===id?'on':'')+'" aria-current="'+(activeTab===id?'page':'false')+'" href="'+link(s.slug,id)+'">'+title+'</a>').join('')+'</nav><div id="detail-content"></div>';
  }
  function overview() {
    const s=current, checks=s.checks;
    const collabs = s.collaborators || [];
    const logs = s.changelogs || [];
    return '<div class="metric-grid">'+metric('Questions',checks.questions,'Current design')+metric('Estimated time',checks.estimated_minutes+' min','Rule-based reading-time estimate')+metric('Team collaborators',collabs.length + 1,'Creator: '+(s.owner_name||s.owner_email||'Owner'))+metric('Published version',s.publication?'v'+s.publication.revision_id:'—','Versioned release, not autosave')+'</div>' +
    '<section class="panel" style="margin-bottom:18px"><div class="panel-head"><h2>Quick Survey Links &amp; Shared Team Space</h2><div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn sm primary" href="/studio/#'+enc(s.slug)+'">Build in Studio ↗</a><a class="btn sm" href="/survey/'+enc(s.slug)+'" target="_blank" rel="noopener">Preview Survey (/survey/'+esc(s.slug)+') ↗</a><button type="button" class="btn sm" data-copy-respondent-link="'+esc(s.slug)+'">Copy Single-use Survey Link</button><a class="btn sm" href="/survey/'+enc(s.slug)+'/test" target="_blank" rel="noopener">Test Mode (/survey/'+enc(s.slug)+'/test) ↗</a><button type="button" class="btn sm" data-copy-url="'+esc(location.origin+'/survey/'+s.slug+'/test')+'">Copy Test Link</button></div></div></section>' +
    '<div class="two-col"><section class="panel"><h2>Your research journey</h2><ol class="journey">'+[
      ['1','Design your questionnaire','Structure, wording, logic and translations','/studio/#'+enc(s.slug),'Open Studio'],
      ['2','Collaborate with your team',(collabs.length ? collabs.length+' collaborator(s) invited/active' : 'Invite teammates by Mail ID (Google ID) · 0 pts debited'),link(s.slug,'team'),'Team & Change Log'],
      ['3','Test every path',checks.errors+' blockers · '+checks.warnings+' warnings',link(s.slug,'checks'),'Review checks'],
      ['4','Understand your results','Descriptive findings with clear sample bases',link(s.slug,'analysis'),'Analyze']
    ].map(x=>'<li><span class="step-num">'+x[0]+'</span><div><strong>'+x[1]+'</strong><small>'+esc(x[2])+'</small></div><a href="'+x[3]+'">'+x[4]+' →</a></li>').join('')+'</ol></section><section class="panel"><h2>Who made what changes (Short Backend Log)</h2><p style="font-size:12px;color:var(--an-muted);margin:0 0 8px">Logged in <code>data/workspace_changes.log</code> &middot; <a href="'+esc(s.changelog_file_url||'/api/workspace/changelog.log')+'" target="_blank" rel="noopener">Open raw backend file ↗</a></p>'+renderShortChangelogRows(logs, 6)+'<div style="margin-top:10px"><a href="'+link(s.slug,'team')+'" class="text-button">View full Team Roster &amp; Change Log →</a></div></section></div>';
  }
  function teamView() {
    const s = current;
    const collabs = s.collaborators || [];
    const logs = s.changelogs || [];
    const surveyFull = location.origin + '/survey/' + s.slug;
    const testFull = location.origin + '/survey/' + s.slug + '/test';
    return '<div class="two-col">' +
      '<section class="panel">' +
        '<div class="panel-head"><h2>👥 Project Team &amp; Collaborators</h2><button type="button" class="primary" data-action="open-team" data-study-slug="'+esc(s.slug)+'">+ Invite by Mail ID (Google ID)</button></div>' +
        notice('Points Rule: Only points from the Team Creator / Collaboration Inviter (' + (s.owner_name || s.owner_email || 'Project Owner') + ') are debited (' + (s.points_used || 0) + ' pts). Invited collaborators have 0 Kart points debited.') +
        '<div class="ws-members-list" style="margin:12px 0">' +
          '<div class="ws-member-chip accepted"><div class="ws-member-main"><span class="ws-member-avatar">'+esc(((s.owner_name||s.owner_email||'O')[0]).toUpperCase())+'</span><div><strong>'+esc(s.owner_name||s.owner_email||'Project Creator')+'</strong> '+(s.owner_email?'<small>&lt;'+esc(s.owner_email)+'&gt;</small>':'')+'<div class="ws-member-sub"><span style="color:#0f766e;font-weight:700">Project Creator &amp; Points Sponsor ('+(s.points_used||0)+' Kart pts)</span></div></div></div></div>' +
          (collabs.length ? collabs.map(c => {
            const fullShare = location.origin + c.share_url;
            const isAcc = c.status === 'accepted';
            return '<div class="ws-member-chip '+(isAcc?'accepted':'pending')+'">' +
              '<div class="ws-member-main">' +
                '<span class="ws-member-avatar">'+esc(((c.account_name||c.name||c.email||'C')[0]).toUpperCase())+'</span>' +
                '<div>' +
                  '<strong>'+esc(c.account_name || c.name || c.email)+'</strong> ' +
                  (c.email ? '<small>&lt;'+esc(c.email)+'&gt;</small>' : '') +
                  '<div class="ws-member-sub">' +
                    (isAcc
                      ? '<span style="color:#15803d;font-weight:700">✓ Active Collaborator (Account Name verified) · 0 pts debited</span>'
                      : '<span style="color:#b45309;font-weight:700">⏳ Invited — Waiting for user to click collaboration link · 0 pts debited</span>') +
                  '</div>' +
                '</div>' +
              '</div>' +
              '<div class="ws-member-link"><input readonly value="'+esc(fullShare)+'" aria-label="Collaboration link"><button type="button" class="btn sm" data-copy-url="'+esc(fullShare)+'">Copy Invite Link</button></div>' +
            '</div>';
          }).join('') : '<p style="font-size:12.5px;color:var(--an-muted)">No collaborators invited yet. Click <b>+ Invite by Mail ID (Google ID)</b> to invite a teammate!</p>') +
        '</div>' +
        '<h3 style="margin-top:18px;font-size:14px">Survey Preview &amp; Test Links</h3>' +
        '<div class="ws-team-proj-row" style="margin-bottom:8px"><div><strong>Live Respondent Survey Link</strong><div style="font-size:12px;color:var(--an-muted)"><code>'+esc(surveyFull)+'</code></div></div><div style="display:flex;gap:6px"><a class="btn sm primary" href="/survey/'+enc(s.slug)+'" target="_blank" rel="noopener">Preview Survey ↗</a><button type="button" class="btn sm" data-copy-respondent-link="'+esc(s.slug)+'">Copy Single-use Link</button></div></div>' +
        '<div class="ws-team-proj-row"><div><strong>Team Test / Sandbox Link</strong><div style="font-size:12px;color:var(--an-muted)"><code>'+esc(testFull)+'</code></div></div><div style="display:flex;gap:6px"><a class="btn sm primary" href="/survey/'+enc(s.slug)+'/test" target="_blank" rel="noopener">Test Survey ↗</a><button type="button" class="btn sm" data-copy-url="'+esc(testFull)+'">Copy</button></div></div>' +
      '</section>' +
      '<section class="panel">' +
        '<div class="panel-head"><h2>📄 Who Made What Changes (in short)</h2><a class="btn sm" href="'+esc(s.changelog_file_url||('/api/workspace/changelog.log?study='+enc(s.slug)))+'" target="_blank" rel="noopener">Open Backend File (workspace_changes.log) ↗</a></div>' +
        '<p style="font-size:12.5px;color:var(--an-muted);margin:0 0 10px">Compact change log recorded automatically in <code>data/workspace_changes.log</code> whenever any team member edits questions, settings, or survey links.</p>' +
        renderShortChangelogRows(logs, 30) +
      '</section>' +
    '</div>';
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
        '<label>Data scope<select name="scope"><option value="real">Real responses</option><option value="all">All responses</option><option value="test">Test responses</option></select></label>' +
        '<label>Define data cut<select name="cut_q"><option value="">No data cut (Total)</option>'+selectOptions(qs)+'</select></label>' +
        '<label class="inline-check" style="align-self:center;margin-top:14px"><input type="checkbox" name="show_sig" checked> Statistical significance</label>' +
        '<label>Confidence level<select name="alpha"><option value="0.05">95% confidence (p &lt; 0.05)</option><option value="0.01">99% confidence (p &lt; 0.01)</option><option value="0.10">90% confidence (p &lt; 0.10)</option></select></label>' +
        '<button class="primary">Apply data cut &amp; filters</button>' +
        '<button type="button" class="btn ghost" id="btn-refresh-analysis">↻ Live refresh</button>' +
      '</form>' +
      '<p class="section-kicker">Interactive visualizations, multiple chart types (Bar, Column, Donut, Radar, Likert Stack, Scorecard), dynamic legends, data labels, and statistical significance testing. Download full or customized question decks in editable PowerPoint format.</p>' +
    '</section>' +
    '<div id="analysis-results" aria-live="polite">Loading results…</div>' +
    '<section class="panel"><h2>Cross-tabulate two questions</h2><form id="cross-form" class="toolbar"><label>Rows<select name="x" required>'+selectOptions(qs)+'</select></label><label>Columns<select name="y" required>'+selectOptions(qs)+'</select></label><button '+(qs.length?'':'disabled')+'>Build cross-tab</button></form><div id="cross-results" aria-live="polite"></div></section>';
  }

  async function loadAnalysis(params='&scope=real') {
    currentAnalysisParams = params;
    const slug = current.slug, node = $('#analysis-results');
    try {
      const d = await api(endpoint('analysis', params));
      if (!node.isConnected || current.slug !== slug) return;
      latestAnalysisData = d;
      window.__currentAnalysisData = d;
      const isCut = d.data_cut && d.data_cut.active;
      const cut = d.data_cut || {};

      let html = '';

      // Check if viewing real with 0 responses while test responses exist
      if (d.scope === 'real' && d.complete === 0 && ((d.test_n || 0) > 0 || (d.total_n || 0) > 0)) {
        html += '<div class="scope-switch-banner">' +
          '<span>Currently viewing <b>Real Responses (0 completed)</b>. This project has <b>' + (d.test_n || d.total_n) + ' test/preview responses</b> available.</span>' +
          '<button type="button" class="btn sm" id="btn-switch-scope-all">Switch to All Data →</button>' +
        '</div>';
      }

      html += '<div class="metric-grid">' +
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
          if (window.AnakingCharts && window.AnakingCharts.renderQuestionCard) {
            return window.AnakingCharts.renderQuestionCard(q, isCut, cut);
          }
          return '<section class="panel result-card" id="qcard-' + esc(q.id) + '">' +
            '<h2>' + esc(q.id + ' · ' + q.title) + '</h2>' +
            '<div class="result-meta">Answered base: ' + q.base + '</div>' +
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
      const render={overview,team:teamView,checks:checksView,review:reviewView,versions:versionsView,settings:settingsView,analysis:analysisShell,coding:codingShell,validation:()=>'<div id="validation-host"></div>'};
      if(['coding','validation'].includes(activeTab)&&!dataRole())throw new Error('Your role cannot access written responses.');
      $('#detail-content').innerHTML=render[activeTab]();
      if(activeTab==='validation')window.AnakingValidation.mount($('#validation-host'),{slug:current.slug,onChange:toast});
      if(activeTab==='analysis')await loadAnalysis();if(activeTab==='coding')await loadCoding();
    }catch(e){main.innerHTML=notice(e.message,'danger')+'<button data-action="retry">Try again</button> <a href="/studio/">Open existing Studio</a>';}
  }
  function assistant() { if(current)$('#assistant-study').value=current.slug;open('assistant-dialog'); }
  function openTeamDialog(teamId='', studySlug='') {
    const tSel = $('#team-select');
    const tNameWrap = $('#team-name-wrap');
    const stSel = $('#team-study-select');
    const resBox = $('#team-invite-result');
    if (resBox) { resBox.hidden = true; resBox.innerHTML = ''; }
    if (tSel) {
      tSel.value = teamId ? String(teamId) : '';
      if (tNameWrap) tNameWrap.style.display = tSel.value ? 'none' : '';
    }
    if (stSel) {
      stSel.value = studySlug || (current ? current.slug : '');
    }
    open('team-dialog');
  }
  async function openChangelogModal(teamId='', studySlug='') {
    const qs = studySlug ? ('?study=' + enc(studySlug)) : (teamId ? ('?team_id=' + enc(teamId)) : '');
    const rawLink = $('#changelog-raw-link');
    if (rawLink) rawLink.href = '/api/workspace/changelog.log' + qs;
    const bodyNode = $('#changelog-modal-body');
    if (bodyNode) bodyNode.innerHTML = 'Loading backend change log…';
    open('changelog-dialog');
    try {
      const d = await api('/api/workspace/changelog' + qs);
      if (bodyNode) bodyNode.innerHTML = renderShortChangelogRows(d.changelogs || [], 50);
    } catch (err) {
      if (bodyNode) bodyNode.innerHTML = notice(err.message, 'danger');
    }
  }
  const tSelEl = $('#team-select');
  if (tSelEl) {
    tSelEl.addEventListener('change', () => {
      const tNameWrap = $('#team-name-wrap');
      if (tNameWrap) tNameWrap.style.display = tSelEl.value ? 'none' : '';
    });
  }
  document.addEventListener('click',async e=>{
    const b=e.target.closest('button, a');if(!b)return;
    if(b.hasAttribute('data-close')){close(b);return;}
    if(b.dataset.filter){filter=b.dataset.filter;dashboard();return;}
    if(['open-assistant'].includes(b.id)){assistant();return;}
    if(['open-team-dialog'].includes(b.id) || b.dataset.action==='open-team'){
      openTeamDialog(b.dataset.teamId||'', b.dataset.studySlug||'');
      return;
    }
    if(b.dataset.action==='new-team-project'){
      const newProjTeam = $('#new-project-team');
      if (newProjTeam && b.dataset.teamId) newProjTeam.value = String(b.dataset.teamId);
      open('new-dialog');
      return;
    }
    if(b.dataset.action==='open-changelog'){
      await openChangelogModal(b.dataset.teamId||'', b.dataset.studySlug||'');
      return;
    }
    if(b.dataset.acceptInvite){
      const tok = b.dataset.acceptInvite;
      b.disabled = true;
      try {
        const res = await api('/api/workspace/teams/accept', {token: tok});
        toast('Team formed! Shared projects are now attached to your workspace with 0 Kart points debited.');
        await loadProjects();
        await route();
      } catch (err) {
        toast(err.message);
        b.disabled = false;
      }
      return;
    }
    if(b.dataset.copyRespondentLink){
      try {
        const response = await api('/api/studio/public-link', {slug:b.dataset.copyRespondentLink});
        const url = response.url;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url).catch(() => {});
          toast('Single-use respondent link copied. It resumes until completion, then closes.');
        } else toast('Single-use respondent link: ' + url);
      } catch (err) { toast(err.message); }
      return;
    }
    if(b.dataset.copyUrl){
      const url = b.dataset.copyUrl;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => toast('Copied link: ' + url)).catch(() => toast('Link: ' + url));
      } else {
        toast('Link: ' + url);
      }
      return;
    }
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
    if (b.id === 'btn-switch-scope-all') {
      const scopeSel = $('#analysis-form select[name="scope"]');
      if (scopeSel) scopeSel.value = 'all';
      await loadAnalysis('&scope=all');
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
    const f=e.target;if(!f.matches('#new-form,#team-form,#assistant-form,#comment-form,#settings-form,#analysis-form,#cross-form,#coding-filter,.code-form'))return;e.preventDefault();
    const fields=new FormData(f), button=f.querySelector('button:not([type="button"])'), err=f.querySelector('.form-error');if(err)err.textContent='';if(button)button.disabled=true;
    try {
      if(f.id==='new-form'){
        const title=String(fields.get('title')).trim();const slug='study-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);
        const teamId=Number(fields.get('team_id')||0);
        const d=await api('/api/studio/save',{slug,title,team_id:teamId,cfg:{title,language:'en-US',research_brief:fields.get('brief'),gamify:false,sections:[{id:'S1',title:'Main survey'}],questions:[]}});
        close(f);f.reset();await loadProjects();location.hash=link(d.slug);toast('Project created. Open Studio to add your questions.');
      } else if(f.id==='team-form'){
        const payload = {
          team_id: Number(fields.get('team_id') || 0),
          team_name: String(fields.get('team_name') || '').trim(),
          email: String(fields.get('email') || '').trim(),
          study_slug: String(fields.get('study_slug') || '').trim(),
          create_project_title: String(fields.get('create_project_title') || '').trim(),
        };
        const d = await api('/api/workspace/teams/create', payload);
        await loadProjects();
        await route();
        const resBox = $('#team-invite-result');
        if (d.share_url && resBox) {
          resBox.hidden = false;
          resBox.innerHTML = '<strong>✓ Collaboration Invite Created!</strong><p style="margin:4px 0">Your teammate (<code>' + esc(payload.email) + '</code>) will see this request on their Workspace, or you can share this direct link (asks them to login/register if needed, then forms the team with 0 pts debited from them):</p>' +
            '<div style="display:flex;gap:8px;align-items:center;margin-top:6px"><input readonly value="' + esc(d.share_url) + '" style="flex:1;padding:7px 10px;border:1px solid #cbd5e1;border-radius:7px;background:#fff"><button type="button" class="btn sm primary" data-copy-url="' + esc(d.share_url) + '">Copy Link</button></div>';
          toast('Team & collaboration invite ready! Link generated.');
        } else {
          close(f);
          f.reset();
          toast('Team updated on your shared workspace.');
        }
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
