"""Workspace, publication and staff-boundary regression tests."""
import copy
import re
from core.research import summarize, crosstab
from models import Study, get_db

CFG = {'language':'en-US','gamify':False,'sections':[{'id':'S','title':'Main'}],
       'questions':[{'id':'Q1','section':'S','type':'single_select','stem':'Choose one',
                     'options':[{'code':1,'label':'Yes'},{'code':2,'label':'No'}]},
                    {'id':'Q2','section':'S','type':'numeric','stem':'How many?', 'min':0,'max':100}],
       'privacy_notice':'Research only.', 'research_brief':'Measure preferences.'}


def make(client, slug='workspace-test'):
    assert client.post('/api/studio/save',json={'slug':slug,'title':slug,'cfg':copy.deepcopy(CFG)}).status_code == 200
    return slug


def approve_publish(client, slug):
    d = client.get('/api/workspace/study',query_string={'study':slug}).get_json()
    assert client.post('/api/workspace/review',json={'slug':slug,'state':'approved','digest':d['digest']}).status_code == 200
    r=client.post('/api/workspace/publish',json={'slug':slug})
    assert r.status_code == 200, r.get_json()
    return r.get_json()


def test_workspace_enabled_pages_and_assets(app,client):
    app.config['WORKSPACE_ENABLED']=True
    for path in ('/','/workspace/'):
        r=client.get(path)
        assert r.status_code == 200
        assert b'js/workspace.js' in r.data
    assert client.get('/static/js/workspace.js').status_code == 200
    assert client.get('/static/css/workspace.css').status_code == 200
    assert client.get('/?legacy=1').status_code == 200


def test_publication_pins_live_and_resumed_sessions(app,client):
    slug=make(client)
    assert client.post('/api/workspace/publish',json={'slug':slug}).status_code == 409
    first=approve_publish(client,slug)
    sp=client.get('/api/spec/'+slug).get_json()
    r=client.post('/api/start',json={'study':slug,'survey_version':sp['survey_version']}).get_json()
    cfg=copy.deepcopy(CFG);cfg['questions'][0]['stem']='New draft question'
    client.post('/api/studio/save',json={'slug':slug,'cfg':cfg})
    assert client.get('/api/spec/'+slug).get_json()['questions'][0]['stem']=='Choose one'
    assert client.get('/api/spec/'+slug+'?preview=1').get_json()['questions'][0]['stem']=='New draft question'
    assert client.post('/api/workspace/publish',json={'slug':slug}).status_code==409
    approve_publish(client,slug)
    assert client.get('/api/spec/'+slug).get_json()['questions'][0]['stem']=='New draft question'
    assert client.get('/api/spec/'+slug+'?sid='+r['session_id']).get_json()['questions'][0]['stem']=='Choose one'
    assert client.post('/api/start',json={'study':slug,'survey_version':sp['survey_version']}).status_code==409
    assert client.get('/api/spec/beacon?sid='+r['session_id']).status_code==403
    assert client.post('/api/workspace/restore',json={'slug':slug,'revision':first['revision']}).status_code==200
    assert client.get('/api/spec/'+slug).get_json()['questions'][0]['stem']=='New draft question'
    client.post('/api/studio/delete',json={'slug':slug})
    with app.app_context():
        assert get_db().execute('SELECT count(*) FROM response_versions').fetchone()[0]==0


def test_consent_and_snapshot_export(client):
    slug=make(client)
    client.post('/api/workspace/settings',json={'slug':slug,'require_consent':True,'consent_statement':'I agree.'})
    approve_publish(client,slug)
    r=client.post('/api/start',json={'study':slug}).get_json(); sid=r['session_id']
    assert client.post('/api/save',json={'session_id':sid,'answers':{'Q1':{'_':1}}}).status_code==403
    assert client.post('/api/consent',json={'session_id':sid,'accepted':False}).status_code==400
    assert client.post('/api/consent',json={'session_id':sid,'accepted':True}).status_code==200
    assert client.post('/api/submit',json={'session_id':sid,'answers':{'Q1':{'_':1},'Q2':{'_':0}},'elapsed_seconds':100}).status_code==200
    d=client.get('/api/workspace/analysis',query_string={'study':slug}).get_json()
    assert d['response_versions']==[r['survey_version']]
    assert d['questions'][1]['mean']==0
    report=client.get('/api/workspace/export',query_string={'study':slug}).get_json()
    assert report['scope']=='real' and report['definition_digest']


def login(app,client,username,role,studies):
    from core.security import create_user
    app.config['STAFF_AUTH']=True
    with app.app_context():create_user(username,'long-test-password',role,studies)
    html=client.get('/login').data
    csrf=re.search(rb'name="csrf" value="([^"]+)"',html).group(1).decode()
    assert client.post('/login',data={'username':username,'password':'long-test-password','csrf':csrf}).status_code==302
    with client.session_transaction() as sess: return {'X-CSRF-Token':sess['csrf']}


def test_scoped_roles_and_csrf(app,client):
    slug=make(client)
    headers=login(app,client,'scoped','editor',[slug])
    assert [s['slug'] for s in client.get('/api/studio/list').get_json()]==[slug]
    assert client.get('/api/workspace/study?study=beacon').status_code==403
    assert client.get('/api/admin/data').status_code==403
    assert client.get('/survey/beacon/test').status_code==403
    assert client.get('/admin/voice/beacon__R001_Q1.webm?study='+slug).status_code==403
    assert client.post('/api/studio/save',json={'slug':slug,'cfg':CFG}).status_code==403
    assert client.post('/api/workspace/settings?study='+slug,headers=headers,json={'slug':'beacon','research_brief':'No'}).status_code==403
    assert client.post('/api/workspace/publish',headers=headers,json={'slug':slug}).status_code==403
    assert client.post('/api/studio/save',headers=headers,json={'slug':'new-injected','cfg':CFG}).status_code==403
    assert client.post('/api/studio/save',headers=headers,json={'slug':slug,'cfg':CFG}).status_code==200
    client.post('/logout',data={'csrf':headers['X-CSRF-Token']})
    assert client.get('/api/studio/list').status_code==401


def test_readonly_role_and_unconfigured_model(app,client):
    slug=make(client)
    headers=login(app,client,'read-only','viewer',[slug])
    assert client.get('/api/workspace/study?study='+slug).status_code==200
    assert client.post('/api/workspace/settings',headers=headers,json={'slug':slug,'gamify':True}).status_code==403
    assert client.get('/api/workspace/export?study='+slug).status_code==403
    assert client.get('/api/workspace/verbatims?study='+slug).status_code==403
    r=client.post('/api/workspace/assistant',headers=headers,json={'slug':slug,'task':'review'}).get_json()
    assert r['applied'] is False and 'no model' in r['mode']
    assert client.post('/api/workspace/assistant',headers=headers,json={'slug':slug,'use_model':True,'approved':True}).status_code==503


def test_descriptive_zero_missing_and_small_base():
    data=[{'status':'complete','answers':{'Q2':{'_':'0'}},'elapsed_seconds':60},
          {'status':'complete','answers':{'Q2':{'_':'10'}},'elapsed_seconds':120},
          {'status':'complete','answers':{},'elapsed_seconds':180}]
    q=summarize(data,CFG)['questions'][1]
    assert q['mean']==5 and q['base']==2 and q['missing_or_not_shown']==1 and q['small_base']
