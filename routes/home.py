"""
HOME  -  landing page, advanced SEO / Sitemap endpoints, and legacy redirects.

    GET  /                      landing page with links to Survey, Studio and Admin
    GET  /sitemap               interactive visual HTML sitemap & SEO directory
    GET  /sitemap.xml           dynamic XML sitemap (with image & study extensions)
    GET  /robots.txt            search crawler & AI-bot directives
    GET  /llms.txt              structured AI search / LLM discovery index
    GET  /manifest.webmanifest  web app manifest for search & mobile discovery
    GET  /test                  -> /survey/test         (old respondent links keep working)
    GET  /s/<slug>              -> /survey/<slug>
    GET  /healthz               liveness check
"""

from __future__ import annotations

from datetime import datetime, timezone
from xml.sax.saxutils import escape as xml_escape

from flask import (Blueprint, Response, current_app, jsonify, redirect,
                   render_template, request, url_for)

from models import Study

bp = Blueprint("home", __name__)

# Canonical brand & phonetic/misspelling aliases so search queries like
# "surveykart", "survey kart", "survey cart", "surveycart", "survaykart",
# "survekart", "surverykart" all map cleanly to our SurveyKart domain.
SEO_BRAND_ALIASES = (
    "SurveyKart",
    "Survey Kart",
    "surveykart",
    "SurveyCart",
    "Survey Cart",
    "survey cart",
    "survey-kart",
    "survey-cart",
    "SurvayKart",
    "Survay Kart",
    "Survay Cart",
    "SurveKart",
    "Surve Kart",
    "SurveryKart",
    "Survery Kart",
    "Survery Cart",
    "SurveyKart Insights Delivered",
    "Anaking SurveyKart",
)

