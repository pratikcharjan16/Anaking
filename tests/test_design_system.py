"""Design-system regression tests.

These guard the platform's visual contract rather than any one screen:

  * every page loads the shared token layer and the same document chrome;
  * one brand lockup implementation (templates/_brand.html), not six copies;
  * one asset stamp for every static file (no hand-typed ?v= strings);
  * the palette lives in design-system.css only - app stylesheets must not
    re-declare :root tokens, which is how the blue/green drift happened.
"""

import os
import re

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TEAM_PAGES = ("/", "/studio/", "/admin/", "/survey/test")


def _html(client, path):
    r = client.get(path)
    assert r.status_code == 200, path
    return r.data.decode()


# ------------------------------------------------------------------ shared chrome
def test_workspace_shares_the_same_chrome(app, client):
    app.config["WORKSPACE_ENABLED"] = True
    html = _html(client, "/workspace/")
    for needle in ("css/design-system.css", "js/workspace.js", 'class="skip-link"',
                   "favicon.svg", "theme-color", "Anaking"):
        assert needle in html, needle


def test_every_page_uses_the_design_system(client):
    for path in TEAM_PAGES + ("/survey/",):
        html = _html(client, path)
        assert "css/design-system.css" in html, path


def test_every_page_has_consistent_document_chrome(client):
    for path in TEAM_PAGES + ("/survey/",):
        html = _html(client, path)
        title = re.search(r"<title>(.*?)</title>", html).group(1)
        assert "Anaking" in title, (path, title)
        assert 'rel="icon"' in html and "favicon.svg" in html, path
        assert 'name="theme-color"' in html, path
        assert 'name="viewport"' in html, path
        assert 'class="skip-link"' in html, path


def test_brand_markup_is_rendered_from_one_macro(client):
    for path in ("/", "/admin/", "/survey/", "/survey/test"):
        html = _html(client, path)
        assert html.count('class="anaking-svg-logo"') == 1, path
        assert 'aria-label="Anaking"' in html, path
    # ...and the studio uses the same macro with its own link class
    assert 'class="anaking-svg-logo"' in _html(client, "/studio/")


# ------------------------------------------------------------------ navigation
def test_switcher_is_projects_studio_monitor(client):
    """The respondent survey is not one of the apps: preview/test belongs to the Studio."""
    for path in ("/", "/studio/", "/admin/", "/survey/test"):
        html = _html(client, path)
        links = re.findall(r'<a class="appnav-link[^"]*"[^>]*>([^<]+)</a>', html)
        assert links == ["Projects", "Studio", "Monitor"], (path, links)


def test_app_switcher_marks_the_current_section(client):
    for path in ("/", "/studio/", "/admin/"):
        html = _html(client, path)
        current = re.findall(r'<a class="appnav-link([^"]*)"([^>]*)>', html)
        assert any(" on" in cls and 'aria-current="page"' in rest
                   for cls, rest in current), path
        # the active marker is on exactly one link in the switcher
        assert sum(1 for cls, _ in current if " on" in cls) == 1, path


def test_test_strip_marks_the_test_view_not_a_switcher_tab(client):
    """In test mode the strip carries a small "Test view" link as the current marker
    (and return target); no switcher tab is falsely marked current."""
    html = _html(client, "/survey/test")
    assert re.search(r'<a class="teambar-testlink"[^>]*aria-current="page"', html)
    assert 'class="appnav-link on"' not in html


def test_test_strip_keeps_the_study_it_came_from(client):
    r = client.post("/api/studio/save", json={
        "slug": "ds-child", "title": "Design system study",
        "cfg": {"sections": [], "questions": []}})
    assert r.status_code == 200, r.get_json()
    html = _html(client, "/survey/ds-child/test")
    # "Test view" returns to this study's test link ...
    assert 'href="/survey/ds-child/test"' in html
    # ... and the switcher deep-links back into the same study's tools
    assert 'href="/studio/#ds-child"' in html
    assert 'href="/admin/?study=ds-child"' in html


# ------------------------------------------------------------------ themes
def test_respondent_survey_is_the_instrument_theme(client):
    assert 'class="theme-instrument"' in _html(client, "/survey/")
    assert 'class="theme-instrument"' in _html(client, "/survey/test")
    for path in ("/", "/studio/", "/admin/"):
        assert "theme-instrument" not in _html(client, path), path


# ------------------------------------------------------------------ assets
def test_assets_share_one_build_stamp(client, app):
    stamp = app.config["ASSET_VERSION"]
    html = _html(client, "/studio/")
    urls = re.findall(r'(?:href|src)="(/static/[^"]+)"', html)
    assert urls, "studio page should reference static assets"
    assert all(u.endswith("?v=" + stamp) for u in urls), urls
    assert "/static/js/studio.js?v=" + stamp in html


def test_no_hand_typed_asset_versions_in_templates():
    offenders = []
    for base, _dirs, files in os.walk(os.path.join(ROOT, "templates")):
        for name in files:
            if not name.endswith(".html"):
                continue
            path = os.path.join(base, name)
            text = open(path, encoding="utf-8").read()
            if re.search(r"\?v=[0-9a-zA-Z]{4,}", text):
                offenders.append(os.path.relpath(path, ROOT))
    assert not offenders, offenders


