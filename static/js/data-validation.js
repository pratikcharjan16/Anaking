/* Reversible manual validation. Survey completion status and original answers are never edited. */
(function () {
  'use strict';
  let dispose = null;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const label = {non_started:'Non-started',started:'Started',in_progress:'In progress',complete:'Completed',screened_out:'Screened out'};
  function unmount() { if (dispose) dispose(); dispose = null; }
  function mount(host, config) {
    unmount();
    const controller = new AbortController(), slug = config.slug;
    let page = 1, pages = 1, loading = 0, active = null, dialog = null, returnFocus = null, alive = true;
    const $ = s => host.querySelector(s);
    const url = name => '/api/workspace/validation'+(name || '')+'?study='+encodeURIComponent(slug);
    async function api(path, body) {
      const res = await fetch(path, {method:body === undefined?'GET':'POST',credentials:'same-origin',signal:controller.signal,
        headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
      const d = await res.json().catch(()=>({}));
      if (!res.ok || d.error) throw new Error(d.error || 'Request failed. Please reload or sign in again.');
      return d;
    }
    host.innerHTML = '<section class="panel validation-panel"><div class="panel-head"><div><h2>Data Validation</h2><p>Review participation and decide which responses belong in your research.</p></div><button type="button" data-dv-refresh>Refresh list</button></div><div class="notice">Invalidation is a manual decision, not deletion. Invalidated responses stay visible here and are excluded from analysis and standard exports. You can restore them with a recorded explanation.</div><div id="dv-summary" class="validation-summary" aria-live="polite"></div><form id="dv-filters" class="validation-filters"><label>Find a user or response<input name="q" type="search" maxlength="300" placeholder="Response ID, R001, name or email"></label><label>Survey status<select name="status"><option value="">All statuses</option>'+Object.entries(label).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('')+'</select></label><label>Validation<select name="validity"><option value="">All entries</option><option value="included">Included responses</option><option value="invalidated">Invalidated responses</option></select></label><label>Data scope<select name="scope"><option value="all">Real and test</option><option value="real">Real only</option><option value="test">Test only</option></select></label><button class="primary">Apply filters</button><button type="button" data-dv-reset>Reset</button></form><p class="form-error" id="dv-error" role="alert"></p><div id="dv-list" aria-live="polite">Loading users and responses…</div><div class="validation-pagination"><button type="button" data-dv-page="prev">← Previous</button><span id="dv-page" role="status"></span><button type="button" data-dv-page="next">Next →</button></div><div class="validation-downloads"><a id="dv-export">Export filtered validation list (CSV) ↓</a><a id="dv-all-export">Export responses including invalidated (CSV) ↓</a><a id="dv-history-export">Export responses + decision history (JSON) ↓</a></div><p id="dv-note" class="validation-note"></p></section>';
    function params() { return new URLSearchParams(new FormData($('#dv-filters'))); }
    function badge(r) {
      if(r.respondent_id===null)return '<span class="validation-badge neutral">No response yet</span>';
      if(r.validation.is_invalid)return '<span class="validation-badge invalid">Invalidated</span>';
      return '<span class="validation-badge included">Included</span>'+(r.validation.revision?' <small>Restored</small>':'');
    }
    async function load() {
      const seq=++loading, p=params();p.set('page',page);
      $('#dv-error').textContent='';$('#dv-list').setAttribute('aria-busy','true');
      try{
        const d=await api(url()+'&'+p);if(!alive||seq!==loading)return;
        pages=d.pages;page=d.page;
        $('#dv-summary').innerHTML = [['All entries',d.counts.total],...Object.keys(label).map(k=>[label[k],d.counts[k]]),['Invalidated',d.counts.invalidated]].map(([name,n])=>'<div><strong>'+n+'</strong><span>'+esc(name)+'</span></div>').join('');
        $('#dv-note').textContent=d.note+' Status counts cover the chosen data scope before search/status filters. A person with multiple sessions has one row per response.';
        $('#dv-list').innerHTML=d.rows.length?'<div class="table-scroll validation-table-scroll" role="region" aria-label="Users and response validation" tabindex="0"><table class="validation-table"><caption>'+d.total+' matching entries · '+esc(slug)+'</caption><thead><tr><th scope="col">Response ID</th><th scope="col">User</th><th scope="col">Survey status</th><th scope="col">Scope</th><th scope="col">Started / completed (UTC)</th><th scope="col">Answers / time</th><th scope="col">Validation</th><th scope="col">Reason / reviewer</th><th scope="col">Action</th></tr></thead><tbody>'+d.rows.map(r=>'<tr data-response-id="'+(r.respondent_id||'')+'"><td>'+(r.respondent_id===null?'—<small>Not assigned</small>':'<b>'+r.respondent_id+'</b><small>'+esc(r.respondent_code)+'</small>')+'</td><td>'+esc(r.name||'—')+'<small>'+esc(r.email||(r.respondent_id!==null?'Public or unlinked session':''))+'</small>'+(r.invite_status?'<small>Invite: '+esc(r.invite_status)+'</small>':'')+'</td><td>'+esc(label[r.status]||r.status)+'</td><td>'+ (r.is_test?'Test':'Real')+'</td><td>'+esc(r.started_at||'Not started')+'<small>'+esc(r.completed_at||'Not completed')+'</small></td><td>'+r.answered_questions+' answered<small>'+(r.respondent_id===null?'—':(Number(r.elapsed_seconds)/60).toFixed(1)+' min')+'</small></td><td>'+badge(r)+'</td><td>'+esc(d.reasons[r.validation.reason]||'—')+(r.validation.notes?'<small class="validation-notes">'+esc(r.validation.notes)+'</small>':'')+(r.validation.reviewer?'<small>'+esc(r.validation.reviewer)+'<br>'+esc(r.validation.updated_at)+'</small>':'')+'</td><td>'+(r.respondent_id===null?'<span class="muted">No response to invalidate</span>':'<button type="button" data-dv-review="'+r.respondent_id+'" aria-label="Review / '+(r.validation.is_invalid?'restore':'invalidate')+' response '+r.respondent_id+' '+esc(r.respondent_code)+'">Review / '+(r.validation.is_invalid?'restore':'invalidate')+'</button>')+'</td></tr>').join('')+'</tbody></table></div>':'<div class="empty-state"><h3>No matching users or responses</h3><p>Try another filter. Non-started users appear when they are on this study’s invite list.</p></div>';
        $('#dv-page').textContent='Page '+page+' of '+pages+' · '+d.total+' entries';
        $('[data-dv-page="prev"]').disabled=page<=1;$('[data-dv-page="next"]').disabled=page>=pages;
        const exportParams=params();exportParams.set('format','csv');$('#dv-export').href=url()+'&'+exportParams;
        $('#dv-all-export').href='/admin/export.csv?study='+encodeURIComponent(slug)+'&scope='+encodeURIComponent(params().get('scope'))+'&include_invalid=1';
        $('#dv-history-export').href=$('#dv-all-export').href.replace('/export.csv?','/export.json?');
      }catch(e){if(alive&&e.name!=='AbortError')$('#dv-error').textContent=e.message;}
      finally{if(alive&&seq===loading)$('#dv-list').removeAttribute('aria-busy');}
    }
    function closeDialog(){if(dialog){if(dialog.open)dialog.close();dialog.remove();dialog=null;}active=null;if(returnFocus&&returnFocus.isConnected)returnFocus.focus();returnFocus=null;}
    function values(a) {
      return Object.entries(a.values).map(([k,v])=>{
        let shown=Array.isArray(v)?v.map(x=>a.options[String(x)]?x+' — '+a.options[String(x)]:x).join(', '):
          (k==='_'&&a.options[String(v)]?v+' — '+a.options[String(v)]:typeof v==='object'?JSON.stringify(v):String(v));
        return '<div><b>'+esc(k==='_'?'Answer':k)+':</b> '+esc(shown)+'</div>';
      }).join('');
    }
    function mode() {
      if(!dialog)return;
      const f=dialog.querySelector('form'), action=f.elements.action.value, other=f.elements.reason.value==='other';
      dialog.querySelector('[data-dv-reason-label]').hidden=action==='restore';f.elements.reason.required=action!=='restore';
      f.elements.notes.required=action==='restore'||other;f.elements.notes.minLength=(action==='restore'||other)?3:0;
      dialog.querySelector('[data-dv-notes-title]').textContent=action==='restore'?'Why should this response be restored? (required)':other?'Specify the reason (required)':'Additional notes (optional)';
      dialog.querySelector('[data-dv-impact]').textContent=action==='restore'?'This response will be included in analysis and standard exports again. Prior invalidation reasons remain in history.':'This response will be excluded from analysis and standard exports. Original answers and progress are retained, even if the participant continues the survey.';
      f.querySelector('button[type=submit]').textContent=action==='restore'?'Restore response':active.validation.is_invalid?'Save invalidation':'Invalidate response';
      f.querySelector('button[type=submit]').className=action==='restore'?'primary':'danger';
      dialog.querySelector('[data-dv-confirm-text]').textContent=action==='restore'?'I have reviewed this response and confirm restoration.':'I have reviewed this response and confirm invalidation.';
      f.elements.confirmed.checked=false;
    }
    async function review(id,button) {
      button.disabled=true;
      try{
        const d=await api(url('/response')+'&respondent_id='+id);if(!alive)return;
        closeDialog();returnFocus=button;active=d;dialog=document.createElement('dialog');dialog.id='data-validation-dialog';dialog.className='validation-dialog';dialog.setAttribute('aria-labelledby','dv-dialog-title');
        dialog.innerHTML='<div class="dialog-heading"><span class="eyebrow">DATA VALIDATION · '+(d.is_test?'TEST':'REAL')+'</span><button type="button" data-dv-close aria-label="Close response review">×</button></div><h2 id="dv-dialog-title">Response '+d.respondent_id+' · '+esc(d.respondent_code)+'</h2><p>'+esc(label[d.status])+' · '+(Number(d.elapsed_seconds)/60).toFixed(1)+' minutes. '+(d.validation.is_invalid?'Currently invalidated.':'Currently included.')+'</p><details><summary>Inspect saved answers ('+d.answers.length+' questions)</summary><div class="validation-answers">'+(d.answers.length?d.answers.map(a=>'<section><h3>'+esc(a.id+' · '+a.question)+'</h3>'+values(a)+'</section>').join(''):'<p>No answers saved yet.</p>')+'</div></details><form id="dv-decision-form"><label>Decision<select name="action"><option value="invalidate">'+(d.validation.is_invalid?'Update invalidation reason':'Invalidate response')+'</option>'+(d.validation.is_invalid?'<option value="restore">Restore / include response</option>':'')+'</select></label><label data-dv-reason-label>Reason<select name="reason" required><option value="">Choose a reason</option>'+Object.entries(d.reasons).map(([k,v])=>'<option value="'+esc(k)+'" '+(d.validation.reason===k?'selected':'')+'>'+esc(v)+'</option>').join('')+'</select></label><label><span data-dv-notes-title>Additional notes (optional)</span><textarea name="notes" maxlength="2000" rows="3">'+esc(d.validation.notes)+'</textarea></label><div class="notice" data-dv-impact></div><label class="inline-check"><input name="confirmed" type="checkbox" required><span data-dv-confirm-text></span></label><p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" data-dv-close>Cancel</button><button type="submit" class="danger">Invalidate response</button></div></form><details class="validation-history"><summary>Decision history ('+d.history.length+')</summary>'+(d.history.length?d.history.map(h=>'<div class="review-comment"><b>'+esc(h.action==='restore'?'Restored':'Invalidated')+' · '+esc(d.reasons[h.reason]||'')+'</b><p>'+esc(h.notes||'No additional notes')+'</p><small>'+esc(h.reviewer+' · '+h.created_at+' UTC · revision '+h.revision)+'</small></div>').join(''):'<p>No validation decisions recorded.</p>')+'</details>';
        document.body.appendChild(dialog);
        dialog.querySelectorAll('[data-dv-close]').forEach(b=>b.addEventListener('click',closeDialog));
        dialog.addEventListener('cancel',()=>{active=null;});
        const f=dialog.querySelector('form');f.elements.action.addEventListener('change',()=>{f.elements.notes.value='';mode();});f.elements.reason.addEventListener('change',mode);mode();
        f.addEventListener('submit',async e=>{
          e.preventDefault();if(!active||!f.reportValidity())return;
          const submit=f.querySelector('button[type=submit]');submit.disabled=true;f.querySelector('.form-error').textContent='';
          try{
            await api('/api/workspace/validation',{slug,respondent_id:active.respondent_id,expected_revision:active.validation.revision,action:f.elements.action.value,reason:f.elements.reason.value,notes:f.elements.notes.value});
            const reviewedId=active?active.respondent_id:id;
            const message=f.elements.action.value==='restore'?'Response restored.':'Response invalidated. Original answers retained.';
            closeDialog();await load();if(alive){const focusTarget=$('[data-dv-review="'+reviewedId+'"]')||$('[data-dv-refresh]');focusTarget.focus();if(config.onChange)config.onChange(message);}
          }catch(err){if(alive&&err.name!=='AbortError'){f.querySelector('.form-error').textContent=err.message;submit.disabled=false;}}
        });
        dialog.showModal();
      }catch(e){if(alive&&e.name!=='AbortError')$('#dv-error').textContent=e.message;}
      finally{if(button.isConnected)button.disabled=false;}
    }
    host.addEventListener('click',e=>{
      const b=e.target.closest('button');if(!b)return;
      if(b.dataset.dvReview)review(Number(b.dataset.dvReview),b);
      if(b.hasAttribute('data-dv-refresh'))load();
      if(b.hasAttribute('data-dv-reset')){$('#dv-filters').reset();page=1;load();}
      if(b.dataset.dvPage){page+=b.dataset.dvPage==='next'?1:-1;load();}
    },{signal:controller.signal});
    $('#dv-filters').addEventListener('submit',e=>{e.preventDefault();page=1;load();},{signal:controller.signal});
    dispose=()=>{alive=false;controller.abort();closeDialog();};
    load();
  }
  window.AnakingValidation={mount,unmount};
})();
