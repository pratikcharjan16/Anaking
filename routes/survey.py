"""
SURVEY  -  respondent-facing app.

Pages
    GET  /survey/                 the BEACON survey
    GET  /survey/test             same survey, stored as test data (T001, T002 ...)
    GET  /survey/<slug>           any study launched from the Studio
    GET  /survey/<slug>/test      ... in test mode (also previews drafts / closed studies)
    GET  /audio/<file>            narration clips

API (used by static/js/survey.js)
    GET  /api/spec/<slug>   GET /api/progress?sid=
    POST /api/start  /api/save  /api/submit  /api/voice  /api/check_text
"""

from __future__ import annotations

import json
import base64
import hashlib
import os
import re
from flask import (Blueprint, abort, current_app, jsonify, render_template, request,
                   send_from_directory)

from core.ai_detect import MAX_TEXT, ai_settings, score_text, MAIN_ITEM, field_key
from core.conjoint import assignment_for
from core.i18n import (LANG_BY_CODE, apply_language, default_language, extract_strings,
                       ui_strings, valid_language)
from core.qc import qc_flags
from core.seed import load_task_map
from core.survey_spec import TERMINATE_TEXT
from models import Respondent, Study, StudyError, get_db, now
from core.governance import survey_config, response_cfg
from core.research import fingerprint, readiness

from .helpers import json_body

bp = Blueprint("survey", __name__)

SLUG = r'<regex("[a-zA-Z0-9\-]+"):slug>'


# ---------------------------------------------------------------- pages
def _survey_page(slug: str):
    study = Study.get(slug)
    if not study:
        abort(404, "unknown study")
    is_test = request.path.rstrip("/").endswith("/test")
    paused = study.status == "paused"
    link_token = str(request.args.get("rid") or "")[:200] if not is_test else ""
    linked_resp = None
    cookie_name = "sk_survey_" + hashlib.sha256(slug.encode("utf-8")).hexdigest()[:18]
    respondent_token = link_token

    if not is_test:
        if link_token:
            if not Study.is_single_use_link(slug, link_token):
                return render_template("survey/invalid_link.html", study_title=study.title), 404
            linked_resp = Respondent.by_invite_token(study.id, link_token)
            if linked_resp and linked_resp.status in ("complete", "screened_out"):
                return render_template("survey/completed.html", study_title=study.title)
        elif study.effective_live():
            # Keep the canonical public URL and page behavior intact while assigning each
            # browser a private token, which makes its response resumable on that browser.
            respondent_token = request.cookies.get(cookie_name, "")
            if not Study.is_single_use_link(slug, respondent_token):
                respondent_token = Study.create_public_survey_link(slug)
            linked_resp = Respondent.by_invite_token(study.id, respondent_token)
            if linked_resp and linked_resp.status in ("complete", "screened_out"):
                return render_template("survey/completed.html", study_title=study.title)

        if not study.effective_live() and not linked_resp and not paused:
            return render_template("survey/not_live.html", slug=slug, study_title=study.title), 403
        # Existing token-bound sessions can finish after pause/closure; /api/start enforces
        # that no new session can start unless the study is live.

    design_version = ""
    if is_test:
        design_version = fingerprint(survey_config(study, True))[:10]
    response = current_app.make_response(render_template(
        "survey/survey.html", slug=slug, study_title=study.title,
        is_test=is_test, is_draft=not study.effective_live(),
        is_paused=paused and not is_test, respondent_token=respondent_token,
        design_version=design_version))
    if respondent_token and not is_test and not link_token:
        response.set_cookie(cookie_name, respondent_token, max_age=60 * 60 * 24 * 365,
                            httponly=True, secure=request.is_secure, samesite="Lax",
                            path="/survey/" + slug)
    return response


@bp.get("/survey/")
def beacon_survey():
    return _survey_page("beacon")


@bp.get("/survey/test")
def beacon_survey_test():
    return _survey_page("beacon")


@bp.get(f"/survey/{SLUG}")
@bp.get(f"/survey/{SLUG}/test")
def study_survey(slug):
    return _survey_page(slug)


