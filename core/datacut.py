"""
Data cut and statistical significance testing for survey research analytics.
Supports two-proportion z-tests for categorical options, Welch's t-tests for
rating scale and numeric/gauge means, and dynamic data-driven insights.
"""

from __future__ import annotations

import math
import re
import statistics
import scipy.stats as stats

from core.research import numeric, plain, present


def two_proportion_z_test(c1: int, n1: int, c2: int, n2: int) -> dict:
    """Two-proportion pooled z-test (two-tailed) for differences between independent samples."""
    if n1 <= 0 or n2 <= 0:
        return {"z": 0.0, "p_value": 1.0, "significant": False, "sig_90": False, "sig_95": False, "sig_99": False, "higher": None}
    p1 = c1 / n1
    p2 = c2 / n2
    p_pool = (c1 + c2) / (n1 + n2)
    se = math.sqrt(p_pool * (1.0 - p_pool) * (1.0 / n1 + 1.0 / n2))
    if se == 0:
        return {"z": 0.0, "p_value": 1.0, "significant": False, "sig_90": False, "sig_95": False, "sig_99": False, "higher": None}
    z = (p1 - p2) / se
    p_val = float(stats.norm.sf(abs(z)) * 2.0)
    return {
        "z": round(z, 3),
        "p_value": round(p_val, 4),
        "sig_90": p_val < 0.10,
        "sig_95": p_val < 0.05,
        "sig_99": p_val < 0.01,
        "significant": p_val < 0.05,
        "higher": "A" if p1 > p2 else ("B" if p2 > p1 else None),
        "diff_pct": round((p1 - p2) * 100, 1),
    }


def two_sample_t_test(vals1: list[float], vals2: list[float]) -> dict:
    """Welch's two-sample t-test (unequal variances assumed) for differences between means."""
    v1 = [x for x in vals1 if x is not None]
    v2 = [x for x in vals2 if x is not None]
    if len(v1) < 2 or len(v2) < 2:
        return {"t": 0.0, "df": 0, "p_value": 1.0, "significant": False, "sig_90": False, "sig_95": False, "sig_99": False, "higher": None}
    try:
        res = stats.ttest_ind(v1, v2, equal_var=False)
        t_stat = float(res.statistic)
        p_val = float(res.pvalue)
        df = float(res.df) if hasattr(res, "df") else len(v1) + len(v2) - 2
        m1 = statistics.mean(v1)
        m2 = statistics.mean(v2)
        return {
            "t": round(t_stat, 3),
            "df": round(df, 1),
            "p_value": round(p_val, 4),
            "sig_90": p_val < 0.10,
            "sig_95": p_val < 0.05,
            "sig_99": p_val < 0.01,
            "significant": p_val < 0.05,
            "higher": "A" if m1 > m2 else ("B" if m2 > m1 else None),
            "diff_mean": round(m1 - m2, 3),
        }
    except Exception:
        return {"t": 0.0, "df": 0, "p_value": 1.0, "significant": False, "sig_90": False, "sig_95": False, "sig_99": False, "higher": None}


