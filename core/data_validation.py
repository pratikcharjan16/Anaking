"""Human response validation, separate from survey progress and automated QC flags."""
import json

from models import StudyError, get_db, now, write_lock

REASONS = {
    'speeder': 'Speeder',
    'gibberish': 'Gibberish response',
    'non_contextual': 'Non-contextual response',
    'flat_lining': 'Flat-lining',
    'other': 'Other (specify)',
}
STATUSES = {'non_started': 'Non-started', 'started': 'Started', 'in_progress': 'In progress',
            'complete': 'Completed', 'screened_out': 'Screened out'}
SCHEMA = '''
CREATE TABLE IF NOT EXISTS response_validations (
 respondent_id INTEGER PRIMARY KEY,
 study_id INTEGER NOT NULL,
 is_invalid INTEGER NOT NULL DEFAULT 0 CHECK(is_invalid IN (0,1)),
 reason TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 reviewer TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_response_validation_study ON response_validations(study_id,is_invalid);
CREATE TABLE IF NOT EXISTS response_validation_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, respondent_id INTEGER NOT NULL,
 study_id INTEGER NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL,
 notes TEXT NOT NULL, reviewer TEXT NOT NULL, created_at TEXT NOT NULL,
 revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_response_validation_events ON response_validation_events(study_id,respondent_id,id);
'''


def state(row=None):
    return {'is_invalid': bool(row['is_invalid']) if row else False,
            'reason': row['reason'] if row else '', 'notes': row['notes'] if row else '',
            'reviewer': row['reviewer'] if row else '', 'updated_at': row['updated_at'] if row else '',
            'revision': row['revision'] if row else 0}


def states(study_id):
    return {r['respondent_id']: state(r) for r in get_db().execute(
        'SELECT * FROM response_validations WHERE study_id=?', (study_id,))}


def has_answer(answers):
    # Zero and N/A are answers. Telemetry alone is not an answer.
    return any(value not in (None, '', [], {}) for payload in answers.values()
               for key, value in payload.items() if key == '_' or not key.startswith('_'))


def progress_status(row, answers):
    if row['status'] in ('complete', 'screened_out'):
        return row['status']
    return 'in_progress' if has_answer(answers) else 'started'


def validation_rows(study, scope='all'):
    """One row per session, plus unmatched invited people; reminders are not extra people."""
    db = get_db()
    people, tokens = {}, {}
    for person in (study.cfg.get('invites') or {}).get('recipients') or []:
        email = str(person.get('email') or '').strip()
        if email:
            people[email.casefold()] = {'email': email, 'name': str(person.get('name') or ''),
                                       'invited_at': '', 'invite_status': 'not_sent'}
    for invite in db.execute('SELECT * FROM invites WHERE study_slug=? ORDER BY id', (study.slug,)):
        email = invite['email'].strip()
        key = email.casefold()
        person = people.setdefault(key, {'email': email, 'name': '', 'invited_at': '', 'invite_status': ''})
        person.update(invited_at=invite['created_at'], invite_status=invite['status'])
        if invite['name']:
            person['name'] = invite['name']
        if invite['token']:
            tokens[invite['token']] = key
    validation = states(study.id)
    rows, linked = [], set()
    # Match invites against ALL real sessions before applying scope to avoid false non-starters.
    respondents = db.execute('SELECT * FROM respondents WHERE study_id=? ORDER BY id DESC', (study.id,)).fetchall()
    all_answers = {}
    for answer in db.execute('SELECT a.* FROM answers a JOIN respondents r ON r.id=a.respondent_id WHERE r.study_id=?', (study.id,)):
        value = answer['value']
        if answer['item'] in ('codes', 'order', '_meta', '_ai') or answer['item'].startswith('_ai:') or answer['item'].startswith('_meta:'):
            try:
                value = json.loads(value)
            except (ValueError, TypeError):
                pass
        all_answers.setdefault(answer['respondent_id'], {}).setdefault(answer['question_id'], {})[answer['item']] = value
    for r in respondents:
        try:
            embedded = json.loads(r['embedded'] or '{}')
        except (ValueError, TypeError):
            embedded = {}
        key = tokens.get(str(embedded.get('rid') or '')) if isinstance(embedded, dict) and not r['is_test'] else None
        if key:
            linked.add(key)
        if (scope == 'test' and not r['is_test']) or (scope == 'real' and r['is_test']):
            continue
        person = people.get(key, {})
        answers = all_answers.get(r['id'], {})
        rows.append({'respondent_id': r['id'], 'respondent_code': r['respondent_code'],
                     'email': person.get('email', ''), 'name': person.get('name', ''),
                     'status': progress_status(r, answers), 'is_test': bool(r['is_test']),
                     'started_at': r['started_at'], 'completed_at': r['completed_at'],
                     'elapsed_seconds': r['elapsed_seconds'] or 0,
                     'answered_questions': sum(has_answer({qid: a}) for qid, a in answers.items()),
                     'invited_at': person.get('invited_at', ''), 'invite_status': person.get('invite_status', ''),
                     'validation': validation.get(r['id'], state())})
    if scope != 'test':
        for key, person in people.items():
            if key not in linked:
                rows.append({**person, 'respondent_id': None, 'respondent_code': None,
                             'status': 'non_started', 'is_test': False, 'started_at': None,
                             'completed_at': None, 'elapsed_seconds': 0, 'answered_questions': 0,
                             'validation': state()})
    return rows