SITEMAP_PAGES = (
    {
        "path": "/",
        "title": "SurveyKart Home — Shop Your Questions · Insights Delivered",
        "category": "Main Platform Pages",
        "priority": "1.0",
        "changefreq": "daily",
        "badge": "Core Landing",
        "description": (
            "Official SurveyKart (Survey Kart / SurveyCart) platform home page. Register for "
            "100 free Kart points, explore the 4-Engine animated architecture, shop 23 question "
            "types, test Answer by Voice & Live Dictation, Straight-Line QC, and AI Verbatim X-Ray."
        ),
        "keywords": "surveykart, survey kart, survey cart, surveycart, home, 100 kart points, insights delivered",
        "images": [
            ("/static/images/surveykart-3d-logo.gif", "SurveyKart 3D Animated Platform Emblem"),
            ("/static/images/surveykart-kart-demo.gif", "SurveyKart 100-Point Deduction Walkthrough"),
        ],
    },
    {
        "path": "/register",
        "title": "Register on SurveyKart — Claim 100 Free Kart Points",
        "category": "Main Platform Pages",
        "priority": "0.95",
        "changefreq": "weekly",
        "badge": "+100 Free Pts",
        "description": (
            "Create a new SurveyKart account and receive 100 default Kart points immediately "
            "to shop Single Select (10 pts), Constant Sum (20 pts), Delta (30 pts), and Conjoint (40 pts) questions."
        ),
        "keywords": "register surveykart, sign up survey cart, 100 free kart points, create account",
    },
    {
        "path": "/signin",
        "title": "Sign In to SurveyKart Studio, Monitor & Admin",
        "category": "Main Platform Pages",
        "priority": "0.90",
        "changefreq": "weekly",
        "badge": "Authentication",
        "description": (
            "Sign in with your SurveyKart username, e-mail, or Google OAuth to open SurveyKart "
            "Studio, manage shared 0-point collaboration links, and monitor live fieldwork."
        ),
        "keywords": "signin surveykart, login survey cart, studio sign in, google login",
    },
    {
        "path": "/recover",
        "title": "Account Lookup & Password Recovery — SurveyKart",
        "category": "Main Platform Pages",
        "priority": "0.75",
        "changefreq": "monthly",
        "badge": "Account Recovery",
        "description": (
            "Look up your registered SurveyKart account status, Kart point balance, and recover access credentials."
        ),
        "keywords": "recover surveykart account, forgot password survey cart, account lookup",
    },
    {
        "path": "/studio/",
        "title": "SurveyKart Studio — 23-Type Question Store & AI Survey Builder",
        "category": "Main Platform Pages",
        "priority": "0.94",
        "changefreq": "daily",
        "badge": "Survey Builder",
        "description": (
            "Design, shop, and preview research surveys across 23 question & methodology types "
            "(Single Select, Multi Select, Rating Scale, Matrix Grid, Text Grid, Constant Sum, "
            "Delta, Conjoint, MaxDiff, Gabor-Granger) with live respondent preview and AI co-pilot."
        ),
        "keywords": "surveykart studio, survey builder, 23 question types, conjoint, maxdiff, delta grid",
    },
    {
        "path": "/admin/",
        "title": "SurveyKart Monitor — Live Fieldwork Quotas, Crosstabs & Native PPTX/XLSX Exports",
        "category": "Main Platform Pages",
        "priority": "0.90",
        "changefreq": "daily",
        "badge": "Live Analytics",
        "description": (
            "Real-time fieldwork dashboard with quota tracking, significance-tested crosstabs, "
            "AI verbatim & straight-line QC flags, and one-click exports to Excel (.XLSX), CSV, JSON, and native editable PowerPoint (.PPTX)."
        ),
        "keywords": "surveykart monitor, live crosstabs, native pptx export, xlsx export, quota tracking",
    },
    {
        "path": "/workspace/",
        "title": "SurveyKart Research Workspace — Project Hub & Study Governance",
        "category": "Main Platform Pages",
        "priority": "0.88",
        "changefreq": "daily",
        "badge": "Project Hub",
        "description": (
            "Unified research workspace for managing multi-wave studies, team collaboration links "
            "(0 Kart point debit), version publishing, and data validation."
        ),
        "keywords": "surveykart workspace, project hub, collaboration links, study governance",
    },
    {
        "path": "/survey/",
        "title": "Live Respondent Survey Instrument — Answer by Voice, Dictation & Walkthroughs",
        "category": "Main Platform Pages",
        "priority": "0.92",
        "changefreq": "daily",
        "badge": "Respondent App",
        "description": (
            "Responder-first survey experience featuring multi-perspective Answer by Voice "
            "(speak option numbers or option names), continuous Text-Grid live dictation, "
            "interactive walkthrough briefings, and real-time straight-line & AI verbatim QC."
        ),
        "keywords": "surveykart respondent survey, answer by voice, live dictation, interactive walkthrough",
    },
    {
        "path": "/survey/test",
        "title": "Respondent Survey Test Mode & Live QC Preview — SurveyKart",
        "category": "Main Platform Pages",
        "priority": "0.82",
        "changefreq": "weekly",
        "badge": "Test & Preview",
        "description": (
            "Interactive sandbox for testing survey routing, voice commands, continuous dictation, "
            "and on-screen rating-scale straight-line QC flags without affecting live quotas."
        ),
        "keywords": "survey test mode, preview surveykart, voice test, straight-line flag test",
    },
    {
        "path": "/admin/console",
        "title": "SurveyKart Admin Console — User Roles, Approvals & Kart Point Governance",
        "category": "Governance & Admin Surfaces",
        "priority": "0.84",
        "changefreq": "weekly",
        "badge": "Admin Governance",
        "description": (
            "Protected control center for platform administrators to approve accounts, allocate "
            "or adjust Kart point balances, review point requests, and transfer project ownership."
        ),
        "keywords": "surveykart admin console, kart point allocation, user governance, approve accounts",
    },
    {
        "path": "/admin-portal",
        "title": "SurveyKart Admin Portal — Platform Usage, Audit Trail & Activity Telemetry",
        "category": "Governance & Admin Surfaces",
        "priority": "0.84",
        "changefreq": "weekly",
        "badge": "Audit & Telemetry",
        "description": (
            "Executive audit portal tracking platform-wide registrations, Kart point consumption, "
            "shared link redemptions, and security audit events."
        ),
        "keywords": "surveykart admin portal, audit trail, usage telemetry, security logs",
    },
    {
        "path": "/sitemap",
        "title": "SurveyKart Advanced Platform Sitemap & Searchable SEO Directory",
        "category": "SEO, Discovery & API Endpoints",
        "priority": "0.90",
        "changefreq": "daily",
        "badge": "HTML Sitemap",
        "description": (
            "Complete interactive sitemap of all SurveyKart pages, landing page feature showcases, "
            "live studies, XML sitemap, robots.txt, and brand search aliases."
        ),
        "keywords": "surveykart sitemap, site directory, all pages, survey cart map",
    },
    {
        "path": "/sitemap.xml",
        "title": "Dynamic XML Sitemap (sitemap.xml) — SurveyKart Search Engine Index",
        "category": "SEO, Discovery & API Endpoints",
        "priority": "0.85",
        "changefreq": "daily",
        "badge": "XML Sitemap",
        "description": (
            "Standards-compliant XML Sitemap (Sitemaps.org 0.9 + Google Image Sitemap 1.1) indexing "
            "all public pages, feature showcases, and live studies."
        ),
        "keywords": "sitemap.xml, google sitemap, xml index",
    },
    {
        "path": "/robots.txt",
        "title": "Search Crawler Directives (robots.txt) — SurveyKart",
        "category": "SEO, Discovery & API Endpoints",
        "priority": "0.75",
        "changefreq": "weekly",
        "badge": "Crawler Rules",
        "description": (
            "Crawler rules for Googlebot, Bingbot, DuckDuckBot, and AI search agents with Sitemap and Host declarations."
        ),
        "keywords": "robots.txt, crawler directives, search engine bots",
    },
    {
        "path": "/llms.txt",
        "title": "AI Search & LLM Discovery Index (llms.txt) — SurveyKart",
        "category": "SEO, Discovery & API Endpoints",
        "priority": "0.78",
        "changefreq": "weekly",
        "badge": "AI Search Index",
        "description": (
            "Structured markdown reference for AI search engines detailing SurveyKart capabilities, "
            "100-point Kart model, brand aliases (SurveyKart / Survey Cart), and canonical URLs."
        ),
        "keywords": "llms.txt, ai search optimization, geo, surveykart overview",
    },
    {
        "path": "/api/kart/catalog",
        "title": "SurveyKart 23 Question Types & Point Pricing JSON Catalog",
        "category": "SEO, Discovery & API Endpoints",
        "priority": "0.80",
        "changefreq": "weekly",
        "badge": "Public JSON API",
        "description": (
            "Machine-readable JSON catalog of all 23 SurveyKart question, methodology, and flow types with exact Kart point costs."
        ),
        "keywords": "kart catalog api, question point pricing, 23 question types json",
    },
    {
        "path": "/healthz",
        "title": "Platform Service Health & Version Check (/healthz)",
        "category": "SEO, Discovery & API Endpoints",
        "priority": "0.65",
        "changefreq": "daily",
        "badge": "Health Check",
        "description": (
            "Real-time JSON liveness endpoint returning platform status and running SurveyKart build version."
        ),
        "keywords": "healthz, service status, uptime check",
    },
)

