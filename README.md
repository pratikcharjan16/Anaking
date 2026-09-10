# Anaking — PROJECT BEACON research platform

A Flask survey platform for pharma market research: multi-study builder, gamified
respondent survey with audio narration and a conjoint (discrete-choice) experiment,
live admin dashboard, data-quality flags and Excel/CSV/JSON exports.

The original deliverable — a 24-question conjoint survey for a fictional oncology brand
launch (PROJECT BEACON, US oncologists) — ships pre-seeded as study `beacon`.

## Project layout

```
Anaking/
├── app.py              application factory (create_app) + CLI entry point
├── config.py           settings — every value overridable by environment variable
├── models.py           SQLite schema/migrations + Study / Respondent / Answer models
├── routes.py           every HTTP route: `user` blueprint (survey) + `admin` blueprint
├── core/               domain logic (no Flask routes in here)
│   ├── conjoint.py     balanced design generator + per-respondent randomisation
│   ├── qc.py           speeder / attention / straight-line / gibberish flags
│   ├── reporting.py    flattening, export sheets, quick analysis
│   ├── seed.py         seeds the BEACON study from survey_spec + data/design
│   ├── survey_spec.py  the 24-question BEACON instrument
│   ├── xlsx_export.py  openpyxl or stdlib .xlsx writer
│   └── auth.py         @admin_required token guard
├── templates/
│   ├── user/           survey.html, not_live.html
│   └── admin/          dashboard.html, studio.html
├── static/
│   ├── css/            survey.css, admin.css, studio.css
│   ├── js/             survey.js, explainer.js, admin.js, studio.js
│   ├── images/
│   └── audio/          narration clips (mp3)
├── data/
│   ├── design/         conjoint design inputs (design.json, respondent_task_map.csv, …)
│   └── survey.db       SQLite database — created on first run, git-ignored
├── uploads/
│   └── voice/          respondent voice recordings — git-ignored
├── tests/              pytest suite (Flask test client, temp DB)
├── scripts/            live-server e2e checks + demo data seeder
├── study_design/       questionnaire (.md/.docx), design generator, sample export
└── requirements.txt
```

## Run

```bash
pip install -r requirements.txt
python3 app.py --port 8000 --admin-token <token>     # add --debug for auto-reload
```

| URL | What it is |
|---|---|
| `/` | Respondent link — the live BEACON survey |
| `/test` | Same survey, stored as **test data** (codes T001, T002 …) |
| `/s/<slug>` , `/s/<slug>/test` | Any study launched from the Studio (`?preview=<token>` for drafts) |
| `/studio?token=…` | **Studio builder** — create / edit / launch studies, generate conjoint designs, per-study analysis |
| `/admin?token=…` | **Dashboard** — live counts, quota fill, QC flags, downloads, reset |
| `/admin/export.xlsx\|csv\|json?token=…&study=…&scope=all\|real\|test` | Exports |
| `/healthz` | Liveness check |

Configuration (environment variables): `ADMIN_TOKEN`, `PORT`, `HOST`, `DB_PATH`,
`VOICE_DIR`, `SECRET_KEY`. Defaults put the database in `data/survey.db` and recordings in
`uploads/voice/`.

Production: `gunicorn -w 2 -b 0.0.0.0:8000 "app:create_app()"`

## Tests

```bash
python3 -m pytest                               # in-process suite, no server needed

python3 app.py &                                # live-server scripts
python3 scripts/e2e_live_server.py              # full flow, screen-outs, QC flags, exports
python3 scripts/e2e_reuse_live_server.py        # test/real scopes, xlsx, reset & reuse
python3 scripts/seed_demo.py                    # 7 demo respondents + sample workbook
```

## Study design material

`study_design/` holds the field-ready questionnaire (`BEACON_survey_questionnaire.md`
/ `.docx`), `conjoint_design.py` (regenerates `data/design/`), a sample Excel export, and
a detailed README on the instrument, screener logic and export format.
