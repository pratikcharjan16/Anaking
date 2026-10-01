"""Section defaults and the one-time rename of the old default section titles.

    python3 -m pytest tests/test_sections.py

New studies are created by the Studio (client-side) with "Screeners" / "Main".  Studies that
already existed when that change shipped are renamed once by models.init_db(), which records in
the `meta` table that it has run.
"""

import json
import sqlite3

import models


def _cfg(*titles):
    return {"sections": [{"id": f"S{i + 1}", "title": t} for i, t in enumerate(titles)],
            "questions": [{"id": "Q1", "section": "S1", "type": "open_text", "stem": "x"}]}


def _db_with(path, studies):
    """A database holding `studies` as {slug: cfg}, the way an older install looks."""
    conn = sqlite3.connect(path)
    conn.executescript(models.SCHEMA)
    for slug, cfg in studies.items():
        conn.execute("INSERT INTO studies(slug,title,status,cfg,created_at,updated_at) "
                     "VALUES(?,?,?,?,?,?)",
                     (slug, slug.title(), "draft", json.dumps(cfg), "", ""))
    conn.commit()
    conn.close()
    return str(path)


def _titles(path, slug):
    conn = sqlite3.connect(path)
    cfg = json.loads(conn.execute("SELECT cfg FROM studies WHERE slug=?", (slug,)).fetchone()[0])
    conn.close()
    return [s["title"] for s in cfg["sections"]]


def test_legacy_default_sections_are_renamed(tmp_path):
    """A study still on "Introduction" / "Main questions" is migrated to Screeners / Main."""
    db = _db_with(tmp_path / "old.db", {"old": _cfg("Introduction", "Main questions")})
    renamed = models.init_db(db)
    assert list(renamed) == ["old"]
    assert _titles(db, "old") == ["Screeners", "Main"]


def test_rename_only_touches_the_old_defaults(tmp_path):
    """Custom names survive; a section that merely ends in "Main" is untouched."""
    db = _db_with(tmp_path / "mixed.db", {
        "custom": _cfg("Screening", "Main", "Closing thoughts"),
        "mixed": _cfg("Introduction", "Deep dive"),
    })
    models.init_db(db)
    assert _titles(db, "custom") == ["Screening", "Main", "Closing thoughts"]
    assert _titles(db, "mixed") == ["Screeners", "Deep dive"]


def test_rename_runs_once(tmp_path):
    """After the migration a section deliberately called "Introduction" is left alone."""
    db = _db_with(tmp_path / "later.db", {})
    assert models.init_db(db) == {}
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO studies(slug,title,status,cfg,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                 ("later", "Later", "draft", json.dumps(_cfg("Introduction")), "", ""))
    conn.commit()
    conn.close()
    assert models.init_db(db) == {}                      # guarded by the meta row
    assert _titles(db, "later") == ["Introduction"]


def test_a_broken_cfg_does_not_stop_the_migration(tmp_path):
    """A study whose cfg is not valid JSON is skipped rather than breaking startup."""
    db = _db_with(tmp_path / "broken.db", {"good": _cfg("Introduction")})
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO studies(slug,title,status,cfg,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                 ("bad", "Broken", "draft", "{not json", "", ""))
    conn.commit()
    conn.close()
    assert list(models.init_db(db)) == ["good"]


def test_live_study_is_renamed_when_the_migration_has_not_run_yet(client, app):
    """The same path the server takes on the first boot after the upgrade."""
    r = client.post("/api/studio/save", json={"title": "Live Legacy", "cfg": _cfg(
        "Introduction", "Main questions")})
    slug = r.get_json()["slug"]
    with app.app_context():
        conn = models.connect()
        conn.execute("DELETE FROM meta WHERE key=?", (models._SECTIONS_MIGRATION_KEY,))
        conn.commit()
        conn.close()
        renamed = models.init_db()                       # exactly what create_app() calls
    assert list(renamed) == [slug]
    titles = [s["title"] for s in
              client.get(f"/api/studio/study?slug={slug}").get_json()["cfg"]["sections"]]
    assert titles == ["Screeners", "Main"]
