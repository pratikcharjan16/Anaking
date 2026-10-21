"""Optional staff boundary; production requires it. No shared/default password."""
import functools
import json
import secrets
import time

from flask import abort, current_app, g, jsonify, redirect, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash
from models import get_db, now

ROLES = {'owner', 'editor', 'reviewer', 'analyst', 'viewer'}
SCHEMA = '''
CREATE TABLE IF NOT EXISTS staff_users (
 id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
 role TEXT NOT NULL, studies TEXT NOT NULL DEFAULT '["*"]', active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS audit_events (
 id INTEGER PRIMARY KEY, actor TEXT, action TEXT, study TEXT, created_at TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS login_attempts (address TEXT PRIMARY KEY, attempts INTEGER, since REAL);
'''


def actor():
    return (getattr(g, 'staff', None) or {}).get('username', 'local-preview')


def audit(action, study='', detail=''):
    db = get_db()
    db.execute('INSERT INTO audit_events(actor,action,study,created_at,detail) VALUES(?,?,?,?,?)',
               (actor(), action, study, now(), str(detail)[:1000]))
    db.commit()


def allowed(slug):
    user = getattr(g, 'staff', None)
    return not current_app.config['STAFF_AUTH'] or bool(user and ('*' in user['studies'] or slug in user['studies']))


def csrf_token():
    if not current_app.config['STAFF_AUTH']:
        return ''
    if 'csrf' not in session:
        session['csrf'] = secrets.token_urlsafe(32)
    return session['csrf']


def create_user(username, password, role='owner', studies=None):
    if role not in ROLES or len(password) < 12 or not username.strip():
        raise ValueError('Use a valid role, nonempty username and a password of at least 12 characters.')
    db = get_db()
    db.execute('INSERT INTO staff_users(username,password_hash,role,studies) VALUES(?,?,?,?) '
               'ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role, studies=excluded.studies, active=1',
               (username.strip(), generate_password_hash(password), role, json.dumps(studies or ['*'])))
    db.commit()


def init_security(app):
    app.jinja_env.globals['csrf_token'] = csrf_token
    @app.before_request
    def boundary():
        g.staff = None
        if not app.config['STAFF_AUTH']:
            return
        uid = session.get('staff_id')
        if uid:
            row = get_db().execute('SELECT * FROM staff_users WHERE id=? AND active=1', (uid,)).fetchone()
            if row:
                g.staff = dict(row)
                g.staff['studies'] = json.loads(row['studies'])
        path = request.path
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            abort(400, 'Expected a JSON object.')
        if request.mimetype == 'multipart/form-data' and request.form.get('slug'):
            body = dict(body, slug=request.form.get('slug'))
        preview = (path.endswith('/test') or path == '/test' or
                   (path.startswith('/api/spec') and request.args.get('preview') == '1') or
                   (path == '/api/start' and body.get('is_test')))
        staff_path = (path == '/' or path.startswith(('/workspace', '/studio', '/admin', '/api/studio', '/api/admin', '/api/workspace', '/api/test-review')) or preview)
        if not staff_path:
            return
        if not g.staff:
            if path.startswith('/api/') or request.method != 'GET':
                return jsonify(error='Staff sign-in required'), 401
            return redirect(url_for('access.login'))
        # Check every supplied identity; conflicting body/query identities cannot bypass scopes.
        slugs = [v for v in (request.args.get('study'), request.args.get('slug'), body.get('slug'), body.get('study'), (request.view_args or {}).get('slug')) if v]
        if path.startswith('/admin/voice/'):
            filename = (request.view_args or {}).get('file') or path.rsplit('/', 1)[-1]
            slugs.append(filename.split('__', 1)[0])
        if path.startswith('/api/test-review/'):
            from models import Study
            review = Study.get_test_review((request.view_args or {}).get('token', ''))
            if review:
                slugs.append(review['study'])
        if not slugs and (path.startswith(('/api/admin', '/admin/export', '/admin/reset')) or preview or path == '/api/test-review' or path in ('/api/studio/analysis', '/api/studio/strings', '/api/studio/children', '/api/studio/outline.docx', '/api/studio/media', '/api/studio/narration')):
            slugs.append('beacon')
        if any(not isinstance(slug, str) or not allowed(slug) for slug in slugs):
            abort(403, 'This study is outside your access scope.')
        role = g.staff['role']
        if path.startswith(('/admin/export', '/admin/voice/', '/api/workspace/export', '/api/workspace/verbatims', '/api/admin/verbatims', '/api/workspace/validation')) and role not in {'owner', 'analyst', 'editor'}:
            abort(403, 'Data access permission required.')
        if request.method not in ('GET', 'HEAD', 'OPTIONS'):
            if not secrets.compare_digest(request.headers.get('X-CSRF-Token', ''), session.get('csrf', '!')):
                abort(403, 'Session expired or invalid CSRF token. Reload the page.')
            destructive = path.endswith(('/delete', '/reset', '/publish', '/restore', '/retention', '/status', '/launch', '/relaunch', '/pause', '/move'))
            if destructive and role != 'owner':
                abort(403, 'Owner approval required.')
            permitted = role in {'owner', 'editor'}
            permitted |= role == 'reviewer' and path.endswith(('/comments', '/review'))
            permitted |= role == 'analyst' and (path.endswith('/coding') or path == '/api/workspace/validation')
            permitted |= path.endswith('/assistant')
            if not permitted:
                abort(403, 'Your role cannot perform this action.')
        if '*' not in g.staff['studies']:
            if path.endswith(('/move', '/duplicate', '/globalize')):
                abort(403, 'Workspace-wide permission is required to manage study identities.')
            if path == '/api/studio/agent/start':
                abort(403, 'Workspace-wide permission is required to create a new study.')
            if path == '/api/studio/save':
                from models import Study
                existing = Study.get(body.get('slug') or '')
                if not existing:
                    abort(403, 'Workspace-wide permission is required to create studies.')
                parent = (body.get('cfg') or {}).get('parent')
                if parent != existing.cfg.get('parent'):
                    abort(403, 'Changing study inheritance requires workspace-wide permission.')

    @app.after_request
    def security_headers(response):
        response.headers.setdefault('Referrer-Policy', 'same-origin')
        response.headers.setdefault('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)')
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and response.status_code < 400 and getattr(g, 'staff', None):
            body = request.get_json(silent=True) or {}
            audit(request.path, body.get('slug') or body.get('study') or request.form.get('slug') or request.args.get('study', ''))
        return response
