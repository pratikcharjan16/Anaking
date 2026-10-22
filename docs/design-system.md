# Design system

Anaking is one platform with one visual language. This document is the contract: what the
tokens mean, which theme a screen uses, and how to add UI without re-introducing drift.

## Layers

| Layer | File | Owns |
|---|---|---|
| Tokens, base, chrome | `static/css/design-system.css` | palette, type, radii, elevation, motion, focus, app bar, footer, pills |
| App layouts | `home.css`, `workspace.css`, `studio.css`, `admin.css`, `survey.css` | page and component layout only |
| Context skins | `studio-workspace.css`, `studio-ai.css`, `preview-skin.css`, `explainer.css`, `nav.css` | small per-surface adjustments |
| Markup | `templates/_brand.html`, `_head.html`, `_nav.html`, `_footer.html` | the brand lockup, document head, section switcher, footer |

`design-system.css` is loaded **last** on every page. It settles tokens for the whole
cascade and owns the shared chrome, so an app stylesheet can style a component but can no
longer redefine the palette.

## Two themes, one system

```
default             team tools   workspace · studio · monitor · home · sign-in
.theme-instrument   respondents  the survey instrument
```

Both themes carry the same neutral ramp, type, spacing, radii, elevation, motion and
focus treatment. Only the accent and the paper warmth differ:

* **Team** — deep research green on warm paper. The working identity of the platform.
* **Instrument** — clinical navy blue on cool paper. A respondent should never mistake the
  questionnaire for team chrome, and the tested instrument keeps the look research teams
  approved.

Shells match the job: the simple entry pages (`home`, *study not launched*) and the Monitor
use the ink `.an-appbar`; the Workspace uses its sidebar; the Studio uses its own light tool
bar. All three read from the same surfaces, radii and type tokens.

The survey page sets `.theme-instrument` on `<body>`; the Studio's in-page preview uses
`preview-skin.css`, which mirrors that palette.

## Tokens

Everything is a CSS custom property on `:root`. Never write a raw hex value in a component.

```
--an-ink  --an-ink-soft  --an-muted  --an-faint        text
--an-line  --an-line-soft  --an-line-strong            borders
--an-paper  --an-panel  --an-panel-2                   surfaces
--an-accent  --an-accent-strong  --an-accent-bright
--an-accent-soft  --an-accent-tint  --an-accent-ink    accent ramp
--an-good  --an-warn  --an-bad  --an-violet            status (+ -soft variants)
--an-radius-xs|sm|(default)|lg|pill                    shape
--an-shadow-1|2|3                                      elevation
--an-font  --an-mono  --an-text  --an-leading          type
--an-control-h  --an-ring  --an-ring-offset            controls + focus
--an-ease  --an-fast  --an-mid                         motion
--an-z-nav  --an-z-overlay  --an-z-modal  --an-z-toast layering
```

The legacy names the older stylesheets use (`--ink`, `--accent`, `--accent2`, `--soft`,
`--teal`, `--radius`, `--shadow`, …) are **aliases** defined once in `design-system.css`
and resolve to the active theme's tokens. Adding a new alias is fine; re-declaring a
palette in an app file is not (a test enforces this).

One subtlety worth knowing: a custom property's `var()` references are substituted where
the property is *declared*. The alias map is therefore re-declared on `:root`,
`.theme-instrument` **and** `.survey-skin`, so an alias follows the palette of the scope it
is used in — an alias frozen only on `:root` would keep the team accent inside the
instrument.

## Shared components

* `.an-appbar` — the team app bar (brand + section switcher).
* `.appnav` / `.appnav-link` — Projects · Survey · Studio · Monitor, with
  `aria-current="page"` on the active one.
* `.an-foot` — public footer.
* `.pill` — one status pill for every app; variants are semantic
  (`live`, `draft`, `closed`, `test`, `complete`, `in_progress`, `screened_out`, …).
* `.linkbtn` — secondary action inside a bar.
* `.skip-link`, `.sr-only`, `.an-eyebrow` — utilities.

## Brand

`templates/_brand.html` renders the lockup (mark, wordmark, badge, tagline). Pass the badge
for the surface (`STUDIO`, `MONITOR`, `SURVEY`, `WORKSPACE`, …) and a unique `prefix` so the
inline SVG gradient ids stay unique. Never copy the SVG into a page — a test fails if a
second copy appears.

## Assets

Templates call `asset('css/survey.css')`, never a literal path. The helper stamps every URL
with `app.config["ASSET_VERSION"]` — the newest mtime in `static/` (override with the
`ASSET_VERSION` environment variable in a fixed deployment). Editing a stylesheet or script
therefore busts browser caches on the next start, with no hand-typed `?v=` strings.

## Rules for new work

1. Use `var(--an-*)` tokens; no raw hex, no one-off radii or shadows.
2. Load `design-system.css` last and add only layout rules to an app stylesheet.
3. Give every page: the `head()` macro, a skip link, one `<h1>`, and the section switcher
   with `aria-current`.
4. Keep touch targets ≥ 40px and let the shared `:focus-visible` ring show — never remove it.
5. Respect `prefers-reduced-motion` (the base layer already collapses animations).
6. `tests/test_design_system.py` enforces the contract: one token file, one brand macro, one
   asset stamp, consistent chrome on every page.

## The Studio preview skin

`static/css/preview-skin.css` is **generated** — never edit it by hand:

```
python3 scripts/build_preview_skin.py          # regenerate from survey.css
python3 scripts/build_preview_skin.py --check  # CI-friendly drift check
```

It scopes the survey structure under `.survey-skin` and carries **no palette**: the scope is
declared next to `.theme-instrument`, so the question-test view and the live preview borrow
the instrument tokens directly and cannot drift from the real questionnaire. A test fails
if the checked-in file is stale.

## Known follow-ups

* The brand lockup has context skins in `workspace.css` and `studio-workspace.css` that
  predate the token layer; they are being folded into `design-system.css` file by file.
* `survey.css` still contains literal colours from the instrument's original build. They
  match the theme tokens today; folding them into `var(--an-*)` is a follow-up.
