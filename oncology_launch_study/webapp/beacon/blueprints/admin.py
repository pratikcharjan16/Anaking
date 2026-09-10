"""Admin dashboard, live data feed, exports and resets (token protected)."""

from __future__ import annotations

import csv
import io
import json
import os
import time

from flask import (Blueprint, Response, current_app, jsonify, render_template, request,
                   send_from_directory)

from ..auth import admin_required
from ..qc import qc_flags
from ..reporting import build_sheets
from .. import services, xlsx_export

bp = Blueprint("admin", __name__)


def _study() -> str:
    return request.args.get("study") or "beacon"


def _scope(default="all") -> str:
    return request.args.get("scope") or default


def _stamp() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


@bp.get("/admin")
@admin_required("text")
def page():
    return render_template("admin.html")


@bp.get("/api/admin/data")
@admin_required()
def data():
    slug, scope = _study(), _scope()
    cfg = services.cfg_of(slug)
    records = services.records_for(slug, scope)
    complete = [r for r in records if r["status"] == "complete"]
    screened = [r for r in records if r["status"] == "screened_out"]
    in_prog = [r for r in records if r["status"] == "in_progress"]

    def flags(r):
        return qc_flags(r["answers"], r["elapsed_seconds"] or 0, cfg,
                        r["status"] or "complete")["flags"]

    flagged = [{"code": r["respondent_code"], "flags": flags(r)} for r in complete if flags(r)]
    divisions, settings = {}, {}
    for r in complete:
        d = r["flat"].get("census_division") or "(unset)"
        s = r["flat"].get("practice_setting_group") or "(unset)"
        divisions[d] = divisions.get(d, 0) + 1
        settings[s] = settings.get(s, 0) + 1
    metrics = cfg.get("metrics") or {}
    intent_q, pct_q = metrics.get("intent_q"), metrics.get("pct_q")
    intent = [float(r["answers"].get(intent_q, {}).get("_") or 0) for r in complete] \
        if intent_q else []
    pct = [float(r["answers"].get(pct_q, {}).get("_") or 0) for r in complete] if pct_q else []
    recent = [{
        "code": r["respondent_code"], "is_test": bool(r["is_test"]), "status": r["status"],
        "started_at": r["started_at"], "completed_at": r["completed_at"],
        "minutes": round((r["elapsed_seconds"] or 0) / 60, 1),
        "screen_out": r["screen_out_at"] or "", "flags": flags(r),
    } for r in records[-25:]][::-1]
    return jsonify({
        "study": slug, "scope": scope,
        "generated": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()) + " UTC",
        "counts": {"total": len(records), "complete": len(complete),
                   "screened_out": len(screened), "in_progress": len(in_prog)},
        "quota": {"census_division": divisions, "practice_setting": settings},
        "headlines": {
            "top2box_intent_pct": round(100 * sum(1 for v in intent if v >= 4) / len(intent), 1)
            if intent else None,
            "mean_pct_eligible": round(sum(pct) / len(pct), 1) if pct else None,
            "mean_minutes": round(sum(r["elapsed_seconds"] or 0 for r in complete) / 60 /
                                  len(complete), 1) if complete else None},
        "qc_flagged": flagged, "recent": recent,
        "conjoint": {"n_tasks": (cfg.get("conjoint") or {}).get("n_tasks", 0)},
        "token": current_app.config["ADMIN_TOKEN"],
    })


@bp.post("/admin/reset")
@admin_required()
def reset():
    slug, scope = _study(), _scope("test")
    try:
        n = services.reset_respondents(slug, scope)
    except services.StudyError as e:
        return jsonify({"error": e.message}), e.status
    return jsonify({"ok": True, "scope": scope, "study": slug, "deleted_respondents": n})


# ---------------------------------------------------------------- exports
def _attachment(data: bytes, mimetype: str, filename: str, extra: dict | None = None):
    headers = {"Content-Disposition": f"attachment; filename={filename}",
               "Cache-Control": "no-store"}
    headers.update(extra or {})
    return Response(data, mimetype=mimetype, headers=headers)


@bp.get("/admin/export.xlsx")
@admin_required("text")
def export_xlsx():
    slug, scope = _study(), _scope()
    records = services.records_for(slug, scope)
    data, backend = xlsx_export.build_workbook(build_sheets(records, scope,
                                                            services.cfg_of(slug)))
    return _attachment(
        data, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        f"{slug}_responses_{scope}_{_stamp()}.xlsx", {"X-Export-Backend": backend})


@bp.get("/admin/export.csv")
@admin_required("text")
def export_csv():
    slug, scope = _study(), _scope()
    flat = [r["flat"] for r in services.records_for(slug, scope)]
    if not flat:
        return Response("respondent_code\n", mimetype="text/csv")
    cols = list(flat[0].keys())
    for f in flat:
        for k in f:
            if k not in cols:
                cols.append(k)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    w.writerows(flat)
    return _attachment(buf.getvalue().encode(), "text/csv; charset=utf-8",
                       f"{slug}_responses_{scope}_{_stamp()}.csv")


@bp.get("/admin/export.json")
@admin_required("text")
def export_json():
    slug, scope = _study(), _scope()
    out = [{k: v for k, v in r.items() if k != "flat"}
           for r in services.records_for(slug, scope)]
    return _attachment(json.dumps(out, indent=2).encode(), "application/json; charset=utf-8",
                       f"{slug}_responses_{scope}_{_stamp()}.json")


@bp.get("/admin/voice/<path:name>")
@admin_required("text")
def voice(name):
    name = os.path.basename(name)
    ctype = ("audio/mp4" if name.endswith((".m4a", ".mp4"))
             else "audio/ogg" if name.endswith((".ogg", ".opus")) else "audio/webm")
    return send_from_directory(current_app.config["VOICE_DIR"], name, mimetype=ctype,
                               conditional=True)