@bp.get("/audio/<path:name>")
def audio(name):
    """Narration clips; ``send_from_directory`` handles Range requests for seeking."""
    if not name.endswith(".mp3"):
        abort(404)
    return send_from_directory(os.path.join(current_app.static_folder, "audio"), name,
                               mimetype="audio/mpeg", conditional=True)


# ---------------------------------------------------------------- API
def _family_languages(home, base: dict) -> list[dict]:
    """Default language first, then one entry per translation child (plus any legacy
    inline translation), each tagged with the child slug respondents should use."""
    codes = [default_language(base)]
    for ch in home.children_of(home.slug):
        c = ch.cfg.get("language")
        if c and c not in codes:
            codes.append(c)
    for c in (base.get("translations") or {}):
        if c not in codes:
            codes.append(c)
    out = []
    for c in codes:
        meta = LANG_BY_CODE.get(c, {"code": c, "native": c, "dir": "ltr"})
        child = next((ch.slug for ch in home.children_of(home.slug)
                      if ch.cfg.get("language") == c), "")
        out.append(dict(meta, child=child))
    return out


@bp.get("/api/spec")
@bp.get(f"/api/spec/{SLUG}")
def spec(slug="beacon"):
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    preview = request.args.get('preview') == '1'
    resp = Respondent.by_session(request.args.get('sid'))
    link_token = str(request.args.get('rid') or '')[:200]
    if not resp and link_token and Study.is_single_use_link(slug, link_token):
        resp = Respondent.by_invite_token(study.id, link_token)
    if resp and resp.study_id != study.id:
        abort(403, 'Session belongs to another study.')
    if current_app.config['STAFF_AUTH'] and not study.effective_live() and not resp and not preview:
        abort(403, 'Study is not live.')
    # A test page must always show the study as it is *now*.  Test sessions used to pin the
    # snapshot they started with, which meant edits made in the Studio stayed invisible in
    # the test link until the browser's saved run was wiped.  Real respondents keep their
    # pinned version; test runs follow the live design.
    requested = str(request.args.get('lang') or '').strip()[:20]
    if requested and not valid_language(requested):
        requested = ""
    test_view = resp.is_test if resp is not None else preview
    # A real response keeps the design it started with, but its *language tables* are read
    # from the study as it stands now.  Pinning them too used to freeze the untranslated
    # version into every live session: respondents who started before (or while) a
    # translation was saved kept seeing the default language, and a mid-run language switch
    # reloaded into English.  Refreshing only translations never changes a question, an
    # option or the flow of a published study.
    pinned = response_cfg(resp, None) if (resp is not None and not test_view) else None
    session_lang = str((pinned or {}).get('_selected_language') or '')
    # The language saved on the response follows the respondent across reloads; the language
    # the session was pinned to is the fallback for responses created before that existed.
    stored_lang = str(resp.language or "") if resp is not None else ""
    fresh = survey_config(study, test_view, requested or stored_lang or session_lang or None)
    if pinned:
        merged_src = dict(pinned)
        merged_src['translations'] = fresh.get('translations') or {}
        merged_src['translation_excluded'] = fresh.get('translation_excluded') or {}
        merged_src['_selected_language'] = (requested or session_lang
                                            or fresh.get('_selected_language'))
    else:
        merged_src = fresh
    base = merged_src
    home = (study.parent_study() if study.is_child() else study) or study
    languages = _family_languages(home, base)
    family = {l['code'] for l in languages}
    # An explicit ?lang= always outranks the language the session was started in: that is
    # how the welcome picker and the in-survey switcher move a live session to another
    # language.  Otherwise the language saved on the response wins, so a respondent who
    # switched to Spanish mid-interview and reloads later comes back to Spanish.
    # A language that is no longer part of the study falls back to the default.
    lang = ((requested if requested in family else "")
            or (stored_lang if stored_lang in family else "")
            or (session_lang if session_lang in family else "")
            or merged_src.get('_selected_language')
            or (study.cfg.get('language') if study.is_child() else "")
            or default_language(base))
    if lang not in family:
        lang = default_language(base)
    if resp is not None and not test_view and resp.status not in ("complete", "screened_out"):
        try:
            resp.set_language(lang)      # the respondent's own language follows them
        except Exception:                # never block a spec request on a bookkeeping write
            current_app.logger.debug("could not record respondent language", exc_info=True)
    cfg = apply_language(merged_src, lang)
    # apply_language() leaves render_language unset for the authoring language, so resolve it
    # once here: the welcome copy, the <html lang> and the "show the original wording" chip
    # all read it, and a child viewed in the parent language must not claim a translation.
    render_language = cfg.get("render_language") or lang
    conj = cfg.get("conjoint")
    if conj and isinstance(conj.get("tasks"), list):
        conj = dict(conj, tasks={str(i + 1): t for i, t in enumerate(conj["tasks"])})
    return jsonify({
        "survey_version": fingerprint(merged_src),
        # which study / design this page is showing - the test link is always the current one
        "study": slug,
        "test_mode": bool(test_view),
        "privacy_notice": cfg.get("privacy_notice", ""),
        "research_contact": cfg.get("research_contact", ""),
        "consent_statement": cfg.get("consent_statement", "I agree to take part in this research."),
        "require_consent": bool(cfg.get("require_consent")),
        "estimated_minutes": readiness(cfg)['estimated_minutes'],
        "sections": cfg.get("sections", []),
        "questions": cfg.get("questions", []),
        "conjoint": conj,
        "terminate_text": TERMINATE_TEXT,
        "narration": cfg.get("narration", {}),
        "explainer_scenes": cfg.get("explainer_scenes", []),
        "conjoint_scene": cfg.get("conjoint_scene"),
        "conjoint_min_dwell": cfg.get("conjoint_min_dwell", 12),
        "use_tts": cfg.get("use_tts", False),
        # gamified respondent experience (ring/points/confetti); absent or true keeps it on
        "gamify": cfg.get("gamify", True),
        "tpp": cfg.get("tpp", {}),
        # study-wide AI-answer check settings; questions can override with ai_check/ai_action
        "ai_check": cfg.get("qc", {}).get("ai", {}),
        # globalisation + flow objects
        "default_language": default_language(base),
        "render_language": render_language,
        "render_dir": cfg.get("render_dir", "ltr"),
        "languages": languages,
        # the wording of the interface itself (Begin, Next, Listen ...) in this language
        "ui": ui_strings(cfg),
        # the original wording of every respondent string, so respondents can flip any
        # question back to the default language whenever they prefer it
        "default_text": ({} if render_language == default_language(base)
                         else {x["key"]: x["text"] for x in extract_strings(base)}),
        "embedded": [e.get("name") for e in cfg.get("embedded", []) or [] if e.get("name")],
        "randomize_pages": bool(cfg.get("randomize_pages")),
        "welcome_title": cfg.get("welcome_title"), "welcome_text": cfg.get("welcome_text"),
        "thanks_title": cfg.get("thanks_title"), "thanks_text": cfg.get("thanks_text"),
    })


