"""Editable, round-trip-friendly Word questionnaire exports for the Studio agent.

This uses a small OOXML package built with the standard library, so deployments do not need
python-docx. Human-readable lines are editable in Word; compact hidden metadata preserves
Studio routing and question settings when that document is uploaded again.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from html import escape
from typing import Any

from core import screening

CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''

RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

OP_WORDS = {
    "selected": "selected", "not_selected": "not selected", "any_of": "one or more of",
    "none_of": "none of", "all_of": "all of", "eq": "equals", "ne": "does not equal",
    "gt": "is greater than", "gte": "is at least", "lt": "is less than", "lte": "is at most",
    "between": "is between", "answered": "was answered", "not_answered": "was not answered",
}


def _clean(value: Any) -> str:
    value = str(value or "")
    return re.sub(r"<[^>]+>", "", value).strip()


def _run(text: str, bold: bool = False, size: int = 21, color: str = "202B36",
         italic: bool = False, hidden: bool = False) -> str:
    props = []
    if bold:
        props.append("<w:b/>")
    if italic:
        props.append("<w:i/>")
    props.append(f'<w:color w:val="{color}"/>')
    props.append(f'<w:sz w:val="{size}"/>')
    if hidden:
        props.append("<w:vanish/>")
    return ("<w:r><w:rPr>" + "".join(props) + "</w:rPr>"
            f'<w:t xml:space="preserve">{escape(str(text or ""))}</w:t></w:r>')


def _paragraph(text: str = "", *, bold: bool = False, size: int = 21, color: str = "202B36",
               italic: bool = False, hidden: bool = False, after: int = 100,
               keep_next: bool = False) -> str:
    ppr = f'<w:spacing w:after="{after}"/>'
    if keep_next:
        ppr += "<w:keepNext/>"
    return f"<w:p><w:pPr>{ppr}</w:pPr>{_run(text, bold, size, color, italic, hidden)}</w:p>"


def _flow_text(q: dict, questions: list[dict]) -> str:
    parts = []
    by_id = {str(item.get("id")): item for item in questions}
    si = q.get("show_if") or {}
    if si.get("off") is not True:
        rules = si.get("rules") or []
        if rules:
            join = " AND " if si.get("match", "all") == "all" else " OR "
            conditions = []
            for rule in rules:
                qid = str(rule.get("q") or "")
                op = str(rule.get("op") or "")
                value = rule.get("value", "")
                prior = by_id.get(qid, {})
                options = prior.get("options") or []
                values = [str(value)] if isinstance(value, (int, float)) else [x.strip() for x in str(value).split(",")]
                labels = [str(option.get("label") or "") for option in options
                          if str(option.get("code")) in values and option.get("label")]
                if labels and op in ("selected", "not_selected", "any_of", "none_of", "all_of"):
                    rendered_value = " / ".join(labels)
                else:
                    rendered_value = str(value)
                conditions.append(f"{qid} {OP_WORDS.get(op, op)} {rendered_value}".strip())
            text = join.join(conditions)
            if si.get("negate"):
                text = "NOT (" + text + ")"
            parts.append("Show only if " + text)
    if q.get("screening"):
        desc = screening.describe(q, questions)
        if desc:
            parts.append("Screening: " + "; ".join(desc))
    return " | ".join(parts)


def _type_instruction(q: dict) -> str:
    kind = q.get("type", "")
    if kind == "single_select": return "Response format: Select one answer."
    if kind == "multi_select": return "Response format: Select all that apply."
    if kind == "rank": return "Response format: Rank the listed items."
    if kind == "sum_to_100": return "Response format: Allocate 100 points across the listed items."
    if kind == "open_text": return "Response format: Open text."
    if kind == "rating_scale": return "Response format: Rate each row on the scale below."
    if kind == "rating_grid": return "Response format: Select a column for each row."
    if kind == "semantic_diff": return "Response format: Rate each item between its opposite anchors."
    if kind == "numeric": return "Response format: Enter a number."
    if kind == "numeric_matrix": return "Response format: Enter a number in each applicable cell."
    if kind == "text_grid": return "Response format: Enter text in the applicable cells."
    if kind == "slider": return "Response format: Select one point on the scale."
    if kind == "date": return "Response format: Select a date."
    if kind == "gauge_meter": return "Response format: Set the gauge to one value."
    if kind == "emoji_grid": return "Response format: Select one reaction for each row."
    return "Response format: See the Studio question settings."


def build_questionnaire_docx(cfg: dict) -> bytes:
    """Build an editable Word document that mirrors every question in ``cfg``."""
    sections = cfg.get("sections") or []
    questions = cfg.get("questions") or []
    titles = {str(s.get("id")): str(s.get("title") or s.get("id") or "") for s in sections}
    title = _clean(cfg.get("title") or "Research questionnaire")
    body = [
        _paragraph(title, bold=True, size=34, color="0B4F6C", after=60, keep_next=True),
        _paragraph("Editable questionnaire for Anaking Studio", size=19, color="64748B", after=180),
    ]
    brief = _clean(cfg.get("research_brief"))
    audience = _clean(cfg.get("research_audience"))
    market = _clean(cfg.get("research_market"))
    if brief:
        body.append(_paragraph("Research objective / source brief: " + brief, size=20, after=80))
    if audience:
        body.append(_paragraph("Target respondents: " + audience, size=20, after=80))
    if market:
        body.append(_paragraph("Market / geography: " + market, size=20, after=80))
    notes = cfg.get("design_notes") or []
    if notes:
        body.append(_paragraph("Researcher review before fielding", bold=True, size=22, color="9A5B00", after=50, keep_next=True))
        for note in notes:
            body.append(_paragraph("REVIEW NOTE: " + _clean(note), size=19, color="815000", after=45))
    body.append(_paragraph("Questionnaire", bold=True, size=26, color="0B4F6C", after=100, keep_next=True))

    used_sections = list(dict.fromkeys(str(q.get("section") or "") for q in questions))
    for sec_id in used_sections:
        sec_title = titles.get(sec_id, sec_id) or "Questionnaire"
        body.append(_paragraph("SECTION: " + sec_id + " | " + _clean(sec_title),
                               bold=True, size=25, color="0B4F6C", after=100, keep_next=True))
        for q in [x for x in questions if str(x.get("section") or "") == sec_id]:
            qid = _clean(q.get("id") or "Q")
            kind = _clean(q.get("type") or "open_text")
            required = "yes" if q.get("required") is not False else "no"
            body.append(_paragraph(f"QUESTION ID: {qid} | TYPE: {kind} | REQUIRED: {required}",
                                   bold=True, size=22, color="263B50", after=40, keep_next=True))
            stem = _clean(q.get("stem") or q.get("body") or "")
            body.append(_paragraph("QUESTION TEXT: " + stem, size=21, after=60))
            if q.get("help"):
                body.append(_paragraph("HELP: " + _clean(q.get("help")), size=19, color="536273", italic=True, after=45))
            body.append(_paragraph(_type_instruction(q), size=19, color="536273", after=45))

            for option in q.get("options") or []:
                code = _clean(option.get("code"))
                label = _clean(option.get("label"))
                flags = []
                if option.get("other"): flags.append("other")
                if option.get("exclusive"): flags.append("exclusive")
                if option.get("terminate"): flags.append("screen out")
                if option.get("pin"): flags.append("fixed position")
                suffix = (" [" + ", ".join(flags) + "]") if flags else ""
                body.append(_paragraph(f"OPTION: {code} | {label}{suffix}", size=20, after=35))
            for row in q.get("rows") or []:
                extra = ""
                if row.get("left") or row.get("right"):
                    extra = " | LEFT: " + _clean(row.get("left")) + " | RIGHT: " + _clean(row.get("right"))
                body.append(_paragraph(f"ROW: {_clean(row.get('code'))} | {_clean(row.get('label'))}{extra}", size=20, after=35))
            for col in q.get("cols") or []:
                body.append(_paragraph(f"COLUMN: {_clean(col.get('code'))} | {_clean(col.get('label'))}", size=20, after=35))
            scale = q.get("scale") or {}
            if scale:
                body.append(_paragraph("SCALE: " + " | ".join((
                    str(scale.get("min", 1)), str(scale.get("max", 5)),
                    str(scale.get("min_label", "")), str(scale.get("mid_label", "")),
                    str(scale.get("max_label", "")))), size=19, color="536273", after=35))
            if any(k in q for k in ("min", "max", "step", "unit", "suffix")):
                body.append(_paragraph("RANGE: " + " | ".join((
                    str(q.get("min", 0)), str(q.get("max", 100)), str(q.get("step", 1)),
                    str(q.get("unit", q.get("suffix", ""))))), size=19, color="536273", after=35))
            if q.get("rank_count") is not None:
                body.append(_paragraph("RANK COUNT: " + str(q.get("rank_count")), size=19, color="536273", after=35))
            if q.get("max_select") is not None:
                body.append(_paragraph("MAX SELECT: " + str(q.get("max_select")), size=19, color="536273", after=35))
            if q.get("min_words") is not None:
                body.append(_paragraph("MIN WORDS: " + str(q.get("min_words")), size=19, color="536273", after=35))

            flow = _flow_text(q, questions)
            if flow:
                body.append(_paragraph("FLOW / SCREENING: " + flow, size=19, color="815000", italic=True, after=45))
            flow_data = {k: q[k] for k in ("show_if", "screening") if isinstance(q.get(k), dict)}
            if flow_data:
                body.append(_paragraph("STUDIO_FLOW_JSON: " + json.dumps(flow_data, ensure_ascii=False, separators=(",", ":")),
                                       size=1, hidden=True, after=0))
            settings_keys = ("min", "max", "step", "unit", "suffix", "min_label", "max_label", "mid_label",
                             "target", "rank_count", "max_select", "min_words", "select", "scale", "scale_points",
                             "placeholder", "layout", "randomize")
            settings = {k: q[k] for k in settings_keys if k in q}
            if q.get("options"):
                settings["option_flags"] = {str(o.get("code")): {k: o[k] for k in ("other", "exclusive", "terminate", "pin") if o.get(k)}
                                            for o in q["options"] if any(o.get(k) for k in ("other", "exclusive", "terminate", "pin"))}
            if settings:
                body.append(_paragraph("STUDIO_CONFIG_JSON: " + json.dumps({"settings": settings}, ensure_ascii=False, separators=(",", ":")),
                                       size=1, hidden=True, after=0))
            body.append(_paragraph("END QUESTION", size=15, color="94A3B8", after=100))

    document = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                '<w:body>' + "".join(body) +
                '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
                '<w:pgMar w:top="1134" w:bottom="1134" w:left="1134" w:right="1134"/>'
                '</w:sectPr></w:body></w:document>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", RELS)
        archive.writestr("word/document.xml", document)
    return buf.getvalue()
