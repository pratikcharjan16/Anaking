# Anaking — PROJECT BEACON research platform

Pharma market-research stack built in this workspace. Two parts:

## `oncology_launch_study/`
The original deliverable: a 24-question conjoint survey for a fictional oncology
brand launch (Project BEACON, US oncologists).

- `BEACON_survey_questionnaire.md` / `.docx` — field-ready questionnaire
- `conjoint_design.py` — generates the randomized CBC design
  (`output/design.json`, `output/respondent_task_map.csv`)
- `BEACON_sample_export.xlsx` — sample data export

## `oncology_launch_study/webapp/`
The live platform — a Flask multi-survey system:

```
webapp/
├── app.py                 entry point (python3 app.py) / WSGI app object
├── wsgi.py                gunicorn -w 2 -b 0.0.0.0:8000 wsgi:app
├── requirements.txt       Flask, openpyxl
├── beacon/                the application package
│   ├── __init__.py        create_app() factory, error handlers, /healthz
│   ├── config.py          env-driven settings (ADMIN_TOKEN, BEACON_DB, ...)
│   ├── db.py              SQLite schema, migrations, request-scoped connection
│   ├── auth.py            @admin_required token guard
│   ├── services.py        respondent lifecycle, study CRUD, record loading
│   ├── conjoint.py        balanced design generator + per-respondent randomisation
│   ├── qc.py              speeder / attention / straight-line / gibberish flags
│   ├── reporting.py       flattening, export sheets, quick analysis
│   ├── seed.py            seeds the original BEACON study
│   ├── survey_spec.py     the 24-question BEACON instrument
│   ├── xlsx_export.py     openpyxl or stdlib .xlsx writer
│   └── blueprints/        survey.py (respondents), studio.py, admin.py
├── templates/             index.html, studio.html, admin.html, not_live.html
├── static/                survey.js, explainer.js, studio.js, admin.js, *.css, audio/
├── tests/                 pytest suite (Flask test client, temp DB)
└── scripts/               live-server e2e checks + demo seeder
```

- **Survey platform** (`blueprints/survey.py`, `survey.js`, `explainer.js`, `survey.css`)
  — audio narration, animated TPP walkthrough, 24 questions incl. gamified
  NPS / MaxDiff / heatmap / emoji grid, real-time data-quality flags
  (gibberish, straight-lining, speed, straight answers), voice responses,
  pause/resume, reusable respondent links (`/?code=...`).
- **Studio builder** (`blueprints/studio.py`, `studio.html`, `studio.js`, `studio.css`) — draft as
  many surveys as you like: create / duplicate / rename / delete, add /
  edit / remove / reorder questions (custom counts and new question types),
  paste TPP text and it is segmented into animated scenes, generate a
  balanced conjoint design, go live on a public URL (`/s/<slug>`), and see
  per-survey responses, flags, charts and Excel exports — every survey
  stores and exports its own data separately.
- **Admin dashboard** (`blueprints/admin.py`, `admin.html`, `admin.js`, `admin.css`) —
  live data, quality flags, CSV/JSON/XLSX export, test-data reset.

### Run locally
```bash
cd oncology_launch_study/webapp
pip install -r requirements.txt
python3 app.py --port 8000 --admin-token <token>     # add --debug for auto-reload
# respondent link : http://localhost:8000/
# studio builder  : http://localhost:8000/studio?token=<token>
# admin dashboard : http://localhost:8000/admin?token=<token>
```
Requires Python 3.11+. Configuration via environment: `ADMIN_TOKEN`, `PORT`, `HOST`,
`BEACON_DB` (SQLite path), `BEACON_VOICE_DIR`.

Production: `gunicorn -w 2 -b 0.0.0.0:8000 wsgi:app`

### Tests
```bash
cd oncology_launch_study/webapp
python3 -m pytest                               # in-process suite, no server needed

python3 app.py &                                # live-server scripts
python3 scripts/e2e_live_server.py              # full flow, screen-outs, QC flags, exports
python3 scripts/e2e_reuse_live_server.py        # test/real scopes, xlsx, reset & reuse
python3 scripts/seed_demo.py                    # 7 demo respondents + sample workbook
```

## `uploads/`
Reference material (screenshots) used during development.

---
Runtime data (`survey.db`, respondent voice recordings) is deliberately
excluded from the repository via `.gitignore`.