@bp.post("/api/start")
def start():
    body = json_body()
    slug = body.get("study") or "beacon"
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    is_test = bool(body.get("is_test"))
    sent = body.get("embedded") if isinstance(body.get("embedded"), dict) else {}
    invite_token = str(sent.get("rid") or "")[:200] if not is_test else ""
    linked_resp = None
    if invite_token:
        if not Study.is_single_use_link(slug, invite_token):
            return jsonify({"error": "This personal survey link is invalid.", "invalid_link": True}), 404
        linked_resp = Respondent.by_invite_token(study.id, invite_token)
        if linked_resp and linked_resp.status in ("complete", "screened_out"):
            return jsonify({"completed": True, "message": "You have already completed this survey. Thank you."})
    if not study.effective_live() and not is_test and not linked_resp:
        if study.status == "paused":
            return jsonify({"error": "This study is paused - the research team has stopped new "
                                     "responses for now. Please try again later.",
                            "paused": True}), 403
        return jsonify({"error": "study not live"}), 403
    lang = str(body.get("language") or "")[:12]
    if lang and not valid_language(lang):
        lang = ""
    cfg = survey_config(study, is_test, lang)
    if body.get("survey_version") and body["survey_version"] != fingerprint(cfg):
        return jsonify(error="The survey changed before you started. Reload to use the current version."), 409
    # Test links are always fresh. A real invite/public token instead resumes its one server-side
    # session until completion, including on another device or after the study was paused.
    previous = str(body.get("previous_session") or "")
    if is_test and previous:
        Respondent.discard_test_session(study, previous)
    if linked_resp:
        return jsonify({"session_id": linked_resp.session_id, "respondent_code": linked_resp.code,
                        "is_test": False, "study": slug, "resumed": True,
                        "task_order": json.loads(linked_resp.row["task_order"] or "[]"),
                        "alt_positions": json.loads(linked_resp.row["alt_positions"] or "{}")})

    wanted = [e.get("name") for e in cfg.get("embedded", []) or [] if e.get("name")]
    embedded = {k: str(v)[:200] for k, v in sent.items() if k in wanted}
    if invite_token:
        embedded["rid"] = invite_token
    resp = Respondent.create(study, is_test, request.headers.get("User-Agent", ""), lang,
                             embedded, snapshot=cfg, invite_token=invite_token)
    if not is_test and resp.status in ("complete", "screened_out"):
        return jsonify({"completed": True, "message": "You have already completed this survey. Thank you."})
    design = cfg.get("conjoint")
    task_map = load_task_map() if slug == "beacon" else None
    assignment = (assignment_for(resp.code, design, task_map) if design
                  else {"task_order": [], "alt_positions": {}})
    resp.set_assignment(assignment["task_order"], assignment["alt_positions"])
    return jsonify({"session_id": resp.session_id, "respondent_code": resp.code,
                    "is_test": resp.is_test, "study": slug, "survey_version": fingerprint(cfg),
                    "task_order": assignment["task_order"],
                    "alt_positions": assignment["alt_positions"],
                    "from_prebuilt_map": resp.code in (task_map or {})})


