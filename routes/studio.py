"""
STUDIO  -  the survey builder.

Page
    GET  /studio/                          builder UI

API (used by static/js/studio.js)
    GET  /api/studio/list                  all studies with respondent counts
    GET  /api/studio/study?slug=           one study incl. config
    GET  /api/studio/analysis?study=       quick analysis aggregates
    GET  /api/studio/delta-source?study=&q=  what a source question was answered with,
                                             for a Delta to carry forward as reference
    POST /api/studio/save                  create or update {slug?, title, cfg}
    POST /api/studio/status                {slug, status: draft|live|paused|closed}
    POST /api/studio/delete                {slug}
    POST /api/studio/duplicate             {slug} -> {slug, title}   (a full copy, as a draft)
    POST /api/studio/launch                {slug, recipients, subject?, message?} -> invite summary
    POST /api/studio/pause                 {slug}   (new starts stop, in-progress carry on)
    POST /api/studio/relaunch              {slug}
    POST /api/studio/remind                {slug, subject?, message?} -> reminder summary
    GET  /api/studio/invites?study=        recipients, outbox and what is still pending
    GET  /api/studio/invites.csv?study=    the outbox as a download
    POST /api/studio/make_conjoint         {attributes, n_tasks, seed} -> design
    POST /api/studio/narration?study=      multipart upload of a scene clip -> {clip, src, seconds}
    POST /api/studio/narration/delete      {study, clip}
    POST /api/studio/walkthrough/ppt?study=  multipart .pptx -> one narrated step per slide
    POST /api/studio/media?study=<slug>    multipart image/video attached to a question
    GET  /media/<slug>/<file>              public: respondents load attachments here
    GET  /narration/<study>/<file>         serves an uploaded clip (public - respondents play it)
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import urllib.request
import zipfile
from io import BytesIO
from xml.etree import ElementTree

from datetime import datetime

from flask import Blueprint, abort, current_app, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename

from core.conjoint import make_conjoint
from core import mailer
from core.i18n import (LANGUAGES, coverage, default_language, extract_strings,
                       valid_language)
LANGUAGES_MAP = {c: {"name": n, "native": nv, "dir": d} for c, n, nv, d in LANGUAGES}
from core.narration import clip_duration
from core.outline import build_outline
from core.questionnaire_docx import build_questionnaire_docx
from core.research_agent import (build_from_brief, build_from_document, build_model_prompt,
                                 parse_model_json, refine_questionnaire,
                                 validate_model_questionnaire)
from core.reporting import (analysis_for, delta_source_columns, delta_source_rows,
                             delta_source_values)
from core.translator import TranslationError, translate_string
from core.translator import status as translator_status
from core.walkthrough import DECK_MAX_BYTES, DeckError, steps_from_pptx
from models import Respondent, Study, StudyError, get_db

AUDIO_EXT = {"mp3": "audio/mpeg", "m4a": "audio/mp4", "mp4": "audio/mp4",
             "ogg": "audio/ogg", "opus": "audio/ogg", "wav": "audio/wav", "webm": "audio/webm"}

from .helpers import attachment, error, json_body, records, study_arg, stamp

MAX_STUDIO_SOURCE_CHARS = 1_000_000
bp = Blueprint("studio", __name__)


@bp.get("/studio/")
def page():
    return render_template("studio/studio.html",
                           research_agent_model=bool(current_app.config.get("LOCAL_AI_URL") and current_app.config.get("LOCAL_AI_MODEL")),
                           research_agent_model_name=current_app.config.get("LOCAL_AI_MODEL") or "")


def _actor_is_admin() -> bool:
    from flask import g
    u = getattr(g, "user", None)
    if u and u.get("role") == "admin":
        return True
    st = getattr(g, "staff", None)
    if st and st.get("role") == "owner":
        return True
    return False


@bp.get("/api/studio/list")
def list_studies():
    from flask import g
    from core.security import allowed
    from core.kart import can_collaborate, study_collaborators
    u = getattr(g, "user", None)
    uid = u["id"] if u else 0
    uemail = u.get("email", "") if u else ""
    out = []
    for s in Study.list_with_counts():
        if not allowed(s["slug"]):
            continue
        is_shared = bool(uid and s["owner_id"] != uid and can_collaborate(uid, s["slug"], uemail))
        s["is_shared"] = is_shared
        s["points_debited"] = 0 if is_shared else s.get("points_used", 0)
        s["collaborators"] = study_collaborators(s["slug"])
        out.append(s)
    return jsonify(out)


@bp.get("/api/studio/study")
def get_study():
    from flask import g
    from core.kart import can_collaborate, study_points, study_points_breakdown, study_collaborators, list_workspace_changelogs
    study = Study.get(request.args.get("slug") or "")
    if not study:
        return jsonify({"error": "unknown study"}), 404
    u = getattr(g, "user", None)
    uid = u["id"] if u else 0
    user_email = u.get("email", "") if u else ""
    is_shared = bool(uid and study.owner_id != uid and can_collaborate(uid, study.slug, user_email))
    owner_row = get_db().execute("SELECT email, name FROM users WHERE id=?", (study.owner_id,)).fetchone()
    owner_email = owner_row["email"] if owner_row else ""
    owner_name = (owner_row["name"] or owner_email) if owner_row else "Creator"
    return jsonify({"slug": study.slug, "title": study.title, "status": study.status,
                    "cfg": study.cfg, "updated_at": study.updated_at,
                    "owner_id": study.owner_id,
                    "is_shared": is_shared,
                    "points_used": study_points(study.cfg),
                    "points_debited": 0 if is_shared else study_points(study.cfg),
                    "points_breakdown": study_points_breakdown(study.cfg),
                    "owner_email": owner_email,
                    "owner_name": owner_name,
                    "collaborators": study_collaborators(study.slug),
                    "changelogs": list_workspace_changelogs(
                        study_slug=study.slug, user_id=uid, user_email=user_email, limit=20)})


@bp.get("/api/studio/delta-source")
def delta_source():
    """What a source question has actually been answered with, for a Delta to carry forward.

    The Delta editor asks for this the moment an author picks a source question, so the
    reference cells are filled from the data rather than typed by hand.  A question nobody
    has answered yet - or one whose answers are not numbers - comes back with no values,
    and the editor says so instead of showing a blank it cannot explain.
    """
    slug = study_arg()
    qid = str(request.args.get("q") or "")
    cfg = Study.cfg_of(slug)
    q = next((x for x in cfg.get("questions", []) if str(x.get("id")) == qid), None)
    if q is None:
        return jsonify({"error": "Unknown question " + qid}), 404
    data = records(slug, "all")
    vals = delta_source_values(data, q)
    return jsonify({
        "qid": q["id"],
        "type": q.get("type"),
        "n": vals["n"],
        "numeric": vals["numeric"],
        "rows": vals["rows"],
        "cols": vals["cols"],
        "cells": vals["cells"],
        "columns": [{"code": str(c.get("code")), "label": c.get("label") or ""}
                    for c in delta_source_columns(q)],
        "row_list": [{"code": str(r.get("code")), "label": r.get("label") or ""}
                     for r in delta_source_rows(q)],
    })


@bp.get("/api/studio/analysis")
def analysis():
    slug = study_arg()
    s = Study.get(slug)
    cfg = Study.cfg_of(slug)
    real_recs = records(slug, "real")
    test_recs = records(slug, "test")
    all_recs = records(slug, "all")

    req_scope = request.args.get("scope")
    if req_scope in ("real", "test", "all"):
        scope = req_scope
    else:
        scope = "real" if real_recs else ("all" if test_recs else "real")

    data = records(slug, scope)
    cut_q = request.args.get("cut_q")
    cut_v1 = request.args.get("cut_v1")
    cut_v2 = request.args.get("cut_v2")
    alpha = float(request.args.get("alpha", 0.05))
    from core.datacut import analyze_with_datacut
    res = analyze_with_datacut(data, cfg, cut_q_id=cut_q, cut_v1=cut_v1, cut_v2=cut_v2, alpha=alpha)
    res["scope"] = scope
    res["real_n"] = sum(1 for r in real_recs if r.get("status") == "complete")
    res["test_n"] = sum(1 for r in test_recs if r.get("status") == "complete")
    res["total_n"] = sum(1 for r in all_recs if r.get("status") == "complete")
    legacy = analysis_for(data, cfg)
    for k, v in legacy.items():
        if k not in res:
            res[k] = v
    return jsonify(res)


@bp.get("/api/studio/quotas")
def quotas_state():
    """Live quota fill for the Studio's Quota tab.

    Counts completed responses against the study's configured quota cells and
    returns, per cell, how many completes it has, whether it is full (the team
    should stop sharing new respondent links for that option) and which responses
    arrived over quota (saved as "Quota Full" in the data extract).
    """
    slug = request.args.get("slug") or ""
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    rows = []
    for r in Respondent.for_study(study.id, "all"):
        rows.append({"id": r["id"], "respondent_code": r["respondent_code"],
                     "is_test": bool(r["is_test"]), "status": r["status"],
                     "completed_at": r["completed_at"], "answers": Respondent(r).answers()})
    from core.quotas import state as quota_state
    out = quota_state(study.cfg, rows)
    out["slug"] = slug
    return jsonify(out)


@bp.post("/api/studio/save")
def save():
    try:
        from flask import g
        u = getattr(g, "user", None)
        owner = (u or {}).get("id")
        slug = Study.save(json_body(), owner_id=owner, actor_is_admin=_actor_is_admin())
        resp = {"ok": True, "slug": slug}
        if owner:
            from core.kart import user_kart_summary
            resp["kart"] = user_kart_summary(owner)
        return jsonify(resp)
    except StudyError as e:
        return error(e)


def _read_source_document(upload):
    """Read the text content of a DOCX/TXT/MD/CSV without trusting document paths."""
    if not upload or not upload.filename:
        return None, None, "Choose a questionnaire or brief to upload."
    name = secure_filename(upload.filename)
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    raw = upload.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        return None, None, "The document must be smaller than 8 MB."
    try:
        if ext in ("txt", "md", "csv"):
            try:
                text = raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = raw.decode("utf-16", errors="replace")
        elif ext == "docx":
            with zipfile.ZipFile(BytesIO(raw)) as doc:
                info = doc.getinfo("word/document.xml")
                if info.file_size > 30 * 1024 * 1024:
                    return None, None, "The uncompressed Word document is too large to safely import."
                xml = doc.read("word/document.xml")
            root = ElementTree.fromstring(xml)
            paragraphs = []
            for paragraph in root.iter():
                if not paragraph.tag.endswith("}p"):
                    continue
                parts = []
                for node in paragraph.iter():
                    if node.tag.endswith("}t"):
                        parts.append(node.text or "")
                    elif node.tag.endswith("}tab") or node.tag.endswith("}br"):
                        parts.append(" ")
                line = "".join(parts).strip()
                if line:
                    paragraphs.append(line)
            text = "\n".join(paragraphs)
        else:
            return None, None, "Use a DOCX, TXT, MD or CSV file. Save older .DOC files as .DOCX first."
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError, OSError):
        return None, None, "That document could not be read. Check that it is a valid DOCX, TXT, MD or CSV file."
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        return None, None, "The document appears to be empty or contains no readable text."
    if len(text) > MAX_STUDIO_SOURCE_CHARS:
        return None, None, "The extracted text exceeds the 1,000,000-character import limit. Split it into smaller source documents so no questions are omitted."
    return name, text, None


@bp.post("/api/studio/import-document")
def import_document():
    """Extract source text from DOCX, TXT, MD or CSV for the research-design workflow."""
    name, text, err = _read_source_document(request.files.get("file"))
    if err:
        status_code = 413 if any(marker in err for marker in ("8 MB", "character import limit", "uncompressed Word")) else 400
        return jsonify({"error": err}), status_code
    return jsonify({"ok": True, "filename": name, "text": text})


def _agent_model_available() -> bool:
    return bool(current_app.config.get("LOCAL_AI_URL") and current_app.config.get("LOCAL_AI_MODEL"))


def _call_local_research_model(prompt: str) -> dict:
    """Call the server-configured local Ollama-compatible model; never accept a URL from a user."""
    url = str(current_app.config.get("LOCAL_AI_URL") or "").strip()
    model = str(current_app.config.get("LOCAL_AI_MODEL") or "").strip()
    if not url or not model:
        raise RuntimeError("No local research model is configured.")
    payload = {"model": model, "stream": False, "format": "json", "prompt": prompt}
    req = urllib.request.Request(url.rstrip("/") + "/api/generate", data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as response:
        result = json.loads(response.read(2_000_000))
    text = result.get("response")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("The configured research model returned an empty response.")
    return parse_model_json(text)


def _agent_new_slug(title: str) -> str:
    base = re.sub(r"[^a-z0-9-]+", "-", (title or "research-study").lower()).strip("-")[:32] or "research-study"
    if len(base) < 2:
        base = "research-study"
    slug = base
    n = 2
    while Study.get(slug):
        suffix = "-" + str(n)
        slug = base[:40 - len(suffix)] + suffix
        n += 1
    return slug


def _agent_summary(cfg: dict) -> dict:
    questions = cfg.get("questions") or []
    screen_sections = {str(s.get("id")) for s in (cfg.get("sections") or [])
                       if any(x in str(s.get("title") or "").lower() for x in ("screen", "eligib", "qualif"))}
    return {
        "questions": len(questions),
        "screeners": sum(1 for q in questions if str(q.get("section")) in screen_sections),
        "main": sum(1 for q in questions if str(q.get("section")) not in screen_sections),
        "show_if": sum(1 for q in questions if (q.get("show_if") or {}).get("rules")),
        "screening_rules": sum(len((q.get("screening") or {}).get("rules") or []) for q in questions),
        "types": sorted({str(q.get("type") or "") for q in questions}),
        "notes": cfg.get("design_notes") or [],
    }


def _agent_payload(slug: str, session: dict | None = None) -> dict:
    study = Study.get(slug)
    if not study:
        return {"error": "unknown study"}
    session = session or Study.agent_session(slug) or {"messages": [], "memory": {}}
    memory = dict(session.get("memory") or {})
    memory.pop("source_text", None)  # keep the original upload server-side; the UI needs only project notes
    return {"ok": True, "slug": slug, "title": study.title, "cfg": study.cfg,
            "messages": session.get("messages") or [], "memory": memory,
            "summary": _agent_summary(study.cfg), "model_available": _agent_model_available(),
            "model_name": current_app.config.get("LOCAL_AI_MODEL") if _agent_model_available() else ""}


def _message(role: str, content: str, **extra) -> dict:
    from datetime import datetime, timezone
    return {"role": role, "content": str(content or "")[:12000],
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **extra}


@bp.post("/api/studio/agent/start")
def agent_start():
    """Create a draft questionnaire and save its design conversation against the study."""
    body = json_body()
    title = str(body.get("title") or "New research study").strip()[:120]
    brief = str(body.get("brief") or "").strip()[:10000]
    audience = str(body.get("audience") or "").strip()[:2000]
    market = str(body.get("market") or "").strip()[:1000]
    source_text = str(body.get("source_text") or "").strip()
    if len(source_text) > MAX_STUDIO_SOURCE_CHARS:
        return jsonify({"error": "The extracted text exceeds the 1,000,000-character import limit. Split it into smaller source documents so no questions are omitted."}), 413
    source_filename = secure_filename(str(body.get("source_filename") or "")[:180])
    mode = str(body.get("mode") or "agent")
    if mode not in ("agent", "upload", "draft"):
        mode = "agent"
    if not brief and not source_text:
        return jsonify({"error": "Describe the research objective or upload a brief/questionnaire to begin."}), 400

    warnings = []
    imported = {"found": 0, "imported": 0, "warnings": [], "source_kind": "brief"}
    model_used = False
    cfg = None
    assistant_text = ""
    allow_model = _agent_model_available() and body.get("model_consent") is True
    if mode in ("upload", "draft"):
        cfg, imported = build_from_document(title, source_text, brief, audience, market, source_filename)
        warnings = list(imported.get("warnings") or [])
        if mode == "draft" and imported.get("source_kind") != "questionnaire":
            return jsonify({"error": "No questionnaire questions were identified in that file. Use Draft survey with an existing questionnaire, or choose Upload a document for a research brief."}), 400
        if imported.get("source_kind") == "questionnaire":
            if mode == "draft":
                assistant_text = (f"I created a Studio survey draft from {imported['imported']} question(s) in {source_filename or 'your questionnaire'}. "
                                  "Each question and answer list was mapped to a supported Studio question type; authored wording and order are retained, and recognizable routing or screening is kept. "
                                  "No eligibility rules were invented. The project is open in Studio for review and editing.")
            else:
                assistant_text = (f"I converted **{imported['imported']} question(s)** from {source_filename or 'your document'} into the Studio format. "
                                  "The question wording and order are retained, answer lists are mapped to supported Studio question types, and any recognizable show-if or screening logic is kept. "
                                  "No eligibility rules were invented. Review the question-by-question preview and tell me if you want any changes.")
        else:
            assistant_text = ("I read the uploaded file as a research brief, not as a questionnaire, and created an editable first draft from its objectives. "
                              "The draft includes an eligibility/relationship section and a main questionnaire. Please review it and tell me what to adjust.")
    elif allow_model:
        try:
            candidate = _call_local_research_model(build_model_prompt(
                "Design a new questionnaire", title, brief, audience, market,
                source_text=source_text))
            cfg, warnings = validate_model_questionnaire(candidate, title, brief, audience, market, source_filename)
            model_used = True
            assistant_text = str(candidate.get("assistant_message") or "I drafted a questionnaire from your research objectives. Review the question-by-question version and tell me what you would like changed.")[:4000]
        except Exception:
            warnings.append("The configured local model did not return a valid questionnaire; a conservative guided draft was created instead.")
    if cfg is None:
        cfg = build_from_brief(title, brief or source_text[:10000], audience, market, source_filename)
        if source_text:
            cfg["research_source_text"] = source_text
        if not assistant_text:
            assistant_text = ("I created a structured first draft from your objectives. It starts with respondent eligibility, then moves through recent behaviour, decision drivers and an open response. "
                              "I avoided applying any screen-out rule unless you supplied a target criterion. Review the question-by-question preview and tell me what you would like changed.")

    cfg["title"] = title
    cfg["group_name"] = str(body.get("group_name") or "").strip()[:120]
    parent = str(body.get("parent_study") or "").strip().upper()
    if parent:
        cfg["parent_study"] = parent[:40]
    cfg["creation_mode"] = mode
    cfg["ai_assistant"] = True
    cfg.setdefault("research_agent", {})
    cfg["research_agent"].update({"version": 1, "mode": "local-model" if model_used else (mode if mode in ("upload", "draft") else "guided"),
                                  "source_filename": source_filename})
    if warnings:
        cfg["design_notes"] = list(dict.fromkeys(list(cfg.get("design_notes") or []) + warnings))
    slug = _agent_new_slug(title)
    try:
        from flask import g
        owner = (getattr(g, "user", None) or {}).get("id")
        Study.save({"slug": slug, "title": title, "cfg": cfg}, owner_id=owner, actor_is_admin=_actor_is_admin())
    except StudyError as exc:
        return error(exc)

    user_text = ("Uploaded document: " + source_filename if source_filename else "Business need: " + brief)
    if brief and source_filename:
        user_text += "\nAdditional focus: " + brief
    if audience:
        user_text += "\nTarget respondents: " + audience
    if market:
        user_text += "\nMarket / geography: " + market
    if not user_text.strip():
        user_text = "Create an editable questionnaire from the supplied research material."
    messages = [_message("user", user_text, attachment=source_filename or None),
                _message("assistant", assistant_text, kind="questionnaire_draft")]
    memory = {"brief": brief or cfg.get("research_brief", ""), "audience": audience,
              "market": market, "source_filename": source_filename,
              "source_text": source_text, "model_consent": bool(allow_model),
              "design_notes": cfg.get("design_notes") or []}
    Study.save_agent_session(slug, messages, memory)
    return jsonify(_agent_payload(slug, {"messages": messages, "memory": memory}))


@bp.get("/api/studio/agent")
def agent_get():
    slug = request.args.get("study") or request.args.get("slug") or ""
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    session = Study.agent_session(slug)
    if not session:
        memory = {"brief": study.cfg.get("research_brief", ""),
                  "audience": study.cfg.get("research_audience", ""),
                  "market": study.cfg.get("research_market", ""),
                  "source_filename": (study.cfg.get("research_agent") or {}).get("source_filename", ""),
                  "source_text": study.cfg.get("research_source_text", ""), "design_notes": study.cfg.get("design_notes") or []}
        intro = (f"I have loaded the saved questionnaire for {study.title} ({len(study.cfg.get('questions') or [])} questions). "
                 "I will use this draft and the study context as memory, so you do not need to explain it again. Name a question ID, ask for a routing change, or upload an edited DOCX/TXT/MD/CSV questionnaire.")
        session = {"messages": [_message("assistant", intro)], "memory": memory}
        Study.save_agent_session(slug, session["messages"], memory)
    return jsonify(_agent_payload(slug, session))


@bp.post("/api/studio/agent/turn")
def agent_turn():
    """Revise the saved questionnaire, retain context, and append the full chat turn."""
    is_multipart = request.mimetype == "multipart/form-data"
    body = request.form if is_multipart else json_body()
    slug = str(body.get("slug") or "").strip()
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    message_text = str(body.get("message") or "").strip()[:4000]
    attachment_name, attachment_text = "", ""
    upload = request.files.get("file") if is_multipart else None
    if upload and upload.filename:
        attachment_name, attachment_text, doc_error = _read_source_document(upload)
        if doc_error:
            status_code = 413 if any(marker in doc_error for marker in ("8 MB", "character import limit", "uncompressed Word")) else 400
            return jsonify({"error": doc_error}), status_code
        if not message_text:
            message_text = "Please review this uploaded questionnaire, preserve every identified question, and update my editable Studio draft from it."
    if not message_text:
        return jsonify({"error": "Write a change request or upload an edited questionnaire."}), 400

    session = Study.agent_session(slug) or {"messages": [], "memory": {}}
    messages = session.get("messages") or []
    memory = session.get("memory") or {}
    user_entry = _message("user", message_text, attachment=attachment_name or None)
    if attachment_text:
        user_entry["document_characters"] = len(attachment_text)
    messages.append(user_entry)

    use_model = str(body.get("use_model") or "").lower() in ("1", "true", "on", "yes")
    consent = str(body.get("model_consent") or "").lower() in ("1", "true", "on", "yes")
    cfg = study.cfg
    assistant_text = ""
    warnings: list[str] = []
    revised = None
    if not attachment_text and use_model and consent and _agent_model_available():
        try:
            candidate = _call_local_research_model(build_model_prompt(
                "Revise the current questionnaire according to the user request; preserve approved content that is not being changed.",
                study.title, str(memory.get("brief") or cfg.get("research_brief") or ""),
                str(memory.get("audience") or cfg.get("research_audience") or ""),
                str(memory.get("market") or cfg.get("research_market") or ""),
                current_cfg=cfg, history=messages, instruction=message_text,
                source_text=str(memory.get("source_text") or "")))
            revised, warnings = validate_model_questionnaire(
                candidate, study.title, str(memory.get("brief") or cfg.get("research_brief") or ""),
                str(memory.get("audience") or cfg.get("research_audience") or ""),
                str(memory.get("market") or cfg.get("research_market") or ""),
                str(memory.get("source_filename") or ""))
            # Preserve project-level configuration not owned by the model.
            for key in ("group_name", "parent_study", "creation_mode", "ai_assistant", "welcome_title",
                        "welcome_text", "thanks_title", "thanks_text", "privacy_notice", "consent_statement"):
                if key in cfg:
                    revised[key] = cfg[key]
            revised["research_agent"] = dict(cfg.get("research_agent") or {})
            revised["research_agent"].update({"version": 1, "mode": "local-model-revision"})
            assistant_text = str(candidate.get("assistant_message") or "I revised the questionnaire based on your request. Please review the new version before fielding.")[:4000]
        except Exception:
            warnings.append("The configured local model could not safely return an editable questionnaire; I used the saved-context revision tools instead.")

    if revised is None:
        revised, assistant_text, warnings = refine_questionnaire(cfg, message_text, attachment_text, attachment_name)
    if warnings:
        existing_notes = list(revised.get("design_notes") or [])
        revised["design_notes"] = list(dict.fromkeys(existing_notes + warnings))
    if attachment_text:
        memory["source_filename"] = attachment_name
        memory["source_text"] = attachment_text
    if revised.get("research_brief"):
        memory["brief"] = revised["research_brief"]
    if revised.get("research_audience"):
        memory["audience"] = revised["research_audience"]
    if revised.get("research_market"):
        memory["market"] = revised["research_market"]
    memory["design_notes"] = revised.get("design_notes") or []
    if use_model and consent and _agent_model_available():
        memory["model_consent"] = True
    messages.append(_message("assistant", assistant_text, kind="questionnaire_revision" if revised != cfg else "guidance"))
    if revised != cfg:
        try:
            Study.save({"slug": slug, "title": study.title, "cfg": revised}, actor_is_admin=_actor_is_admin())
        except StudyError as exc:
            return error(exc)
    Study.save_agent_session(slug, messages, memory)
    return jsonify(_agent_payload(slug, {"messages": messages, "memory": memory}))


@bp.get("/api/studio/questionnaire.docx")
def questionnaire_docx():
    """Download the current questionnaire in editable Word format, including its routing."""
    slug = request.args.get("study") or ""
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    data = build_questionnaire_docx(_base_of(study))
    filename = f"{study.slug}_questionnaire_{stamp()}.docx"
    return attachment(data,
                      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                      filename)

@bp.post("/api/studio/status")
def status():
    body = json_body()
    try:
        Study.set_status(body.get("slug") or "", body.get("status") or "")
    except StudyError as e:
        return error(e)
    return jsonify({"ok": True})


@bp.post("/api/studio/delete")
def delete():
    slug = json_body().get("slug") or ""
    try:
        Study.delete_with_children(slug)
    except StudyError as e:
        return error(e)
    # uploaded narration clips belong to the study - remove them with it
    for folder in (_narration_dir(secure_filename(slug)), _media_dir(secure_filename(slug))):
        if slug and os.path.isdir(folder):
            shutil.rmtree(folder, ignore_errors=True)
    return jsonify({"ok": True})


MAX_RECIPIENTS = 500          # one launch should not be able to mail a whole country by accident
MAX_REMINDERS = 2             # "Increase Reminders (2 left)" in the reference builder
EMAIL_RE = re.compile(r"^[^@\s,;<>]{1,64}@[^@\s,;<>]{1,190}\.[A-Za-z]{2,}$")


def _recipients(raw) -> tuple[list[dict], list[str]]:
    """Normalise ``["a@x.com, Dr A", {email,name}, …]`` into unique recipients + rejects."""
    out, seen, bad = [], set(), []
    for item in (raw if isinstance(raw, list) else str(raw or "").splitlines()):
        if isinstance(item, dict):
            email, name = str(item.get("email") or ""), str(item.get("name") or "")
        else:
            text = str(item or "").strip()
            email, _, name = text.partition(",")
            email, name = email.strip(), name.strip()
        if not email:
            continue
        if not EMAIL_RE.match(email) or len(email) > 254:
            bad.append(email[:80])
            continue
        key = email.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"email": email, "name": name[:80]})
    return out[:MAX_RECIPIENTS], bad


def _public_link(slug: str, token: str = "", origin: str = "") -> str:
    base = (origin or "").rstrip("/")
    link = f"{base}/survey/{slug}"
    return f"{link}?rid={token}" if token else link


def _send(kind: str, slug: str, study, recipients: list[dict], subject: str, message: str,
          origin: str, tokens: dict | None = None) -> dict:
    """Send (or queue) one mail per recipient and write the outbox. Returns the summary."""
    tokens = tokens or {}
    settings = mailer.smtp_settings()
    subject = subject.strip() or mailer.invite_subject(study.title, kind)
    rows, sent, failed = [], 0, 0
    for r in recipients:
        token = tokens.get(r["email"].lower()) or secrets.token_urlsafe(8)
        link = _public_link(slug, token, origin)
        body = mailer.invite_body(study.title, link, message, kind)
        status, err = "queued", ""
        if settings:
            try:
                mailer.send_mail(r["email"], subject, body, settings)
                status, sent = "sent", sent + 1
            except mailer.MailError as e:
                status, err, failed = "failed", str(e)[:300], failed + 1
        rows.append({"email": r["email"], "name": r.get("name", ""), "kind": kind,
                     "status": status, "error": err, "link": link, "token": token})
    Study.add_invites(slug, rows)
    return {"sent": sent, "failed": failed, "queued": len(rows) - sent - failed,
            "total": len(rows), "smtp": bool(settings)}


def _invite_state(study, rows_only: bool = False) -> dict:
    """Everything the Actions buttons and the Launch/Reminder/Outbox modals need."""
    slug = study.slug
    inv = study.cfg.get("invites") or {}
    done = Study.completed_tokens(slug)
    outbox = Study.invites_of(slug)
    first_invite = {}
    for row in reversed(outbox):                       # oldest invite wins for the token
        if row["kind"] == "invite":
            first_invite.setdefault(row["email"].lower(), row)
    recipients = []
    for r in inv.get("recipients") or []:
        row = first_invite.get(str(r.get("email", "")).lower()) or {}
        token = row.get("token") or ""
        recipients.append({"email": r.get("email", ""), "name": r.get("name", ""),
                           "invited": bool(row), "link": row.get("link") or "",
                           "token": token,          # so a reminder reuses the same personal link
                           "completed": bool(token) and token in done})
    sent = sum(1 for r in outbox if r["status"] == "sent")
    failed = sum(1 for r in outbox if r["status"] == "failed")
    queued = sum(1 for r in outbox if r["status"] == "queued")
    reminders = int(inv.get("reminders") or 0)
    state = {
        "slug": slug, "status": study.status, "title": study.title,
        "link": _public_link(slug, "", request.host_url if request else ""),
        "launched_at": inv.get("launched_at") or "",
        "subject": inv.get("subject") or mailer.invite_subject(study.title),
        "message": inv.get("message") or "",
        "recipients": recipients,
        "outbox": [] if rows_only else outbox,
        "summary": {"recipients": len(recipients), "sent": sent, "failed": failed,
                    "queued": queued, "completed": sum(1 for r in recipients if r["completed"]),
                    "pending": sum(1 for r in recipients if not r["completed"])},
        "reminders_sent": reminders,
        "reminders_left": max(0, MAX_REMINDERS - reminders),
        "max_reminders": MAX_REMINDERS,
        "smtp": mailer.smtp_status(),
    }
    return state


@bp.post("/api/studio/duplicate")
def duplicate():
    slug = json_body().get("slug") or ""
    try:
        from flask import g
        owner = (getattr(g, "user", None) or {}).get("id")
        new_slug = Study.duplicate(slug, owner_id=owner, actor_is_admin=_actor_is_admin())
    except StudyError as e:
        return error(e)
    return jsonify({"ok": True, "slug": new_slug, "title": Study.get(new_slug).title})


# ------------------------------------------------------------------ Collaborative & Respondent Sharing
@bp.get("/api/studio/shares")
def list_study_shares():
    slug = request.args.get("study") or request.args.get("slug") or ""
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    from flask import g
    from core.kart import shares_for_study, list_workspace_changelogs, study_points
    u = getattr(g, "user", None) or {}
    rows = shares_for_study(slug)
    base = request.host_url.rstrip("/")
    for r in rows:
        r["share_url"] = f"{base}/share/{r['token']}"
        r["respondent_url"] = f"{base}/survey/{slug}"
    owner_row = get_db().execute("SELECT email, name FROM users WHERE id=?", (study.owner_id,)).fetchone()
    owner_email = owner_row["email"] if owner_row else ""
    owner_name = (owner_row["name"] or owner_email) if owner_row else "Creator"
    return jsonify({"ok": True, "study": slug, "title": study.title, "shares": rows,
                    "owner_name": owner_name,
                    "owner_email": owner_email,
                    "points_used": study_points(study.cfg),
                    "respondent_url": f"{base}/survey/{slug}",
                    "test_url": f"{base}/survey/{slug}/test",
                    "changelogs": list_workspace_changelogs(
                        study_slug=slug, user_id=u.get("id", 0), user_email=u.get("email", ""), limit=25),
                    "changelog_file_url": f"/api/workspace/changelog.log?study={slug}"})


@bp.post("/api/studio/public-link")
def create_single_use_public_link():
    """Issue a tokenized respondent URL; that URL resumes one session and then closes."""
    from flask import g
    body = json_body()
    slug = str(body.get("slug") or "").strip()
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    user = getattr(g, "user", None) or {}
    from core.security import allowed as study_allowed
    if not study_allowed(slug):
        abort(403, "This project is outside your access scope.")
    token = Study.create_public_survey_link(slug, created_by=user.get("id", 0))
    url = request.host_url.rstrip("/") + f"/survey/{slug}?rid={token}"
    return jsonify({"ok": True, "token": token, "url": url})


@bp.post("/api/studio/share")
def create_study_share():
    from flask import g
    from core.kart import create_share
    from core.security import audit
    body = json_body()
    slug = str(body.get("slug") or body.get("study") or "").strip()
    email = str(body.get("email") or "").strip().lower()
    permission = str(body.get("permission") or "collaborate").strip()
    u = getattr(g, "user", None)
    try:
        share = create_share(slug, shared_by=(u["id"] if u else 0), email=email, permission=permission)
    except StudyError as e:
        return error(e)
    base = request.host_url.rstrip("/")
    share["share_url"] = f"{base}/share/{share['token']}"
    share["respondent_url"] = f"{base}/survey/{slug}"
    share["points_debited"] = 0
    audit("share/create", study=slug, detail=f"{permission} -> {email or 'link'} (0 pts debited)")
    return jsonify({"ok": True, "share": share})


@bp.post("/api/studio/share/revoke")
def revoke_study_share():
    from core.kart import revoke_share
    from core.security import audit
    body = json_body()
    try:
        sid = int(body.get("id") or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "invalid share id"}), 400
    ok = revoke_share(sid)
    audit("share/revoke", study=str(body.get("slug") or ""), detail=f"share_id={sid}")
    return jsonify({"ok": ok})


@bp.get("/api/studio/invites")
def invites():
    study = Study.get(study_arg())
    if not study:
        return jsonify({"error": "unknown study"}), 404
    return jsonify(_invite_state(study))


@bp.get("/api/studio/invites.csv")
def invites_csv():
    """The outbox as a spreadsheet: email, kind, status, link, when."""
    import csv
    from io import StringIO
    slug = study_arg()
    if not Study.get(slug):
        return jsonify({"error": "unknown study"}), 404
    buf = StringIO()
    w = csv.writer(buf)
    w.writerow(["email", "name", "kind", "status", "error", "link", "created_at", "sent_at"])
    for r in Study.invites_of(slug):
        w.writerow([r["email"], r["name"], r["kind"], r["status"], r["error"], r["link"],
                    r["created_at"], r["sent_at"]])
    return attachment(buf.getvalue().encode("utf-8"), "text/csv", f"{slug}-invites.csv")


@bp.post("/api/studio/launch")
def launch():
    """Set the study live, keep the recipient list and send the invites (outbox always)."""
    body = json_body()
    slug = body.get("slug") or ""
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    recipients, bad = _recipients(body.get("recipients"))
    if not recipients and body.get("require_recipients"):
        return jsonify({"error": "Add at least one email address to send invites to."}), 400
    subject = str(body.get("subject") or "")
    message = str(body.get("message") or "")
    cfg = study.cfg
    inv = cfg.get("invites") or {}
    if recipients:
        inv["recipients"] = recipients
    inv["subject"] = subject[:200]
    inv["message"] = message[:4000]
    inv["launched_at"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")   # ISO, so the card can say "just now"
    cfg["invites"] = inv
    # a tracked invite link only counts as completed when the study stores the token
    embedded = cfg.get("embedded") or []
    if recipients and not any(e.get("name") == "rid" for e in embedded):
        embedded.append({"name": "rid"})
        cfg["embedded"] = embedded
    if not body.get("draft_only"):
        study.set_status(slug, "live")
    Study.save({"slug": slug, "title": study.title, "cfg": cfg})
    result = _send("invite", slug, study, inv.get("recipients") or [], subject, message,
                   request.host_url)
    # the full invite state first, then the send summary on top: `smtp` must stay the boolean
    # ("did we really email them?") the buttons read, not the connection details
    out = _invite_state(Study.get(slug))
    out.update({"ok": True, "rejected": bad, "status": out["status"], "link": out["link"],
                "sent": result["sent"], "failed": result["failed"], "queued": result["queued"],
                "total": result["total"], "smtp": result["smtp"]})
    return jsonify(out)


@bp.post("/api/studio/remind")
def remind():
    """Nudge the recipients who have not finished yet (capped, like the reference builder)."""
    body = json_body()
    slug = body.get("slug") or ""
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    state = _invite_state(study)
    if state["reminders_left"] <= 0:
        return jsonify({"error": f"All {MAX_REMINDERS} reminders have already been sent."}), 400
    pending = [r for r in state["recipients"] if not r["completed"]]
    if not pending:
        return jsonify({"error": "Everyone on the list has already taken part."}), 400
    subject = str(body.get("subject") or (study.cfg.get("invites") or {}).get("subject") or "")
    message = str(body.get("message") or (study.cfg.get("invites") or {}).get("message") or "")
    tokens = {r["email"].lower(): r["token"] for r in pending if r.get("token")}
    result = _send("reminder", slug, study, [{"email": r["email"], "name": r["name"]} for r in pending],
                   subject, message, request.host_url, tokens)
    cfg = dict(study.cfg)
    inv = cfg.get("invites") or {}
    inv["reminders"] = int(inv.get("reminders") or 0) + 1
    inv["subject"] = subject[:200]
    inv["message"] = message[:4000]
    cfg["invites"] = inv
    Study.save({"slug": slug, "title": study.title, "cfg": cfg})
    state = _invite_state(Study.get(slug))
    state.update({"ok": True, "reminded": len(pending), "sent": result["sent"],
                  "failed": result["failed"], "queued": result["queued"],
                  "total": result["total"], "smtp": result["smtp"]})
    return jsonify(state)


@bp.post("/api/studio/pause")
def pause():
    """Pause a live study: no new respondents, anyone already answering can still finish."""
    slug = json_body().get("slug") or ""
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    if study.status != "live":
        return jsonify({"error": "Only a live study can be paused."}), 400
    study.set_status(slug, "paused")
    return jsonify({"ok": True, "status": "paused"})


@bp.post("/api/studio/relaunch")
def relaunch():
    slug = json_body().get("slug") or ""
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    if study.status not in ("paused", "closed", "draft"):
        return jsonify({"error": "This study is already live."}), 400
    study.set_status(slug, "live")
    return jsonify({"ok": True, "status": "live", "link": _public_link(slug, "", request.host_url)})


@bp.get("/api/studio/languages")
def languages():
    """The globalisation catalogue: every approved field language."""
    return jsonify({"default": "en-US",
                    "languages": [{"code": c, "name": n, "native": nv, "dir": d}
                                  for c, n, nv, d in LANGUAGES]})


def _base_of(study):
    """The question config a study translates: its own, or its parent's when it is a
    translation child.  Children therefore inherit every parent edit automatically."""
    if study.is_child():
        parent = study.parent_study()
        return parent.cfg if parent else study.cfg
    return study.cfg


@bp.get("/api/studio/children")
def children():
    """The translation children of a parent study."""
    study = Study.get(study_arg())
    if not study:
        return jsonify({"error": "unknown study"}), 404
    return jsonify({"children": [
        {"slug": ch.slug, "language": ch.cfg.get("language"),
         "title": ch.title, "translations": ch.cfg.get("translations") or {},
         "complete": 0} for ch in Study.children_of(study.slug)]})


@bp.post("/api/studio/globalize")
def globalize():
    """Create (or return) the translation child for one language of a parent study."""
    body = json_body()
    parent = Study.get(body.get("slug") or "")
    lang = body.get("lang") or ""
    if not parent or parent.is_child():
        return jsonify({"error": "unknown parent study"}), 404
    if not valid_language(lang) or lang == default_language(parent.cfg):
        return jsonify({"error": "bad language"}), 400
    slug = f"{parent.slug}--{lang.lower()}"
    if Study.get(slug):
        return jsonify({"ok": True, "slug": slug, "existing": True})
    meta = LANGUAGES_MAP.get(lang, {})
    cfg = {"parent": parent.slug, "language": lang,
           "translations": {lang: dict((parent.cfg.get("translations") or {}).get(lang) or {})},
           "title": f"{parent.title} \u2013 {meta.get('native', lang)}"}
    Study.save({"slug": slug, "title": cfg["title"], "cfg": cfg})
    return jsonify({"ok": True, "slug": slug})


@bp.get("/api/studio/strings")
def strings():
    """The respondent-visible strings plus one language's translations, for the
    Globalize panel.  Team-facing text never appears here, so it can't be translated."""
    study = Study.get(study_arg())
    if not study:
        return jsonify({"error": "unknown study"}), 404
    base = _base_of(study)
    lang = request.args.get("lang") or (study.cfg.get("language") if study.is_child() else "") or ""
    strings = extract_strings(base)
    table = (study.cfg.get("translations") or {}).get(lang) or {}
    merged = dict(base)
    merged["translation_excluded"] = study.cfg.get("translation_excluded", {})
    if lang:
        merged["translations"] = {lang: table}
    return jsonify({"strings": strings, "default_language": default_language(base),
                    "language": lang, "translations": table,
                    "excluded": (study.cfg.get("translation_excluded") or {}).get(lang, []),
                    "parent": study.cfg.get("parent") or "",
                    "coverage": coverage(merged, lang) if lang else None,
                    "languages": sorted((study.cfg.get("translations") or {}).keys())})


