import secrets
import time
from flask import Blueprint, abort, current_app, jsonify, redirect, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash
from models import get_db
from core.security import csrf_token

bp = Blueprint('access', __name__)
DUMMY = generate_password_hash('not-a-real-account-password')

@bp.route('/login', methods=['GET', 'POST'])
def login():
    if not current_app.config['STAFF_AUTH']:
        abort(404)
    error = None
    if request.method == 'POST':
        if not secrets.compare_digest(request.form.get('csrf', ''), session.get('csrf', '!')):
            return render_template('login.html', error='Reload this page and try again.'), 403
        address = request.remote_addr or 'unknown'
        db = get_db()
        attempt = db.execute('SELECT * FROM login_attempts WHERE address=?', (address,)).fetchone()
        if attempt and attempt['attempts'] >= 10 and time.time() - attempt['since'] < 900:
            return render_template('login.html', error='Too many attempts. Try again in 15 minutes.'), 429
        row = db.execute('SELECT * FROM staff_users WHERE username=? AND active=1', (request.form.get('username', ''),)).fetchone()
        valid = check_password_hash(row['password_hash'] if row else DUMMY, request.form.get('password', ''))
        if row and valid:
            session.clear()
            session['staff_id'] = row['id']
            csrf_token()
            db.execute('DELETE FROM login_attempts WHERE address=?', (address,))
            db.commit()
            return redirect('/workspace/')
        from core import accounts
        acct = accounts.authenticate_credentials(request.form.get('username', ''), request.form.get('password', ''))
        if acct and acct.get('status') == 'approved':
            session.clear()
            session['uid'] = acct['id']
            csrf_token()
            db.execute('DELETE FROM login_attempts WHERE address=?', (address,))
            db.commit()
            return redirect('/workspace/')
        count = attempt['attempts'] + 1 if attempt and time.time() - attempt['since'] < 900 else 1
        since = attempt['since'] if count > 1 else time.time()
        db.execute('INSERT OR REPLACE INTO login_attempts VALUES(?,?,?)', (address, count, since))
        db.commit()
        error = 'Username or password was not accepted.'
    return render_template('login.html', error=error)

@bp.route('/logout', methods=['GET', 'POST'])
def logout():
    if not current_app.config['STAFF_AUTH']:
        abort(404)
    if request.method != 'POST':
        abort(405)
    if not secrets.compare_digest(request.form.get('csrf', ''), session.get('csrf', '!')):
        return jsonify(error='Invalid CSRF token'), 403
    session.clear()
    return redirect('/login')