@bp.post("/api/test-review")
def save_test_review():
    body = json_body()
    try:
        token = Study.save_test_review(body.get("study") or "beacon", {
            "answers": body.get("answers") if isinstance(body.get("answers"), dict) else {},
            "notes": body.get("notes") if isinstance(body.get("notes"), dict) else {},
            "current": int(body.get("current") or 0),
        }, str(body.get("token") or ""))
    except StudyError as e:
        return jsonify({"error": e.message}), e.status
    return jsonify({"ok": True, "token": token, "url": f"/survey/{body.get('study') or 'beacon'}/test?review={token}"})


@bp.get("/api/test-review/<token>")
def get_test_review(token):
    review = Study.get_test_review(token)
    return jsonify(review if review else {"error": "review not found"}), (200 if review else 404)


@bp.post("/api/save")
def save():
    body = json_body()
    resp = Respondent.by_session(body.get("session_id"))
    if resp is None:
        return jsonify({"error": "unknown session"}), 400
    if not resp.is_test and resp.status in ("complete", "screened_out"):
        return jsonify({"error": "This response is already complete.", "completed": True}), 409
    require_consent(resp)
    return jsonify({"ok": True, "status": resp.persist(body)})


@bp.post("/api/submit")
def submit():
    body = json_body()
    resp = Respondent.by_session(body.get("session_id"))
    if resp is None:
        return jsonify({"error": "unknown session"}), 400
    if not resp.is_test and resp.status in ("complete", "screened_out"):
        return jsonify({"error": "This response is already complete.", "completed": True}), 409
    require_consent(resp)
    resp.persist(body)
    seconds = float(body.get("elapsed_seconds") or 0)
    resp.complete(seconds)
    cfg = response_cfg(resp, Study.get_by_id(resp.study_id).cfg)
    return jsonify({"ok": True, "respondent_code": resp.code,
                    **qc_flags(resp.answers(), seconds, cfg)})