def decide(study_id, respondent_id, action, reason, notes, expected_revision, reviewer):
    """Atomic, optimistic update: stale dialogs cannot overwrite another reviewer's decision."""
    if type(respondent_id) is not int or respondent_id < 1:
        raise StudyError('Choose an existing response ID. Non-started invitees have no response to invalidate.')
    if type(expected_revision) is not int or expected_revision < 0:
        raise StudyError('A validation revision is required. Reload this response before saving.')
    if action not in ('invalidate', 'restore'):
        raise StudyError('Choose invalidate or restore.')
    if not isinstance(notes, str) or len(notes) > 2000:
        raise StudyError('Notes must be text, up to 2,000 characters.')
    notes = notes.strip()
    if action == 'invalidate':
        if not isinstance(reason, str) or reason not in REASONS:
            raise StudyError('Choose a listed invalidation reason.')
        if reason == 'other' and len(notes) < 3:
            raise StudyError('Please specify the Other reason (at least 3 characters).')
    else:
        reason = ''
        if len(notes) < 3:
            raise StudyError('Please explain why this response is being restored (at least 3 characters).')
    db = get_db()
    with write_lock, db:
        db.execute('BEGIN IMMEDIATE')
        respondent = db.execute('SELECT id FROM respondents WHERE id=? AND study_id=?', (respondent_id, study_id)).fetchone()
        if not respondent:
            raise StudyError('Response not found in this study.', 404)
        previous = db.execute('SELECT * FROM response_validations WHERE respondent_id=? AND study_id=?',
                              (respondent_id, study_id)).fetchone()
        current = state(previous)
        if current['revision'] != expected_revision:
            raise StudyError('This response was reviewed elsewhere. Close and reopen it to see the latest decision.', 409)
        if action == 'restore' and not current['is_invalid']:
            raise StudyError('This response is not invalidated.', 409)
        revision, ts = current['revision'] + 1, now()
        db.execute('INSERT INTO response_validations VALUES(?,?,?,?,?,?,?,?) '
                   'ON CONFLICT(respondent_id) DO UPDATE SET is_invalid=excluded.is_invalid, '
                   'reason=excluded.reason, notes=excluded.notes, reviewer=excluded.reviewer, '
                   'updated_at=excluded.updated_at, revision=excluded.revision',
                   (respondent_id, study_id, int(action == 'invalidate'), reason, notes, reviewer, ts, revision))
        db.execute('INSERT INTO response_validation_events(respondent_id,study_id,action,reason,notes,reviewer,created_at,revision) '
                   'VALUES(?,?,?,?,?,?,?,?)', (respondent_id, study_id, action, reason, notes, reviewer, ts, revision))
    return state(db.execute('SELECT * FROM response_validations WHERE respondent_id=?', (respondent_id,)).fetchone())