@bp.post("/api/studio/move")
def move():
    body = json_body()
    old_slug = body.get("slug") or ""
    kids = [ch.slug for ch in Study.children_of(old_slug)]
    try:
        new_slug = Study.move(old_slug, body.get("new_slug") or "")
    except StudyError as e:
        return error(e)
    for kslug in kids:                      # keep translation children attached
        ch = Study.get(kslug)
        ch.cfg["parent"] = new_slug
        Study.save({"slug": ch.slug, "title": ch.title, "cfg": ch.cfg})
    # uploaded media and narration clips are keyed by slug - they travel with the study
    for folder in (_media_dir, _narration_dir):
        src, dst = folder(secure_filename(old_slug)), folder(secure_filename(new_slug))
        if old_slug != new_slug and os.path.isdir(src):
            shutil.move(src, dst)
    return jsonify({"ok": True, "slug": new_slug})


@bp.get("/api/studio/outline.docx")
def outline():
    """Download Word Outline - a client-circulation .docx of the questionnaire."""
    study = Study.get(study_arg())
    if not study:
        return jsonify({"error": "unknown study"}), 404
    lang = request.args.get("lang") or (study.cfg.get("language") if study.is_child() else None)
    data = build_outline(_base_of(study), lang)
    return attachment(data,
                      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                      f"{study.slug}_outline_{lang or default_language(study.cfg)}_{stamp()}.docx")


