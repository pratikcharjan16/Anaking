"""Additive version history, review and publication storage."""
import json
from models import get_db, now
from core.research import fingerprint
from core.security import actor

SCHEMA = '''
CREATE TABLE IF NOT EXISTS study_revisions (
 id INTEGER PRIMARY KEY, study_id INTEGER, title TEXT, cfg TEXT, digest TEXT, created_at TEXT, actor TEXT
);
CREATE INDEX IF NOT EXISTS ix_revision_study ON study_revisions(study_id,id);
CREATE TABLE IF NOT EXISTS publication_snapshots (study_id INTEGER PRIMARY KEY, cfg TEXT, digest TEXT);
CREATE TABLE IF NOT EXISTS publications (study_id INTEGER PRIMARY KEY, revision_id INTEGER, published_at TEXT);
CREATE TABLE IF NOT EXISTS response_versions (respondent_id INTEGER PRIMARY KEY, cfg TEXT, digest TEXT, consent TEXT DEFAULT '', consent_at TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS study_comments (id INTEGER PRIMARY KEY, study_id INTEGER, question TEXT, body TEXT, actor TEXT, state TEXT DEFAULT 'open', created_at TEXT);
CREATE TABLE IF NOT EXISTS study_reviews (study_id INTEGER PRIMARY KEY, digest TEXT, state TEXT, actor TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS verbatim_codes (study_id INTEGER, respondent_id INTEGER, question TEXT, codes TEXT, actor TEXT, updated_at TEXT, PRIMARY KEY(study_id,respondent_id,question));
'''


def revision(conn, study_id, title, cfg):
    digest = fingerprint(cfg)
    previous = conn.execute('SELECT id,digest FROM study_revisions WHERE study_id=? ORDER BY id DESC LIMIT 1', (study_id,)).fetchone()
    if previous and previous['digest'] == digest:
        return previous['id']
    return conn.execute('INSERT INTO study_revisions(study_id,title,cfg,digest,created_at,actor) VALUES(?,?,?,?,?,?)',
                        (study_id, title, json.dumps(cfg), digest, now(), actor())).lastrowid


def published_cfg(study, test=False):
    if not test:
        row = get_db().execute('SELECT r.cfg FROM publications p JOIN study_revisions r ON r.id=p.revision_id WHERE p.study_id=?', (study.id,)).fetchone()
        if row:
            return json.loads(row['cfg'])
    return study.cfg


def effective_cfg(study, test=False):
    if not test:
        row = get_db().execute('SELECT cfg FROM publication_snapshots WHERE study_id=?', (study.id,)).fetchone()
        if row:
            return json.loads(row['cfg'])
    cfg = dict(published_cfg(study, test))
    if study.is_child():
        parent = study.parent_study()
        if parent:
            base = dict(effective_cfg(parent, test))
            base['translations'] = cfg.get('translations', {})
            base['translation_excluded'] = cfg.get('translation_excluded', {})
            return base
    return cfg


def response_cfg(resp, fallback):
    row = get_db().execute('SELECT cfg FROM response_versions WHERE respondent_id=?', (resp.id,)).fetchone()
    return json.loads(row['cfg']) if row else fallback


def survey_config(study, test=False, lang=None):
    """Resolve a questionnaire once, including the selected translation family."""
    from core.i18n import default_language
    cfg = effective_cfg(study, test)
    selected = (study.cfg.get('language') if study.is_child() else lang) or default_language(cfg)
    if not study.is_child() and selected != default_language(cfg):
        from models import Study
        child = next((c for c in Study.children_of(study.slug) if c.cfg.get('language') == selected), None)
        if child:
            cfg = effective_cfg(child, test)
    cfg = dict(cfg)
    cfg['_selected_language'] = selected
    return cfg
