import copy
from core.heatmap import summarize_heatmap
from core.research import summarize
from core.reporting import analysis_for

Q = {'id':'H','section':'S','type':'heatmap','stem':'Rate associations',
     'rows':[{'code':1,'label':'First row'}, {'code':'c_row','label':'Second row'}],
     'cols':[{'code':2,'label':'Column A'}, {'code':'b','label':'Column B'}]}
CFG = {'sections':[{'id':'S','title':'Main'}],'questions':[Q]}


def record(answers, status='complete'):
    return {'status':status,'answers':{'H':answers},'elapsed_seconds':60}


def test_heatmap_aggregates_use_cell_keys_and_selected_bases():
    data=[record({'1_2':'1','1_b':'3'}),record({'1_2':3,'c_row_b':'2'}),
          record({'1_2':'','1_b':0}),record({'1_2':'NaN','1_b':'garbage','c_row_b':5}),
          record({'1_2':2},'in_progress')]
    h=summarize_heatmap(data,Q)
    assert h['base']==2
    assert h['cells'][0]['mean']==2 and h['cells'][0]['base']==2
    assert h['cells'][1]['mean']==3 and h['cells'][1]['base']==1
    assert h['cells'][2]['mean'] is None and h['cells'][2]['base']==0
    assert h['cells'][3]['mean']==2
    report=summarize(data,CFG)['questions'][0]
    assert report['base']==2 and report['missing_or_not_shown']==2 and report['heatmap']==h
    assert analysis_for(data,CFG)['heatmap'][0]==h


def test_heatmap_save_clear_export_and_validation_filter(client):
    cfg=copy.deepcopy(CFG)
    assert client.post('/api/studio/save',json={'slug':'heatmap-fix','title':'Heatmap','cfg':cfg}).status_code==200
    client.post('/api/studio/status',json={'slug':'heatmap-fix','status':'live'})
    sid=client.post('/api/start',json={'study':'heatmap-fix'}).get_json()['session_id']
    client.post('/api/save',json={'session_id':sid,'answers':{'H':{'1_2':3}}})
    client.post('/api/save',json={'session_id':sid,'answers':{'H':{'1_2':'','c_row_b':2}}})
    assert client.get('/api/progress?sid='+sid).get_json()['answers']['H']['1_2']==''
    client.post('/api/submit',json={'session_id':sid})
    report=client.get('/api/workspace/analysis?study=heatmap-fix').get_json()['questions'][0]
    assert report['base']==1 and report['heatmap']['cells'][0]['mean'] is None
    assert report['heatmap']['cells'][3]['mean']==2
    assert client.get('/admin/export.csv?study=heatmap-fix').status_code==200
    assert client.get('/admin/export.xlsx?study=heatmap-fix').status_code==200
    assert client.get('/api/studio/analysis?study=heatmap-fix').get_json()['heatmap'][0]['base']==1
    rid=client.get('/api/workspace/validation?study=heatmap-fix').get_json()['rows'][0]['respondent_id']
    client.post('/api/workspace/validation',json={'slug':'heatmap-fix','respondent_id':rid,'action':'invalidate',
                'reason':'flat_lining','expected_revision':0})
    assert client.get('/api/workspace/analysis?study=heatmap-fix').get_json()['questions'][0]['base']==0