def _merged_for(study, lang: str) -> dict:
    study = Study.get(study.slug) or study          # re-read: translations may have saved
    base = _base_of(study)
    merged = dict(base)
    merged["translation_excluded"] = study.cfg.get("translation_excluded", {})
    merged["translations"] = {lang: (study.cfg.get("translations") or {}).get(lang) or {}}
    return merged


def _save_translations(slug: str, lang: str, strings: dict) -> None:
    study = Study.get(slug)
    cfg = study.cfg
    table = cfg.setdefault("translations", {}).setdefault(lang, {})
    known = {x["key"] for x in extract_strings(_base_of(study))}
    for key, text in (strings or {}).items():
        if key in known:
            if (text or "").strip():
                table[key] = str(text)[:MAX_TR]
            else:
                table.pop(key, None)
    if not table:
        cfg["translations"].pop(lang, None)
    Study.save({"slug": slug, "title": study.title, "cfg": cfg})


MAX_TR = 4000


@bp.post("/api/studio/translate")
def translate():
    """Manual translation: save respondent-visible strings for one language."""
    body = json_body()
    slug, lang = body.get("slug") or "", body.get("lang") or ""
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    if not valid_language(lang) or lang == default_language(_base_of(study)):
        return jsonify({"error": "bad language"}), 400
    values = body.get("strings") or {}
    excluded = body.get("excluded")
    if not isinstance(values, dict) or any(not isinstance(v, str) for v in values.values()):
        return jsonify({"error": "strings must contain text values"}), 400
    if excluded is not None:
        if not isinstance(excluded, list) or any(not isinstance(k, str) for k in excluded):
            return jsonify({"error": "excluded must be a list of keys"}), 400
        cfg = study.cfg
        known = {x["key"] for x in extract_strings(_base_of(study))}
        cfg.setdefault("translation_excluded", {})[lang] = [k for k in excluded if k in known]
        Study.save({"slug": slug, "title": study.title, "cfg": cfg})
    _save_translations(slug, lang, values)
    return jsonify({"ok": True, "coverage": coverage(_merged_for(study, lang), lang)})