def generate_insight(q: dict, data: dict, cut_meta: dict | None = None) -> str:
    """Generates an executive, actionable, data-driven insight for the question."""
    qtype = q.get("type")
    opts = data.get("options") or []
    rows = data.get("rows") or []
    base = data.get("base", 0)

    if base == 0:
        return "No completed responses recorded for this question yet."

    # If Data Cut is present, highlight statistically significant findings
    if cut_meta and cut_meta.get("active"):
        sig_items = []
        for o in opts:
            test = o.get("sig_test")
            if test and test.get("significant"):
                higher_name = cut_meta["segA_label"] if test["higher"] == "A" else cut_meta["segB_label"]
                diff = abs(test.get("diff_pct", 0))
                p = test["p_value"]
                sig_items.append(f"'{o['label']}' is significantly higher in {higher_name} (+{diff}%, p={p:.3f})")
        for r in rows:
            test = r.get("sig_test")
            if test and test.get("significant"):
                higher_name = cut_meta["segA_label"] if test["higher"] == "A" else cut_meta["segB_label"]
                diff = abs(test.get("diff_mean", 0))
                p = test["p_value"]
                sig_items.append(f"'{r['label']}' mean is significantly higher in {higher_name} (+{diff:.2f}, p={p:.3f})")
        if sig_items:
            return "★ Significant segment difference: " + "; ".join(sig_items[:2]) + "."
        elif cut_meta.get("segA_label") and cut_meta.get("segB_label"):
            return f"Comparison between {cut_meta['segA_label']} (n={cut_meta['segA_n']}) and {cut_meta['segB_label']} (n={cut_meta['segB_n']}) shows directional consistency with no statistically significant differences (p > 0.05)."

    # Single Select insight
    if qtype == "single_select" and opts:
        sorted_opts = sorted(opts, key=lambda x: x.get("count", 0), reverse=True)
        top = sorted_opts[0]
        if len(sorted_opts) > 1:
            second = sorted_opts[1]
            margin = round((top.get("pct") or 0) - (second.get("pct") or 0), 1)
            return (f"Leading response is '{top['label']}' with {top.get('pct', 0)}% share (n={top.get('count', 0)}), "
                    f"leading '{second['label']}' ({second.get('pct', 0)}%) by +{margin} percentage points.")
        return f"Primary selection is '{top['label']}' selected by {top.get('pct', 0)}% of respondents (n={top.get('count', 0)})."

    # Multi Select insight
    if qtype == "multi_select" and opts:
        sorted_opts = sorted(opts, key=lambda x: x.get("count", 0), reverse=True)
        top = sorted_opts[0]
        if len(sorted_opts) > 1:
            second = sorted_opts[1]
            return (f"Top selection is '{top['label']}' chosen by {top.get('pct', 0)}% of respondents (n={top.get('count', 0)}), "
                    f"followed by '{second['label']}' ({second.get('pct', 0)}%).")
        return f"Top selection is '{top['label']}' with {top.get('pct', 0)}% penetration rate."

    # Rating Scale & Grids insight
    if (qtype in ("rating_scale", "rating_grid", "semantic_diff", "numeric_matrix") or (qtype == "gauge_meter" and rows)) and rows:
        valid_rows = [r for r in rows if r.get("mean") is not None]
        if valid_rows:
            sorted_rows = sorted(valid_rows, key=lambda x: x.get("mean", 0), reverse=True)
            top_r = sorted_rows[0]
            low_r = sorted_rows[-1]
            if len(sorted_rows) > 1 and top_r != low_r:
                gap = round(top_r["mean"] - low_r["mean"], 2)
                return (f"Highest rated item is '{top_r['label']}' (mean {top_r['mean']:.2f}), "
                        f"while '{low_r['label']}' scored lowest (mean {low_r['mean']:.2f}, gap of {gap:.2f} pts).")
            return f"Top rated item is '{top_r['label']}' with a mean score of {top_r['mean']:.2f}."

    # Single Gauge Meter insight
    if qtype == "gauge_meter" and not rows:
        m = data.get("mean")
        target = data.get("target")
        unit = data.get("unit", "%")
        zones = data.get("zones") or []
        hi_zone = next((z for z in zones if "high" in z.get("label", "").lower()), None)
        zone_txt = f", with {hi_zone['pct']}% in the High zone" if hi_zone else ""
        if m is not None and target is not None:
            comp = "exceeding" if m >= target else "trailing"
            gap = abs(round(m - target, 1))
            return (f"Average gauge reading is {m:.1f}{unit} ({comp} target of {target}{unit} by {gap} pts)"
                    f"{zone_txt} across n={base} respondents.")
        elif m is not None:
            return f"Average gauge score is {m:.1f}{unit}{zone_txt} across n={base} respondents."

    # Rank insight
    if qtype == "rank" and opts:
        sorted_ranks = sorted(opts, key=lambda x: x.get("first_count", 0), reverse=True)
        top = sorted_ranks[0]
        return (f"Top-ranked priority is '{top['label']}', selected as #1 choice by {top.get('first_pct', 0)}% "
                f"of respondents (Average rank position: {top.get('avg_rank', '—')}).")

    # Sum to 100 insight
    if qtype == "sum_to_100" and rows:
        sorted_rows = sorted([r for r in rows if r.get("mean") is not None], key=lambda x: x.get("mean", 0), reverse=True)
        if sorted_rows:
            top_r = sorted_rows[0]
            sec_txt = f", followed by '{sorted_rows[1]['label']}' ({sorted_rows[1]['mean']:.1f} pts)" if len(sorted_rows) > 1 else ""
            return f"Highest allocated share is '{top_r['label']}' with {top_r['mean']:.1f} of 100 total points{sec_txt}."

    # Open Text insight
    if qtype == "open_text":
        cloud = data.get("word_cloud") or []
        top_words = ", ".join([f"'{w['word']}'" for w in cloud[:3]])
        theme_txt = f" Top recurring themes: {top_words}." if top_words else ""
        return f"Collected {base} verbatim responses (average {data.get('avg_word_count', 0)} words per response).{theme_txt}"

    # Numeric & Slider insight
    if qtype in ("numeric", "slider", "delta"):
        m = data.get("mean")
        med = data.get("median")
        return f"Average score is {m} (Median: {med}) based on {base} valid entries."

    return f"Total answered base: {base} respondents."


