"""Shared heatmap aggregates: blank/cleared cells are missing, not zero intensity."""
import html
import re
import statistics


def label(item):
    return html.unescape(re.sub('<[^>]+>', '', str(item.get('label_html') or item.get('label') or item['code'])))


def intensity(value):
    if isinstance(value, bool):
        return None
    try:
        n = float(value)
        return int(n) if n in (1, 2, 3) else None
    except (ValueError, TypeError):
        return None


def summarize_heatmap(records, question):
    hm = question.get("heatmap") or {}
    if hm:
        reactions = [{"code": str(r.get("code")), "label": label(r)} for r in hm.get("reactions", [])]
        try:
            min_clicks = int(hm.get("min_clicks", 0) or 0)
        except Exception:
            min_clicks = 0
        answers = [r["answers"].get(question["id"], {}) for r in records if r["status"] == "complete"]
        base = 0
        total_clicks = 0
        buckets = {str(r["code"]): [] for r in reactions}
        points = []
        for a in answers:
            clicks = a.get("clicks") if isinstance(a.get("clicks"), list) else []
            if len(clicks) >= (min_clicks or 1) if min_clicks else len(clicks) > 0:
                # count as answered if meets min (or any click when min=0)
                if min_clicks:
                    if len(clicks) >= min_clicks:
                        base += 1
                else:
                    if len(clicks) > 0:
                        base += 1
            total_clicks += len(clicks)
            for c in clicks:
                rc = str(c.get("reaction") or "")
                if rc in buckets:
                    buckets[rc].append(c)
                points.append({"x": c.get("x"), "y": c.get("y"), "reaction": rc, "comment": c.get("comment")})
        per_reaction = []
        for r in reactions:
            code = str(r["code"])
            vals = buckets.get(code, [])
            xs = [float(c.get("x")) for c in vals if c.get("x") is not None]
            ys = [float(c.get("y")) for c in vals if c.get("y") is not None]
            per_reaction.append({
                "code": code,
                "label": r["label"],
                "count": len(vals),
                "base": base,
                "mean_x": round(statistics.mean(xs), 3) if xs else None,
                "mean_y": round(statistics.mean(ys), 3) if ys else None,
            })
        return {
            "id": question["id"],
            "mode": "image",
            "image_src": hm.get("image_src"),
            "image_title": hm.get("image_title"),
            "reactions": reactions,
            "points": points,
            "per_reaction": per_reaction,
            "base": base,
            "total_clicks": total_clicks,
            "note": "Image heatmap: each click is a reaction placed on the image. Base counts respondents with at least min_clicks clicks; per-reaction counts show how often each label was used.",
        }
    rows = [{"code": str(r["code"]), "label": label(r)} for r in question.get("rows", [])]
    cols = [{"code": str(c["code"]), "label": label(c)} for c in question.get("cols", [])]
    answers = [r["answers"].get(question["id"], {}) for r in records if r["status"] == "complete"]
    cells, answered = [], set()
    for row in rows:
        for col in cols:
            key = row["code"] + "_" + col["code"]
            values = []
            for i, a in enumerate(answers):
                v = intensity(a.get(key))
                if v is not None:
                    values.append(v)
                    answered.add(i)
            cells.append({"row_code": row["code"], "col_code": col["code"],
                          "row": row["label"], "col": col["label"], "base": len(values),
                          "mean": round(statistics.mean(values), 3) if values else None})
    return {"id": question["id"], "rows": rows, "cols": cols, "cells": cells, "base": len(answered),
            "note": "Mean selected intensity: 1 weak, 2 moderate, 3 strong. Unselected/cleared cells are excluded; each cell shows its own answered base."}