def _translation_source(study) -> str:
    return default_language(_base_of(study))


@bp.get("/api/studio/translate/status")
def translate_status():
    """What the AI-translate button will actually use, plus an optional live probe.

    Hosted deployments are usually the ones where machine translation fails; this
    answers "is the translator reachable from *this* server, and through which
    provider" without editing a survey.
    """
    study = Study.get(study_arg()) if (request.args.get("study") or request.args.get("slug")) else None
    base_lang = _translation_source(study) if study else "en-US"
    probe_lang = request.args.get("lang") or "hi"
    if study and not valid_language(probe_lang):
        probe_lang = "hi"
    probe_text = str(request.args.get("probe") or "").strip()
    out = translator_status(probe_text=probe_text[:200], probe_lang=probe_lang)
    out["source_language"] = base_lang
    out["target_language"] = probe_lang
    if probe_text:
        out["probe"]["text"] = str(out["probe"].get("text") or "")[:200]
    return jsonify(out)


@bp.get("/api/studio/translations.csv")
def translations_csv():
    """The translation table as a spreadsheet - works with any offline translator.

    Columns: key, kind, context, source, translation.  Fill the ``translation``
    column (Excel, Google Sheets, a translation agency) and import the file back;
    the keys never change, so nothing can be applied to the wrong question.
    """
    import csv
    from io import StringIO
    study = Study.get(study_arg())
    if not study:
        return jsonify({"error": "unknown study"}), 404
    lang = request.args.get("lang") or (study.cfg.get("language") if study.is_child() else "")
    if not valid_language(lang):
        return jsonify({"error": "bad language"}), 400
    base = _base_of(study)
    table = (study.cfg.get("translations") or {}).get(lang) or {}
    excluded = set((study.cfg.get("translation_excluded") or {}).get(lang) or [])
    buf = StringIO()
    w = csv.writer(buf)
    w.writerow(["key", "kind", "context", "source", "translation"])
    for x in extract_strings(base):
        ctx = x["key"] if x["kind"] != "chrome" else "interface: " + x["key"].split(":", 1)[1]
        w.writerow([x["key"], x["kind"], ctx, x["text"],
                    "" if x["key"] in excluded else table.get(x["key"], "")])
    data = ("\ufeff" + buf.getvalue()).encode("utf-8")     # BOM: Excel reads Hindi/Devanagari
    return attachment(data, "text/csv; charset=utf-8", f"{study.slug}-{lang}-translations.csv")


