"""Transparent research checks and descriptive statistics. No model-generated numbers."""
import collections
import hashlib
import json
import math
import re
import statistics

from core.i18n import extract_strings
from .heatmap import summarize_heatmap


def fingerprint(cfg):
    return hashlib.sha256(json.dumps(cfg, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def plain(value):
    return re.sub('<[^>]+>', '', str(value or '')).strip()


def readiness(cfg):
    qs = cfg.get('questions') or []
    ids = [q.get('id') for q in qs]
    issues, edges = [], []
    def add(level, qid, message):
        issues.append(dict(level=level, question=qid, message=message))
    if not qs:
        add('error', '', 'Add at least one question before publishing.')
    for i, q in enumerate(qs):
        qid = q.get('id', '')
        stem = plain(q.get('stem_html') or q.get('stem') or q.get('body_html') or q.get('body'))
        if not stem and q.get('type') != 'choice_task':
            add('error', qid, 'The respondent-visible question is empty.')
        if len(stem.split()) > 45:
            add('warning', qid, 'Long wording: consider shortening or splitting this question.')
        if re.search(r'\b(obviously|surely|best ever|don.t you agree)\b', stem, re.I):
            add('warning', qid, 'Potential leading wording. Ask neutrally without implying a preferred response.')
        if ' and ' in stem.lower() and '?' in stem:
            add('review', qid, 'Check whether this asks two different things; this is a wording heuristic, not a verdict.')
        if q.get('type') in ('single_select', 'multi_select') and not q.get('options'):
            add('error', qid, 'Add answer options.')
        for field in ('options', 'rows', 'cols'):
            codes = [str(o.get('code')) for o in q.get(field, [])]
            if len(codes) != len(set(codes)):
                add('error', qid, 'Duplicate answer codes in ' + field + '.')
            labels = [plain(o.get('label_html') or o.get('label')).lower() for o in q.get(field, [])]
            if len(labels) != len(set(labels)):
                add('warning', qid, 'Duplicate labels in ' + field + '.')
        for bounds in (q, q.get('scale') or {}):
            try:
                if float(bounds['min']) > float(bounds['max']):
                    add('error', qid, 'Minimum exceeds maximum.')
            except (KeyError, TypeError, ValueError):
                pass
        if q.get('type') == 'choice_task' and not (cfg.get('conjoint') or {}).get('tasks'):
            add('error', qid, 'Generate and review the conjoint design before launch.')
        # Piped references; {label} is the documented loop placeholder.
        for ref in set(re.findall(r'\{([A-Za-z][\w-]*)(?:[.:][^{}]+)?\}', json.dumps(q))):
            if ref == 'label':
                continue
            if ref not in ids:
                add('error', qid, 'Piping references unknown question ' + ref + '.')
            elif ids.index(ref) >= i:
                add('warning', qid, 'Piping references a later/current question ' + ref + '; test this path.')
        def walk(value):
            if isinstance(value, dict):
                if isinstance(value.get('q'), str):
                    ref = value['q']
                    edges.append({'from': ref, 'to': qid, 'operator': value.get('op', '')})
                    if ref not in ids:
                        add('error', qid, 'Logic references unknown question ' + ref + '.')
                    elif ref != qid and ids.index(ref) >= i:
                        add('warning', qid, 'Logic depends on a later answer. Verify this route.')
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)
        walk(q.get('show_if'))
        walk(q.get('screening'))
    if not cfg.get('privacy_notice'):
        add('warning', '', 'Add a study-specific privacy notice, contact and consent statement.')
    if not cfg.get('research_brief'):
        add('review', '', 'Record the objectives and intended decisions in a research brief.')
    words = sum(len(plain(x['text']).split()) for x in extract_strings(cfg))
    estimated = round(max(1, words / 180 + len(qs) * .2), 1)
    return {'issues': issues, 'errors': sum(i['level'] == 'error' for i in issues),
            'warnings': sum(i['level'] == 'warning' for i in issues), 'edges': edges,
            'estimated_minutes': estimated, 'questions': len(qs),
            'method': 'Rule-based checks and reading-time estimate; manual path, mobile and accessibility testing still required.'}


def numeric(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None


def present(value):
    return value is not None and value != '' and value != [] and value != 'NA'


def summarize(records, cfg, segment=None, segment_value=None):
    if segment:
        records = [r for r in records if str(r['answers'].get(segment, {}).get('_', '')) == str(segment_value)]
    complete = [r for r in records if r['status'] == 'complete']
    durations = [numeric(r.get('elapsed_seconds')) for r in complete]
    durations = [x / 60 for x in durations if x is not None and x >= 0]
    questions, last_seen = [], collections.Counter()
    for rec in records:
        answered = [q['id'] for q in cfg.get('questions', []) if any(present(v) for k, v in rec['answers'].get(q['id'], {}).items() if not k.startswith('_') or k == '_')]
        if rec['status'] == 'in_progress':
            last_seen[answered[-1] if answered else 'Before first answer'] += 1
    for q in cfg.get('questions', []):
        qid = q['id']
        values = [r['answers'].get(qid, {}).get('codes' if q['type'] == 'multi_select' else '_') for r in complete]
        vals = [v for v in values if present(v)]
        row = {'id': qid, 'title': plain(q.get('stem_html') or q.get('stem') or qid), 'type': q['type'],
               'base': len(vals), 'missing_or_not_shown': len(complete) - len(vals), 'small_base': len(vals) < 30,
               'options': [], 'mean': None}
        if q.get('type') in ('numeric', 'slider', 'nps'):
            ns = [numeric(v) for v in vals]
            ns = [v for v in ns if v is not None]
            row['base'] = len(ns)
            row['mean'] = round(statistics.mean(ns), 3) if ns else None
            row['median'] = statistics.median(ns) if ns else None
        if q.get('type') in ('single_select', 'multi_select'):
            for o in q.get('options', []):
                n = sum(str(o['code']) in [str(x) for x in (v if isinstance(v, list) else [v])] for v in vals)
                row['options'].append({'code': o['code'], 'label': plain(o.get('label_html') or o.get('label')), 'count': n,
                                       'pct': round(100 * n / len(vals), 1) if vals else None})
        if q.get('type') == 'heatmap':
            row['heatmap'] = summarize_heatmap(complete, q)
            row['base'] = row['heatmap']['base']
            row['missing_or_not_shown'] = len(complete) - row['base']
            row['small_base'] = row['base'] < 30
        elif q.get('rows'):
            row['rows'] = []
            for item in q['rows']:
                vs = [r['answers'].get(qid, {}).get(str(item['code'])) for r in complete]
                ns = [numeric(v) for v in vs if present(v)]
                ns = [v for v in ns if v is not None]
                row['rows'].append({'label': plain(item.get('label')), 'base': sum(present(v) for v in vs),
                                    'mean': round(statistics.mean(ns), 3) if ns else None})
        questions.append(row)
    return {'started': len(records), 'complete': len(complete),
            'screened': sum(r['status'] == 'screened_out' for r in records),
            'completion_pct': round(100 * len(complete) / len(records), 1) if records else 0,
            'median_minutes': round(statistics.median(durations), 1) if durations else None,
            'questions': questions, 'last_answered_in_progress': dict(last_seen),
            'language': dict(collections.Counter(r.get('language') or 'Default' for r in records)),
            'note': 'Descriptive results, not population estimates. Bases exclude missing/N/A. Missing and not-shown are combined because historical exposure was not recorded. In-progress location is not a confirmed dropout.'}


def crosstab(records, cfg, x, y):
    byid = {q['id']: q for q in cfg.get('questions', [])}
    if x not in byid or y not in byid or byid[x]['type'] != 'single_select' or byid[y]['type'] != 'single_select':
        raise ValueError('Choose two single-select questions for a cross-tab.')
    cells, bases = collections.Counter(), collections.Counter()
    for r in records:
        if r['status'] != 'complete':
            continue
        a, b = r['answers'].get(x, {}).get('_'), r['answers'].get(y, {}).get('_')
        if present(a) and present(b):
            cells[(str(a), str(b))] += 1
            bases[str(a)] += 1
    return {'x': x, 'y': y, 'rows': [{'label': o['label'], 'base': bases[str(o['code'])],
        'cells': [{'label': p['label'], 'count': cells[(str(o['code']), str(p['code']))],
                   'pct': round(100 * cells[(str(o['code']), str(p['code']))] / bases[str(o['code'])], 1) if bases[str(o['code'])] else None}
                  for p in byid[y]['options']]} for o in byid[x]['options']],
        'note': 'Row percentages; paired valid answers only. No weighting or significance claims.'}