SITEMAP_SECTIONS = (
    {
        "path": "/#surveykart-flow-showcase",
        "title": "4-Engine Animated Architecture Flow (Kart, Voice, Live QC & Deck Cube)",
        "badge": "Animated Infographic",
        "description": "Interactive 3D Sankey ribbon flow showing Kart Store, Voice Studio, AI + Plumb-Line QC, and Live .PPTX Deck converging into the SurveyKart Insights Cube.",
    },
    {
        "path": "/#kart-demo",
        "title": "How the SurveyKart 100-Point System Works (Interactive Storefront)",
        "badge": "100-Pt Calculator",
        "description": "Shop from all 23 platform question types with 100 free registration points and watch the live 70-point deduction walkthrough.",
    },
    {
        "path": "/#straightline-demo",
        "title": "Rating-Scale Straight-Line Guard & Variance Seismograph (σ = 0.00)",
        "badge": "Plumb-Line QC",
        "description": "Detects zero-variance column straight-lining and diagonal staircases on rating scales, nudges respondents live, and stamps straightliner_<qid>.",
    },
    {
        "path": "/#voice-open-demo",
        "title": "Open-Text Voice & Continuous Live Dictation Studio",
        "badge": "Voice & Dictate",
        "description": "Answer questions hands-free by speaking option numbers or option names, or dictate full multi-sentence paragraphs into Text-Grid cells.",
    },
    {
        "path": "/#walkthrough-demo",
        "title": "Interactive Responder-First Walkthrough Questions",
        "badge": "Responder Empathy",
        "description": "Synchronized 4-chapter clinical briefing player with live ECG/Kaplan-Meier visuals, closed captions, and co-creator insight points.",
    },
    {
        "path": "/#ai-detect-demo",
        "title": "Forensic Verbatim X-Ray — 7-Signal Open-Ended AI Detection",
        "badge": "AI Verbatim Shield",
        "description": "Scores open-ended answers from 0–100 using linguistic LLM fingerprints and browser paste/keystroke telemetry across typing, submit, and Admin review.",
    },
    {
        "path": "/#join",
        "title": "Register & Claim 100 Free Kart Points or Sign In",
        "badge": "Get Started",
        "description": "Direct onboarding gateway to create a new SurveyKart account (+100 points) or sign in to Studio and Admin.",
    },
)