@bp.post("/api/studio/translations/import")
def translations_import():
    """Apply a filled-in translation spreadsheet (or explicit rows) to a child survey."""
    if request.files.get("file"):
        raw = request.files["file"].read().decode("utf-8-sig", "replace")
        body = {"csv": raw}
    else:
        body = json_body()
    slug = body.get("slug") or request.args.get("study") or ""
    lang = body.get("lang") or request.args.get("lang") or ""
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    if not valid_language(lang) or lang == default_language(_base_of(study)):
        return jsonify({"error": "bad language"}), 400
    known = {x["key"]: x for x in extract_strings(_base_of(study))}
    values: dict[str, str] = {}
    if isinstance(body.get("rows"), list):
        for row in body["rows"]:
            if isinstance(row, dict) and str(row.get("key") or "") in known:
                values[row["key"]] = str(row.get("translation") or row.get("text") or "")
    elif isinstance(body.get("csv"), str):
        import csv
        from io import StringIO
        reader = csv.reader(StringIO(body["csv"].lstrip("\ufeff")))
        header = next(reader, None)
        if not header:
            return jsonify({"error": "the file is empty"}), 400
        cols = [c.strip().lower() for c in header]
        if "key" not in cols or "translation" not in cols:
            return jsonify({"error": "the first row must contain 'key' and 'translation' columns"}), 400
        ki, ti = cols.index("key"), cols.index("translation")
        for row in reader:
            if len(row) <= max(ki, ti) or not row[ki].strip() in known:
                continue
            values[row[ki].strip()] = row[ti]
    else:
        return jsonify({"error": "send a CSV file, a csv string or a rows list"}), 400
    if not values:
        return jsonify({"error": "no matching translation keys found in the file"}), 400
    _save_translations(slug, lang, values)
    filled = sum(1 for v in values.values() if (v or "").strip())
    merged = _merged_for(Study.get(slug) or study, lang)
    return jsonify({"ok": True, "applied": filled, "keys": len(values),
                    "coverage": coverage(merged, lang)})


