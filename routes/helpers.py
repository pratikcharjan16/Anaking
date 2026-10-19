"""Small helpers shared by the route modules."""

from __future__ import annotations

import time

from flask import Response, jsonify, request

from core.reporting import flatten
from models import Respondent, Study, StudyError, get_db
from core.governance import response_cfg


def json_body() -> dict:
    return request.get_json(silent=True) or {}


def error(e: StudyError):
    return jsonify({"error": e.message}), e.status


def study_arg() -> str:
    return request.args.get("study") or "beacon"


def scope_arg(default: str = "all") -> str:
    return request.args.get("scope") or default


def records(slug: str, scope: str = "all", include_invalid: bool = False) -> list[dict]:
    """Respondents of a study as dicts with ``answers`` and a flattened ``flat`` row."""
    study = Study.get(slug)
    if not study:
        return []
    from core.data_validation import states, state
    validation = states(study.id)
    out = []
    for r in Respondent.for_study(study.id, scope):
        decision = validation.get(r["id"], state())
        if decision["is_invalid"] and not include_invalid:
            continue
        rec = {k: r[k] for k in r.keys()}
        rec["validation"] = decision
        if include_invalid:
            rec['validation_history'] = [dict(event) for event in get_db().execute(
                'SELECT action,reason,notes,reviewer,created_at,revision FROM response_validation_events '
                'WHERE respondent_id=? AND study_id=? ORDER BY id', (r['id'], study.id))]
        rec["answers"] = Respondent(r).answers()
        rec["is_test_label"] = "test" if r["is_test"] else "real"
        snap = get_db().execute('SELECT digest,consent_at FROM response_versions WHERE respondent_id=?', (r['id'],)).fetchone()
        rec['survey_version'] = snap['digest'] if snap else 'legacy'
        rec['consent_at'] = snap['consent_at'] if snap else ''
        rec["flat"] = flatten(rec, rec["answers"], response_cfg(Respondent(r), study.cfg))
        rec['flat']['survey_version'] = rec['survey_version']
        rec['flat']['consent_at'] = rec['consent_at']
        rec['flat']['response_id'] = r['id']
        rec['flat']['validation_status'] = 'invalidated' if decision['is_invalid'] else 'included'
        for field in ('reason', 'notes', 'reviewer', 'updated_at'):
            rec['flat']['validation_' + field] = decision[field]
        out.append(rec)
    return out


def attachment(data: bytes, mimetype: str, filename: str, extra: dict | None = None):
    headers = {"Content-Disposition": f"attachment; filename={filename}",
               "Cache-Control": "no-store", **(extra or {})}
    return Response(data, mimetype=mimetype, headers=headers)


def stamp() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


def safe_csv_cell(value):
    """Keep user-authored reasons/answers as text when a CSV is opened in a spreadsheet."""
    if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@', '\t', '\r', '\n')):
        return "'" + value
    return value