@bp.get("/")
def index():
    """Marketing landing: animated product demos + Google sign-in (or the way into
    the workspace when already signed in).  The project hub is /workspace/, and the
    classic study-list home stays at /?legacy=1."""
    if request.args.get("legacy") == "1":
        from core.security import allowed
        return render_template("home.html", studies=[s for s in Study.list_with_counts() if allowed(s["slug"])])
    if request.args.get("welcome") == "1":
        # Legacy landing target for pending accounts — now the real status page.
        return redirect("/welcome")
    return render_template("landing.html")


@bp.get("/sitemap")
@bp.get("/sitemap.html")
def visual_sitemap():
    """Interactive visual HTML sitemap & searchable SEO directory."""
    try:
        studies = Study.list_with_counts()
    except Exception:
        studies = []
    query = (request.args.get("q") or "").strip()
    return render_template(
        "sitemap.html",
        pages=SITEMAP_PAGES,
        sections=SITEMAP_SECTIONS,
        studies=studies,
        aliases=SEO_BRAND_ALIASES,
        initial_query=query,
    )


@bp.get("/sitemap.xml")
def xml_sitemap():
    """Standards-compliant dynamic XML Sitemap with Google Image Sitemap extensions."""
    base = request.url_root.rstrip("/")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"',
        '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ]

    for page in SITEMAP_PAGES:
        loc = xml_escape(f"{base}{page['path']}")
        lines.append("  <url>")
        lines.append(f"    <loc>{loc}</loc>")
        lines.append(f"    <lastmod>{today}</lastmod>")
        lines.append(f"    <changefreq>{page['changefreq']}</changefreq>")
        lines.append(f"    <priority>{page['priority']}</priority>")
        lines.append(f'    <xhtml:link rel="alternate" hreflang="en" href="{loc}"/>')
        lines.append(f'    <xhtml:link rel="alternate" hreflang="x-default" href="{loc}"/>')
        for img_path, img_title in page.get("images", []):
            img_loc = xml_escape(f"{base}{img_path}")
            lines.append("    <image:image>")
            lines.append(f"      <image:loc>{img_loc}</image:loc>")
            lines.append(f"      <image:title>{xml_escape(img_title)}</image:title>")
            lines.append(f"      <image:caption>{xml_escape(page['description'])}</image:caption>")
            lines.append("    </image:image>")
        lines.append("  </url>")

    # Dynamically index all studies in the database
    try:
        studies = Study.list_with_counts()
    except Exception:
        studies = []
    for st in studies:
        slug = st.get("slug")
        if not slug:
            continue
        loc = xml_escape(f"{base}/survey/{slug}")
        lines.append("  <url>")
        lines.append(f"    <loc>{loc}</loc>")
        lines.append(f"    <lastmod>{today}</lastmod>")
        lines.append("    <changefreq>daily</changefreq>")
        lines.append("    <priority>0.85</priority>")
        lines.append("  </url>")

    lines.append("</urlset>")
    xml_body = "\n".join(lines) + "\n"
    resp = Response(xml_body, mimetype="application/xml; charset=utf-8")
    resp.headers["X-Robots-Tag"] = "all"
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@bp.get("/robots.txt")
def robots_txt():
    """Advanced robots.txt for search engine crawlers and AI discovery agents."""
    base = request.url_root.rstrip("/")
    host = request.host
    content = "\n".join([
        "# SurveyKart (Survey Kart / SurveyCart) — Official Search Crawler Directives",
        "# Domain: " + base,
        "# Brand Aliases: SurveyKart, Survey Kart, SurveyCart, Survey Cart, SurvayKart, SurveKart, SurveryKart",
        "",
        "User-agent: *",
        "Allow: /",
        "Allow: /sitemap",
        "Allow: /sitemap.xml",
        "Allow: /llms.txt",
        "Allow: /manifest.webmanifest",
        "Allow: /register",
        "Allow: /signin",
        "Allow: /recover",
        "Allow: /studio/",
        "Allow: /admin/",
        "Allow: /workspace/",
        "Allow: /survey/",
        "Allow: /api/kart/catalog",
        "Allow: /static/",
        "Disallow: /api/admin/",
        "Disallow: /api/studio/delete",
        "Disallow: /auth/dev",
        "",
        "User-agent: Googlebot",
        "Allow: /",
        "",
        "User-agent: Bingbot",
        "Allow: /",
        "",
        "User-agent: GPTBot",
        "Allow: /",
        "",
        "User-agent: OAI-SearchBot",
        "Allow: /",
        "",
        "User-agent: PerplexityBot",
        "Allow: /",
        "",
        "User-agent: ClaudeBot",
        "Allow: /",
        "",
        f"Host: {host}",
        f"Sitemap: {base}/sitemap.xml",
        "",
    ])
    resp = Response(content, mimetype="text/plain; charset=utf-8")
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@bp.get("/llms.txt")
def llms_txt():
    """Structured AI-search / LLM indexing manifest (llms.txt standard)."""
    base = request.url_root.rstrip("/")
    lines = [
        "# SurveyKart — Insights Delivered",
        "",
        "> SurveyKart (also searched as Survey Kart, SurveyCart, Survey Cart, SurvayKart, SurveKart, SurveryKart) is an AI-enabled market research and survey platform where researchers receive 100 free Kart points on signup, shop from 23 question and methodology types, field surveys with intelligent multi-perspective Answer by Voice and continuous Text-Grid live dictation, protect data quality with rating-scale Straight-Line Guard (sigma = 0.00) and 7-Signal Open-Ended AI Verbatim Detection, and export live crosstabs and native editable PowerPoint (.PPTX) & Excel (.XLSX) decks.",
        "",
        "## Brand & Search Aliases",
        "- Official Name: SurveyKart (SurveyKart · Insights Delivered)",
        "- Common Search Variations: " + ", ".join(SEO_BRAND_ALIASES),
        "",
        "## Main Platform URLs",
    ]
    for p in SITEMAP_PAGES:
        lines.append(f"- [{p['title']}]({base}{p['path']}): {p['description']}")
    lines.append("")
    lines.append("## Landing Page Interactive Feature Showcases")
    for s in SITEMAP_SECTIONS:
        lines.append(f"- [{s['title']}]({base}{s['path']}): {s['description']}")
    return Response("\n".join(lines) + "\n", mimetype="text/plain; charset=utf-8")