@bp.post("/api/studio/autotranslate")
def autotranslate():
    """AI-translate respondent-visible strings that have no manual translation yet.

    Keys may be passed to translate a subset; by default every missing string is done.
    Strings that already have a manual translation are never overwritten.  On a network
    failure each string is reported in ``failed`` and left for manual translation.
    """
    body = json_body()
    slug, lang = body.get("slug") or "", body.get("lang") or ""
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    cfg = study.cfg
    src = default_language(_base_of(study))
    if not valid_language(lang) or lang == src:
        return jsonify({"error": "bad language"}), 400
    from core.translator import providers_for
    chain = providers_for(src, lang)
    # en-US -> en-GB and friends never leave the server: localise_english() rewrites the
    # spelling, so they work even where every network provider is blocked.
    offline_variant = (src.split("-")[0] == lang.split("-")[0] == "en" and src != lang)
    if not chain and not offline_variant:
        return jsonify({"error": "AI translation is switched off on this server",
                        "hint": translator_status()["hint"],
                        "mode": translator_status()["mode"]}), 409
    table = (cfg.get("translations") or {}).get(lang) or {}
    want = body.get("keys")
    if want is not None and (not isinstance(want, list) or any(not isinstance(k, str) for k in want)):
        return jsonify({"error": "keys must be a list"}), 400
    excluded = (cfg.get("translation_excluded") or {}).get(lang, [])
    strings, failed, done, aborted = {}, {}, 0, False
    streak = 0
    for x in extract_strings(_base_of(study)):
        if x["key"] in excluded or (want is not None and x["key"] not in want):
            continue
        if (table.get(x["key"]) or "").strip():
            continue
        html = x["key"].endswith("_html") or bool(re.search(r"<[^>]+>", x["text"]))
        try:
            strings[x["key"]] = translate_string(x["text"], lang, src, html=html)
            done += 1
            streak = 0
        except TranslationError as e:
            failed[x["key"]] = str(e)
            streak += 1
            # A firewall that swallows the request would otherwise make every string
            # wait for its own timeout.  Three failures with no success means the
            # service is unreachable - stop and say so instead of grinding on.
            if not done and streak >= 3:
                aborted = True
                break
        except Exception as e:                 # never 500 mid-batch
            failed[x["key"]] = "translation failed (" + e.__class__.__name__ + ")"
            streak += 1
            if not done and streak >= 3:
                aborted = True
                break
    if strings:
        _save_translations(slug, lang, strings)
    reasons = sorted({str(v) for v in failed.values()})
    return jsonify({"ok": True, "translated": done, "failed": failed, "aborted": aborted,
                    "providers": chain, "reason": reasons[0] if reasons else "",
                    "coverage": coverage(_merged_for(study, lang), lang)})


