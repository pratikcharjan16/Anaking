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
    rows = [{'code': str(r['code']), 'label': label(r)} for r in question.get('rows', [])]
    cols = [{'code': str(c['code']), 'label': label(c)} for c in question.get('cols', [])]
    answers = [r['answers'].get(question['id'], {}) for r in records if r['status'] == 'complete']
    cells, answered = [], set()
    for row in rows:
        for col in cols:
            key = row['code'] + '_' + col['code']
            values = []
            for i, a in enumerate(answers):
                v = intensity(a.get(key))
                if v is not None:
                    values.append(v)
                    answered.add(i)
            cells.append({'row_code': row['code'], 'col_code': col['code'],
                          'row': row['label'], 'col': col['label'], 'base': len(values),
                          'mean': round(statistics.mean(values), 3) if values else None})
    return {'id': question['id'], 'rows': rows, 'cols': cols, 'cells': cells, 'base': len(answered),
            'note': 'Mean selected intensity: 1 weak, 2 moderate, 3 strong. Unselected/cleared cells are excluded; each cell shows its own answered base.'}