@bp.get("/manifest.webmanifest")
def web_manifest():
    """Web App Manifest for search engines and mobile home-screen discovery."""
    return jsonify({
        "name": "SurveyKart · Insights Delivered",
        "short_name": "SurveyKart",
        "description": "Shop 23 survey question types with 100 free Kart points, capture voice & live dictation, guard quality with AI & straight-line QC, and export native .PPTX decks.",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": "#faf6ec",
        "theme_color": "#16241f",
        "icons": [
            {
                "src": url_for("static", filename="images/favicon.svg"),
                "sizes": "any",
                "type": "image/svg+xml",
                "purpose": "any maskable",
            }
        ],
        "shortcuts": [
            {"name": "SurveyKart Studio", "url": "/studio/", "description": "Build & shop survey questions"},
            {"name": "Live Monitor", "url": "/admin/", "description": "Read live crosstabs & export .PPTX"},
            {"name": "Register (+100 Pts)", "url": "/register", "description": "Claim 100 free Kart points"},
            {"name": "Platform Sitemap", "url": "/sitemap", "description": "Browse all SurveyKart pages"},
        ],
    })


@bp.get("/surveykart")
@bp.get("/survey-kart")
@bp.get("/surveycart")
@bp.get("/survey-cart")
@bp.get("/survaykart")
@bp.get("/survay-cart")
@bp.get("/survekart")
@bp.get("/surverykart")
def brand_alias_redirect():
    """Permanent 301 redirect for common brand slug variations and misspellings."""
    return redirect(url_for("home.index"), 301)


@bp.get("/test")
def legacy_test():
    return redirect(url_for("survey.beacon_survey_test"), 301)


@bp.get('/s/<regex("[a-zA-Z0-9\\-]+"):slug>')
@bp.get('/s/<regex("[a-zA-Z0-9\\-]+"):slug>/test')
def legacy_study(slug):
    tail = "/test" if request.path.endswith("/test") else ""
    qs = ("?" + request.query_string.decode()) if request.query_string else ""
    return redirect(f"/survey/{slug}{tail}{qs}", 301)


@bp.get("/healthz")
def healthz():
    return jsonify({"ok": True, "version": current_app.config.get("VERSION", "")})