@bp.post("/api/check_text")
def check_text():
    """Live AI-generated / pasted answer check for one free-text box.

    Called by the survey while the respondent is still typing, so the warning - and any
    request to confirm the answer is their own - happens before the answer is locked in.
    The very same scoring runs again server-side on submit and in the Admin review queue,
    so a client that never calls this endpoint cannot hide anything.
    """
    body = json_body()
    qid = str(body.get("qid") or "")[:40]
    # the answer item this box writes to: "_" for a question's own box, "<row>_<col>" for a
    # text-grid cell, "_comment" / "c_<row>" for a comment, "other_text" for a "please specify"
    item = str(body.get("item") or MAIN_ITEM)[:60]
    text = str(body.get("text") or "")[:MAX_TEXT]
    meta = body.get("meta") if isinstance(body.get("meta"), dict) else None
    study = Study.get(body.get("study") or "beacon") or Study.get("beacon")
    cfg = study.cfg if study else {}
    settings = ai_settings(cfg, qid, item)
    res = score_text(text, meta, settings)
    return jsonify({"ok": True, "qid": qid, "item": item, "field": field_key(qid, item),
                    "enabled": settings.get("enabled", True),
                    "action": settings.get("action", "confirm"),
                    "warn_at": settings.get("warn_at"), "flag_at": settings.get("flag_at"),
                    **res})


@bp.get("/api/progress")
def progress():
    resp = Respondent.by_session(request.args.get("sid"))
    return jsonify(resp.progress() if resp else {"exists": False})


@bp.post("/api/voice")
def voice():
    body = json_body()
    qid = str(body.get("qid") or "")
    item = str(body.get("item") or "")
    ext = str(body.get("ext") or "webm").lower()
    if ext not in ("webm", "mp4", "ogg", "opus", "m4a"):
        return jsonify({"error": "unsupported format"}), 400
    if not re.fullmatch(r"[A-Za-z0-9]+", qid):
        return jsonify({"error": "bad question id"}), 400
    if item and not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", item):
        return jsonify({"error": "bad answer field"}), 400
    try:
        raw = base64.b64decode(body.get("data") or "", validate=True)
    except (ValueError, TypeError):
        return jsonify({"error": "bad audio payload"}), 400
    if not raw or len(raw) > 2_500_000:
        return jsonify({"error": "audio too large"}), 400
    resp = Respondent.by_session(body.get("session_id"))
    if resp is None:
        return jsonify({"error": "unknown session"}), 400
    require_consent(resp)
    voice_dir = current_app.config["VOICE_DIR"]
    os.makedirs(voice_dir, exist_ok=True)
    fname = resp.voice_filename(qid, ext, item or None)
    with open(os.path.join(voice_dir, fname), "wb") as f:
        f.write(raw)
    return jsonify({"ok": True, "file": fname})


def require_consent(resp):
    row = get_db().execute('SELECT cfg,consent_at FROM response_versions WHERE respondent_id=?', (resp.id,)).fetchone()
    if row and json.loads(row['cfg']).get('require_consent') and not row['consent_at']:
        abort(403, 'Consent is required before submitting answers.')


@bp.post('/api/consent')
def consent():
    body = json_body()
    resp = Respondent.by_session(body.get('session_id'))
    if not resp:
        abort(400, 'Unknown session.')
    if body.get('accepted') is not True:
        abort(400, 'An affirmative consent choice is required.')
    cfg = response_cfg(resp, {})
    db = get_db()
    with db:
        db.execute("UPDATE response_versions SET consent=?,consent_at=? WHERE respondent_id=? AND consent_at=''",
                   (json.dumps({'statement': cfg.get('consent_statement', ''), 'privacy_notice': cfg.get('privacy_notice', ''), 'version': fingerprint(cfg)}), now(), resp.id))
    return jsonify(ok=True)