@bp.post("/api/studio/make_conjoint")
def conjoint():
    """Build a design from the attributes authored on the conjoint question.

    ``n_tasks`` is the number of choice sets and ``n_alts`` the number of cards per set.
    """
    body = json_body()
    n_tasks = max(1, min(60, int(body.get("n_tasks", 9) or 9)))
    n_alts = max(2, min(6, int(body.get("n_alts", 3) or 3)))
    try:
        design = make_conjoint(body.get("attributes", []), n_tasks,
                               int(body.get("seed", 1)), n_alts)
    except (KeyError, ValueError, TypeError, ZeroDivisionError, IndexError) as e:
        return jsonify({"error": str(e)}), 400
    design["generated_at"] = stamp()
    return jsonify(design)


# ---------------------------------------------------------------- walk-through decks
@bp.post("/api/studio/walkthrough/ppt")
def walkthrough_from_ppt():
    """Turn an uploaded PowerPoint deck into narrated walk-through steps.

    One step per slide: the slide title becomes the step label and the slide body plus its
    speaker notes become the narration the respondent hears.  Nothing is stored server-side
    - the author reviews the steps in the Studio and saves them with the question.
    """
    slug = request.args.get("study") or ""
    if not Study.get(slug):
        return jsonify({"error": "unknown study"}), 404
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "no file"}), 400
    if not f.filename.lower().endswith(".pptx"):
        return jsonify({"error": "upload a .pptx deck (PowerPoint 2007 or newer)"}), 400
    data = f.read()
    if len(data) > DECK_MAX_BYTES:
        return jsonify({"error": "deck too large (max %d MB)" % (DECK_MAX_BYTES // (1024 * 1024))}), 400
    try:
        steps = steps_from_pptx(data)
    except DeckError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "steps": steps, "slides": len(steps)})


# ---------------------------------------------------------------- narration clips
def _narration_dir(slug: str) -> str:
    return os.path.join(current_app.config["NARRATION_DIR"], slug)


@bp.post("/api/studio/narration")
def upload_narration():
    slug = request.args.get("study") or ""
    if not Study.get(slug):
        return jsonify({"error": "unknown study"}), 404
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "no file"}), 400
    ext = secure_filename(f.filename).rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in AUDIO_EXT:
        return jsonify({"error": "unsupported audio format (mp3, m4a, ogg, wav, webm)"}), 400
    data = f.read()
    if not data:
        return jsonify({"error": "empty file"}), 400
    if len(data) > current_app.config["NARRATION_MAX_BYTES"]:
        return jsonify({"error": "clip too large (max 8 MB)"}), 400
    clip = "clip_" + secrets.token_hex(4)
    folder = _narration_dir(slug)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{clip}.{ext}")
    with open(path, "wb") as out:
        out.write(data)
    seconds = clip_duration(path)
    return jsonify({"ok": True, "clip": clip, "file": f"{clip}.{ext}",
                    "src": f"/narration/{slug}/{clip}.{ext}", "seconds": seconds,
                    "bytes": len(data)})