# ------------------------------------------------------------------ tokens
def test_palette_is_declared_once():
    css_dir = os.path.join(ROOT, "static", "css")
    design = open(os.path.join(css_dir, "design-system.css"), encoding="utf-8").read()
    for token in ("--an-ink", "--an-accent", "--an-paper", "--an-radius",
                  "--an-shadow-2", "--an-font"):
        assert token + ":" in design, token
    # App stylesheets style components; they no longer own the palette.
    for name in ("studio.css", "survey.css", "workspace.css", "admin.css",
                 "home.css", "explainer.css", "studio-workspace.css", "studio-ai.css"):
        text = open(os.path.join(css_dir, name), encoding="utf-8").read()
        assert ":root" not in text, f"{name} re-declares design tokens"


def test_every_theme_supplies_the_same_tokens():
    design = open(os.path.join(ROOT, "static", "css", "design-system.css"),
                  encoding="utf-8").read()
    theme = design[design.index(".theme-instrument,\n.survey-skin {"):]
    for token in ("--an-ink", "--an-muted", "--an-line", "--an-paper",
                  "--an-accent", "--an-accent-bright", "--an-accent-soft"):
        assert token + ":" in theme, token


def test_brand_markup_lives_in_one_place():
    svg = '<svg class="anaking-svg-logo"'
    holders = []
    for base, _dirs, files in os.walk(os.path.join(ROOT, "templates")):
        for name in files:
            if name.endswith(".html"):
                path = os.path.join(base, name)
                if svg in open(path, encoding="utf-8").read():
                    holders.append(os.path.basename(path))
    assert holders == ["_brand.html"], holders


def test_instrument_scope_is_shared_with_the_studio_preview():
    """The Studio preview is the instrument, so it must sit in the same theme scope."""
    design = open(os.path.join(ROOT, "static", "css", "design-system.css"),
                  encoding="utf-8").read()
    assert re.search(r"^\.theme-instrument,\n\.survey-skin \{", design, re.M), "scope"
    # Legacy names are re-declared inside the theme scope, otherwise an alias frozen on
    # :root would keep the team accent inside the instrument.
    assert re.search(r":root,\s*\n\.theme-instrument,\s*\n\.survey-skin\s*\{", design), \
        "legacy aliases must be re-declared in the instrument scope"


def test_studio_preview_skin_is_generated_and_current():
    """preview-skin.css is derived from survey.css; a stale copy is a silent design drift."""
    import importlib.util
    path = os.path.join(ROOT, "scripts", "build_preview_skin.py")
    spec = importlib.util.spec_from_file_location("build_preview_skin", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    expected = module.render()
    actual = open(os.path.join(ROOT, "static", "css", "preview-skin.css"),
                  encoding="utf-8").read()
    assert actual == expected, "run python3 scripts/build_preview_skin.py"


def test_preview_skin_carries_no_palette():
    """Colours come from the instrument tokens, never from a second copy of the palette."""
    text = open(os.path.join(ROOT, "static", "css", "preview-skin.css"),
                encoding="utf-8").read()
    header = text[:text.index(".survey-skin *")]
    assert "#" not in header, header


def test_brand_mark_carries_one_palette_no_neon_leftovers():
    """The mark is ivory tile + cut-green gem. The old cyan/purple neon (and its
    gradient wordmark) must never creep back into any brand surface."""
    banned = ("#00f5a0", "#00d9f5", "#7928ca", "#38bdf8", "#a5f3fc", "#1e3a8a",
              "#0d9488", "#b9f7e2", "#8df0d2")
    files = [os.path.join(ROOT, "templates", "_brand.html"),
             os.path.join(ROOT, "static", "images", "favicon.svg")]
    css_dir = os.path.join(ROOT, "static", "css")
    files += [os.path.join(css_dir, n) for n in sorted(os.listdir(css_dir))
              if n.endswith(".css")]
    for f in files:
        text = open(f, encoding="utf-8").read().lower()
        for c in banned:
            assert c not in text, (os.path.relpath(f, ROOT), c)


def test_wordmark_is_solid_not_gradient_text():
    """Gradient text is unreadable at small sizes and washes out on dark bars."""
    css_dir = os.path.join(ROOT, "static", "css")
    for name in os.listdir(css_dir):
        if not name.endswith(".css"):
            continue
        text = open(os.path.join(css_dir, name), encoding="utf-8").read()
        assert "text-fill-color" not in text, name
        assert "background-clip: text" not in text, name
        assert "background-clip:text" not in text, name


def test_brand_lives_in_the_design_system_only():
    """No app stylesheet may style the lockup again - that is how it drifted."""
    css_dir = os.path.join(ROOT, "static", "css")
    for name in os.listdir(css_dir):
        if not name.endswith(".css") or name == "design-system.css":
            continue
        text = open(os.path.join(css_dir, name), encoding="utf-8").read()
        for needle in (".brand-anaking", ".anaking-svg-logo", ".brand-sub-badge",
                       ".anaking-tagline", ".live-pulse-dot"):
            assert needle not in text, (name, needle)
