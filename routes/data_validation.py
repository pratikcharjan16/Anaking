"""Staff-only response validation list, review details and reversible decisions."""
import csv
import io
from flask import Blueprint, abort, current_app, g, jsonify, request
from core.data_validation import REASONS, STATUSES, decide, validation_rows, state, progress_status
from core.governance import response_cfg, effective_cfg
from core.research import plain
from core.security import actor, allowed
from models import Study, Respondent, StudyError, get_db
from .helpers import attachment, error, safe_csv_cell

bp = Blueprint('data_validation', __name__)


def study():
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        abort(400, 'Expected a JSON object.')
    slug = request.args.get('study') or body.get('slug')
    s = Study.get(slug or '')
    if not s:
        abort(404, 'Study not found.')
    if not allowed(s.slug):
        abort(403)
    if current_app.config['STAFF_AUTH'] and g.staff['role'] not in ('owner', 'editor', 'analyst'):
        abort(403, 'Data Validation requires owner, editor or analyst access.')
    return s


@bp.get('/api/workspace/validation')
def listing():
    s = study()
    scope, status, validity = request.args.get('scope', 'all'), request.args.get('status', ''), request.args.get('validity', '')
    if scope not in ('all', 'real', 'test') or status not in ('', *STATUSES) or validity not in ('', 'included', 'invalidated'):
        abort(400, 'Invalid scope or filter.')
    try:
        page, size = int(request.args.get('page', 1)), int(request.args.get('page_size', 50))
    except ValueError:
        abort(400, 'Invalid page.')
    if page < 1 or not 1 <= size <= 100:
        abort(400, 'Invalid page size.')
    rows = validation_rows(s, scope)
    counts = {k: sum(r['status'] == k for r in rows) for k in STATUSES}
    counts.update(total=len(rows), invalidated=sum(r['validation']['is_invalid'] for r in rows))
    query = request.args.get('q', '').strip().casefold()[:300]
    rows = [r for r in rows if (not status or r['status'] == status)
            and (not validity or (r['respondent_id'] is not None and r['validation']['is_invalid'] == (validity == 'invalidated')))
            and (not query or query in ' '.join(str(r.get(k) or '') for k in ('respondent_id', 'respondent_code', 'email', 'name')).casefold())]
    if request.args.get('format') == 'csv':
        headers = ['response_id', 'respondent_code', 'name', 'email', 'status', 'data_type', 'started_at',
                   'completed_at', 'elapsed_seconds', 'validation', 'reason', 'notes', 'reviewer', 'reviewed_at']
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(headers)
        for r in rows:
            v = r['validation']
            writer.writerow([safe_csv_cell(x) for x in (r['respondent_id'], r['respondent_code'], r['name'], r['email'],
                STATUSES[r['status']], 'test' if r['is_test'] else 'real', r['started_at'], r['completed_at'],
                r['elapsed_seconds'], 'No response' if r['respondent_id'] is None else 'Invalidated' if v['is_invalid'] else 'Included',
                REASONS.get(v['reason'], ''), v['notes'], v['reviewer'], v['updated_at'])])
        return attachment(out.getvalue().encode('utf-8-sig'), 'text/csv; charset=utf-8', s.slug + '_data_validation.csv')
    total = len(rows)
    pages = max(1, (total + size - 1) // size)
    page = min(page, pages)
    return jsonify(rows=rows[(page-1)*size:page*size], counts=counts, total=total, page=page, pages=pages,
                   reasons=REASONS, statuses=STATUSES,
                   note='Invalidation excludes a response from analysis and standard exports; original answers are retained. Non-started invitees have no response ID. Started means a session exists but no answers have been saved. Non-started means no linked session was found. Older responses without an invitation token cannot be matched automatically. Public-link visitors cannot be listed before they open the survey.')


@bp.get('/api/workspace/validation/response')
def detail():
    s = study()
    try:
        rid = int(request.args.get('respondent_id', ''))
    except ValueError:
        abort(400, 'An existing response ID is required.')
    resp = Respondent.by_id(rid)
    if not resp or resp.study_id != s.id:
        abort(404, 'Response not found in this study.')
    cfg = response_cfg(resp, effective_cfg(s))
    questions = {q['id']: q for q in cfg.get('questions', [])}
    answers = resp.answers()
    visible = []
    for qid, payload in answers.items():
        q = questions.get(qid, {})
        values = {k:v for k,v in payload.items() if k == '_' or not k.startswith('_')}
        if values:
            visible.append({'id': qid, 'question': plain(q.get('stem_html') or q.get('stem') or qid), 'values': values,
                            'options': {str(o['code']): plain(o.get('label_html') or o.get('label')) for o in q.get('options', [])}})
    db = get_db()
    validation = state(db.execute('SELECT * FROM response_validations WHERE respondent_id=? AND study_id=?', (rid, s.id)).fetchone())
    history = [dict(r) for r in db.execute('SELECT action,reason,notes,reviewer,created_at,revision FROM response_validation_events '
        'WHERE respondent_id=? AND study_id=? ORDER BY id DESC', (rid, s.id))]
    return jsonify(respondent_id=rid, respondent_code=resp.code, status=progress_status(resp.row, answers),
                   elapsed_seconds=resp.row['elapsed_seconds'] or 0, is_test=resp.is_test,
                   answers=visible, validation=validation, history=history, reasons=REASONS)


@bp.post('/api/workspace/validation')
def update():
    s = study()
    body = request.get_json(silent=True) or {}
    try:
        result = decide(s.id, body.get('respondent_id'), body.get('action'), body.get('reason', ''),
                        body.get('notes', ''), body.get('expected_revision'), actor())
    except StudyError as e:
        return error(e)
    return jsonify(ok=True, validation=result)