@bp.post("/api/studio/narration/delete")
def delete_narration():
    body = json_body()
    slug, clip = str(body.get("study") or ""), str(body.get("clip") or "")
    if not re.fullmatch(r"clip_[0-9a-f]{8}", clip):
        return jsonify({"error": "bad clip id"}), 400
    folder = _narration_dir(slug)
    removed = 0
    if os.path.isdir(folder):
        for name in os.listdir(folder):
            if name.rsplit(".", 1)[0] == clip:
                os.remove(os.path.join(folder, name))
                removed += 1
    return jsonify({"ok": True, "removed": removed})


# ---------------------------------------------------------------- question media
IMAGE_EXT = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
             "webp": "image/webp", "svg": "image/svg+xml"}
VIDEO_EXT = {"mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime"}
# audio shares the media folder with images and video - a row or a column can carry any of them
AUDIO_MEDIA_EXT = {"mp3": "audio/mpeg", "m4a": "audio/mp4", "ogg": "audio/ogg",
                   "opus": "audio/ogg", "wav": "audio/wav", "aac": "audio/aac"}
MEDIA_EXT = dict(IMAGE_EXT, **AUDIO_MEDIA_EXT, **VIDEO_EXT)


def _media_dir(slug: str) -> str:
    return os.path.join(current_app.config["MEDIA_DIR"], slug)


@bp.post("/api/studio/media")
def upload_media():
    slug = request.args.get("study") or ""
    if not Study.get(slug):
        return jsonify({"error": "unknown study"}), 404
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "no file"}), 400
    ext = secure_filename(f.filename).rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in MEDIA_EXT:
        return jsonify({"error": "unsupported file (png, jpg, gif, webp, svg, mp3, wav, m4a, ogg, mp4, webm, mov)"}), 400
    data = f.read()
    if not data:
        return jsonify({"error": "empty file"}), 400
    if len(data) > current_app.config["MEDIA_MAX_BYTES"]:
        return jsonify({"error": "file too large (max 10 MB)"}), 400
    if ext == "svg" and re.search(rb"<script|on[a-z]+\s*=|javascript:", data, re.I):
        return jsonify({"error": "svg contains scripting"}), 400
    name = "m_" + secrets.token_hex(4) + "." + ext
    folder = _media_dir(slug)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, name), "wb") as out:
        out.write(data)
    return jsonify({"ok": True, "file": name, "src": f"/media/{slug}/{name}",
                    "kind": "video" if ext in VIDEO_EXT else "audio" if ext in AUDIO_MEDIA_EXT else "image",
                    "bytes": len(data)})


@bp.post("/api/studio/media/delete")
def delete_media():
    body = json_body()
    slug, name = str(body.get("study") or ""), os.path.basename(str(body.get("file") or ""))
    if not re.fullmatch(r"m_[0-9a-f]{8}\.[a-z0-9]+", name):
        return jsonify({"error": "bad file"}), 400
    path = os.path.join(_media_dir(slug), name)
    if os.path.isfile(path):
        os.remove(path)
        return jsonify({"ok": True, "removed": 1})
    return jsonify({"ok": True, "removed": 0})


@bp.get('/media/<regex("[a-zA-Z0-9\\-]+"):slug>/<path:name>')
def serve_media(slug, name):
    name = os.path.basename(name)
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in MEDIA_EXT:
        abort(404)
    resp = send_from_directory(_media_dir(slug), name, mimetype=MEDIA_EXT[ext], conditional=True)
    if ext == "svg":
        resp.headers["Content-Security-Policy"] = "script-src 'none'"
    return resp


@bp.get('/narration/<regex("[a-zA-Z0-9\\-]+"):slug>/<path:name>')
def serve_narration(slug, name):
    """Uploaded clips are public: respondents' browsers stream them during the walkthrough."""
    name = os.path.basename(name)
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in AUDIO_EXT:
        abort(404)
    return send_from_directory(_narration_dir(slug), name, mimetype=AUDIO_EXT[ext],
                               conditional=True)