def analyze_with_datacut(records: list, cfg: dict, cut_q_id: str | None = None,
                         cut_v1: str | None = None, cut_v2: str | None = None,
                         alpha: float = 0.05) -> dict:
    """Analyzes survey responses with dynamic visual statistics, optional data cut,

    statistical significance testing, and executive data-driven insights.
    """
    complete = [r for r in records if r.get("status") == "complete"]
    durations = [numeric(r.get("elapsed_seconds")) for r in complete]
    durations = [x / 60 for x in durations if x is not None and x >= 0]

    # Check if a valid Data Cut question is provided
    cut_q = None
    cut_meta = None
    records_A, records_B = [], []

    if cut_q_id:
        cut_q = next((q for q in cfg.get("questions", []) if q.get("id") == cut_q_id), None)
        if cut_q:
            opts = cut_q.get("options") or []
            # Determine values for Segment A and Segment B
            if cut_v1 is None and opts:
                cut_v1 = str(opts[0].get("code"))
            if cut_v2 is None and len(opts) > 1:
                cut_v2 = str(opts[1].get("code"))

            label_A = next((o.get("label") for o in opts if str(o.get("code")) == str(cut_v1)), str(cut_v1))
            label_B = next((o.get("label") for o in opts if str(o.get("code")) == str(cut_v2)), str(cut_v2)) if cut_v2 else "All Others"

            for r in complete:
                val = r.get("answers", {}).get(cut_q_id, {}).get("_")
                if val is None:
                    # check if multi-select or other structure
                    codes = r.get("answers", {}).get(cut_q_id, {}).get("codes", [])
                    if str(cut_v1) in [str(c) for c in codes]:
                        records_A.append(r)
                    elif cut_v2 and str(cut_v2) in [str(c) for c in codes]:
                        records_B.append(r)
                    elif not cut_v2:
                        records_B.append(r)
                elif str(val) == str(cut_v1):
                    records_A.append(r)
                elif cut_v2 and str(val) == str(cut_v2):
                    records_B.append(r)
                elif not cut_v2:
                    records_B.append(r)

            cut_meta = {
                "active": True,
                "cut_q": cut_q_id,
                "cut_q_title": plain(cut_q.get("stem_html") or cut_q.get("stem") or cut_q_id),
                "segA_code": str(cut_v1),
                "segA_label": label_A,
                "segA_n": len(records_A),
                "segB_code": str(cut_v2) if cut_v2 else "other",
                "segB_label": label_B,
                "segB_n": len(records_B),
                "alpha": alpha,
                "conf_pct": int((1.0 - alpha) * 100),
            }

    questions_out = []
    for q in cfg.get("questions", []):
        qid = q["id"]
        qtype = q.get("type")
        values = [r["answers"].get(qid, {}).get("codes" if qtype == "multi_select" else "_") for r in complete]
        vals = [v for v in values if present(v)]

        row = {
            "id": qid,
            "title": plain(q.get("stem_html") or q.get("stem") or qid),
            "type": qtype,
            "base": len(vals),
            "missing_or_not_shown": len(complete) - len(vals),
            "small_base": len(vals) < 30,
            "options": [],
            "mean": None,
            "median": None,
        }

        # Numeric / Slider / Single Gauge Meter
        if qtype in ("numeric", "slider", "gauge_meter") and not q.get("rows"):
            ns = [numeric(v) for v in vals]
            ns = [v for v in ns if v is not None]
            row["base"] = len(ns)
            row["mean"] = round(statistics.mean(ns), 3) if ns else None
            row["median"] = statistics.median(ns) if ns else None
            if len(ns) >= 2:
                row["std_dev"] = round(statistics.stdev(ns), 2)
                row["min_val"] = min(ns)
                row["max_val"] = max(ns)

            if qtype == "gauge_meter":
                row["min"] = q.get("min", 0)
                row["max"] = q.get("max", 100)
                row["unit"] = q.get("unit", "%")
                row["target"] = q.get("target", 75)
                row["min_label"] = q.get("min_label", "Low")
                row["mid_label"] = q.get("mid_label", "Moderate")
                row["max_label"] = q.get("max_label", "High")
                rng = (row["max"] - row["min"]) or 100
                z_low = sum(1 for x in ns if (x - row["min"]) / rng < 0.4)
                z_mid = sum(1 for x in ns if 0.4 <= (x - row["min"]) / rng < 0.7)
                z_high = sum(1 for x in ns if (x - row["min"]) / rng >= 0.7)
                tot = len(ns) or 1
                row["zones"] = [
                    {"label": row["min_label"], "cls": "low", "count": z_low, "pct": round(100 * z_low / tot, 1)},
                    {"label": row["mid_label"], "cls": "mid", "count": z_mid, "pct": round(100 * z_mid / tot, 1)},
                    {"label": row["max_label"], "cls": "high", "count": z_high, "pct": round(100 * z_high / tot, 1)}
                ]

            if cut_meta and cut_meta["active"]:
                vals_A = [numeric(r["answers"].get(qid, {}).get("_")) for r in records_A]
                vals_B = [numeric(r["answers"].get(qid, {}).get("_")) for r in records_B]
                vals_A = [x for x in vals_A if x is not None]
                vals_B = [x for x in vals_B if x is not None]
                m_A = round(statistics.mean(vals_A), 2) if vals_A else None
                m_B = round(statistics.mean(vals_B), 2) if vals_B else None
                t_res = two_sample_t_test(vals_A, vals_B)
                row["segment_stats"] = {
                    "segA": {"base": len(vals_A), "mean": m_A},
                    "segB": {"base": len(vals_B), "mean": m_B},
                    "sig_test": t_res,
                }

        # Single Select & Multi Select
        if qtype in ("single_select", "multi_select"):
            for o in q.get("options", []):
                ocode = str(o["code"])
                n = sum(ocode in [str(x) for x in (v if isinstance(v, list) else [v])] for v in vals)
                pct = round(100 * n / len(vals), 1) if vals else 0
                opt_data = {
                    "code": o["code"],
                    "label": plain(o.get("label_html") or o.get("label")),
                    "count": n,
                    "pct": pct,
                }
                if cut_meta and cut_meta["active"]:
                    vals_A = [r["answers"].get(qid, {}).get("codes" if qtype == "multi_select" else "_") for r in records_A]
                    vals_B = [r["answers"].get(qid, {}).get("codes" if qtype == "multi_select" else "_") for r in records_B]
                    vA = [v for v in vals_A if present(v)]
                    vB = [v for v in vals_B if present(v)]
                    nA = sum(ocode in [str(x) for x in (v if isinstance(v, list) else [v])] for v in vA)
                    nB = sum(ocode in [str(x) for x in (v if isinstance(v, list) else [v])] for v in vB)
                    pctA = round(100 * nA / len(vA), 1) if vA else 0
                    pctB = round(100 * nB / len(vB), 1) if vB else 0
                    z_res = two_proportion_z_test(nA, len(vA), nB, len(vB))
                    opt_data["segA_count"] = nA
                    opt_data["segA_pct"] = pctA
                    opt_data["segB_count"] = nB
                    opt_data["segB_pct"] = pctB
                    opt_data["sig_test"] = z_res
                row["options"].append(opt_data)

        # Heatmap
        if qtype == "heatmap":
            from core.heatmap import summarize_heatmap
            row["heatmap"] = summarize_heatmap(complete, q)
            row["base"] = row["heatmap"]["base"]
            row["missing_or_not_shown"] = len(complete) - row["base"]
            row["small_base"] = row["base"] < 30

        # Rank
        elif qtype == "rank":
            opts = q.get("options", [])
            orders = [r["answers"].get(qid, {}).get("order", []) for r in complete]
            orders = [o for o in orders if isinstance(o, list) and len(o) > 0]
            tot_r = len(orders) or 1
            ranks_data = []
            for o in opts:
                ocode = str(o["code"])
                f_cnt = sum(1 for ord_l in orders if ord_l and str(ord_l[0]) == ocode)
                f_pct = round(100 * f_cnt / tot_r, 1)
                t3_cnt = sum(1 for ord_l in orders if ocode in [str(x) for x in ord_l[:3]])
                t3_pct = round(100 * t3_cnt / tot_r, 1)
                positions = [ord_l.index(ocode) + 1 for ord_l in orders if ocode in [str(x) for x in ord_l]]
                avg_p = round(statistics.mean(positions), 2) if positions else None
                ranks_data.append({
                    "code": o["code"],
                    "label": plain(o.get("label_html") or o.get("label")),
                    "first_count": f_cnt,
                    "first_pct": f_pct,
                    "top3_count": t3_cnt,
                    "top3_pct": t3_pct,
                    "avg_rank": avg_p,
                    "pct": f_pct,
                    "count": f_cnt,
                })
            row["options"] = ranks_data
            row["base"] = len(orders)
            row["missing_or_not_shown"] = len(complete) - len(orders)
            row["small_base"] = row["base"] < 30

        # Open text
        elif qtype == "open_text":
            texts = [str(r["answers"].get(qid, {}).get("_") or "").strip() for r in complete]
            texts = [t for t in texts if t]
            row["base"] = len(texts)
            row["missing_or_not_shown"] = len(complete) - len(texts)
            row["small_base"] = row["base"] < 30
            STOP_WORDS = {"the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "with", "is", "are", "was", "were", "it", "this", "that", "i", "we", "they", "my", "our", "would", "be", "as", "by", "from", "not", "but", "have", "had", "has", "do", "does", "did", "if", "more", "than", "so", "very", "all", "can", "will", "because", "their"}
            wc = {}
            for t in texts:
                for w in re.findall(r"[A-Za-z]{3,}", t.lower()):
                    if w not in STOP_WORDS:
                        wc[w] = wc.get(w, 0) + 1
            row["word_cloud"] = [{"word": k, "count": v} for k, v in sorted(wc.items(), key=lambda x: x[1], reverse=True)[:18]]
            row["sample_verbatims"] = texts[:10]
            row["avg_word_count"] = round(statistics.mean([len(t.split()) for t in texts]), 1) if texts else 0

        # Multi-row questions: Rating Scale, Grids, Multi-row Gauge Meter, Sum-to-100, Emoji Grid
        elif q.get("rows"):
            row["rows"] = []
            if qtype == "rating_scale":
                sc = q.get("scale") or {}
                row["scale_min"] = sc.get("min", 1)
                row["scale_max"] = sc.get("max", 5)
                row["min_label"] = sc.get("min_label", "Not at all")
                row["mid_label"] = sc.get("mid_label", "Neutral")
                row["max_label"] = sc.get("max_label", "Extremely")
            elif qtype == "gauge_meter":
                row["scale_min"] = q.get("min", 0)
                row["scale_max"] = q.get("max", 100)
                row["unit"] = q.get("unit", "%")
                row["min_label"] = q.get("min_label", "Low")
                row["mid_label"] = q.get("mid_label", "Moderate")
                row["max_label"] = q.get("max_label", "High")
            elif qtype == "sum_to_100":
                row["scale_min"] = 0
                row["scale_max"] = 100
                row["unit"] = "%"
                row["min_label"] = "0%"
                row["max_label"] = "100%"
            elif qtype == "emoji_grid":
                row["scale_min"] = 1
                row["scale_max"] = 5
                row["faces"] = (q.get("scale") or {}).get("faces") or ["😞", "😕", "😐", "🙂", "😍"]
                row["face_labels"] = (q.get("scale") or {}).get("face_labels") or ["Very negative", "Negative", "Neutral", "Positive", "Delighted"]

            for item in q["rows"]:
                rcode = str(item["code"])
                vs = [r["answers"].get(qid, {}).get(rcode) for r in complete]
                ns = [numeric(v) for v in vs if present(v)]
                ns = [v for v in ns if v is not None]
                m = round(statistics.mean(ns), 3) if ns else None
                rdata = {
                    "code": item["code"],
                    "label": plain(item.get("label")),
                    "base": sum(present(v) for v in vs),
                    "mean": m,
                    "pct": round(m, 1) if m is not None else 0,
                }
                # Distribution across scale points for Likert stacking
                s_min = int(row.get("scale_min", 1))
                s_max = int(row.get("scale_max", 5))
                if ns and s_max > s_min and (s_max - s_min) <= 10:
                    dist = {}
                    for pt in range(s_min, s_max + 1):
                        c = sum(1 for x in ns if int(round(x)) == pt)
                        dist[str(pt)] = {"count": c, "pct": round(100 * c / len(ns), 1) if ns else 0}
                    rdata["dist"] = dist
                    rdata["top2_box"] = round(dist.get(str(s_max), {}).get("pct", 0) + dist.get(str(s_max - 1), {}).get("pct", 0), 1)
                if cut_meta and cut_meta["active"]:
                    vs_A = [r["answers"].get(qid, {}).get(rcode) for r in records_A]
                    vs_B = [r["answers"].get(qid, {}).get(rcode) for r in records_B]
                    ns_A = [numeric(v) for v in vs_A if present(v)]
                    ns_B = [numeric(v) for v in vs_B if present(v)]
                    ns_A = [v for v in ns_A if v is not None]
                    ns_B = [v for v in ns_B if v is not None]
                    mA = round(statistics.mean(ns_A), 2) if ns_A else None
                    mB = round(statistics.mean(ns_B), 2) if ns_B else None
                    t_res = two_sample_t_test(ns_A, ns_B)
                    rdata["segA_base"] = len(ns_A)
                    rdata["segA_mean"] = mA
                    rdata["segB_base"] = len(ns_B)
                    rdata["segB_mean"] = mB
                    rdata["sig_test"] = t_res
                row["rows"].append(rdata)

            if row["rows"]:
                row["base"] = max((r.get("base", 0) for r in row["rows"]), default=0)
                row["missing_or_not_shown"] = len(complete) - row["base"]
                row["small_base"] = row["base"] < 30

        # Generate data-driven insight for this question
        row["insight"] = generate_insight(q, row, cut_meta)
        questions_out.append(row)

    out = {
        "started": len(records),
        "complete": len(complete),
        "screened": sum(r.get("status") == "screened_out" for r in records),
        "completion_pct": round(100 * len(complete) / len(records), 1) if records else 0,
        "median_minutes": round(statistics.median(durations), 1) if durations else None,
        "questions": questions_out,
        "data_cut": cut_meta,
        "note": "Dynamic research analytics linked to live survey data. Statistically tested using two-proportion z-tests and Welch's t-tests.",
    }
    return out
