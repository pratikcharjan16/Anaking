"""
Machine translation for the Globalize-survey flow.

The platform does not train its own model, so "AI translate" calls a translation
service server-side.  Several are supported because a hosted deployment rarely has
the same outbound access as a laptop:

======================  ==========================================  ==================
provider                configuration                               notes
======================  ==========================================  ==================
``google-cloud``        ``GOOGLE_TRANSLATE_API_KEY``                paid, most reliable
``deepl``               ``DEEPL_API_KEY`` (+ ``DEEPL_FREE=0``)      excellent for EU languages
``libretranslate``      ``LIBRETRANSLATE_URL`` (+ API key)          self-hosted, no quota
``google``              nothing (keyless web endpoint)              default fallback
``mymemory``            nothing (``MYMEMORY_EMAIL`` raises quota)   small strings only
======================  ==========================================  ==================

``TRANSLATE_PROVIDER`` picks one explicitly (``google``, ``google-cloud``, ``deepl``,
``libretranslate``, ``mymemory``) or ``none`` to switch network translation off.  In
the default ``auto`` mode the configured paid services are tried first, then the two
keyless endpoints, so a host that blocks ``translate.googleapis.com`` still gets a
translation instead of an English child survey.

Every provider failure is reported with the provider name and HTTP status, which is
what the Studio shows when a batch fails - "translation service unavailable (google:
HTTP 403; mymemory: HTTP 429)" tells the operator exactly which firewall or quota to
look at, instead of a silent English page.

Rich text is translated tag-safely: the HTML is split into tags and text nodes and
only the text nodes travel, so formatting survives the round trip.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_CHARS = 1500     # one answer-length string per request
RETRY_STATUS = {408, 429, 500, 502, 503, 504}
USER_AGENT = "Mozilla/5.0 (compatible; SurveyKartStudio/4; +https://surveykart.app)"

GTX_URL = ("https://translate.googleapis.com/translate_a/single?client=gtx&dt=t"
           "&sl={sl}&tl={tl}&q={q}")
GTX5_URL = ("https://clients5.google.com/translate_a/t?client=dict-chrome-ex"
            "&sl={sl}&tl={tl}&q={q}")
MYMEMORY_URL = "https://api.mymemory.translated.net/get?q={q}&langpair={sl}|{tl}"
DEEPL_URL = "https://api{free}.deepl.com/v2/translate"

PROVIDER_NAMES = ("google-cloud", "deepl", "libretranslate", "google", "mymemory")
PROVIDER_LABELS = {
    "google-cloud": "Google Cloud Translation",
    "deepl": "DeepL",
    "libretranslate": "LibreTranslate",
    "google": "Google Translate (web)",
    "mymemory": "MyMemory",
}


class TranslationError(Exception):
    """The machine translator could not serve this string right now."""


class _ProviderError(Exception):
    """One provider attempt failed; ``transient`` marks retryable failures."""

    def __init__(self, message: str, transient: bool = False):
        super().__init__(message)
        self.transient = transient


def _timeout() -> float:
    try:
        return max(2.0, min(30.0, float(os.environ.get("TRANSLATE_TIMEOUT") or 8)))
    except ValueError:
        return 8.0


def _request(url: str, data: bytes | None = None, headers: dict | None = None) -> str:
    """One HTTP round trip with a browser-like agent (some endpoints reject bots)."""
    head = {"User-Agent": USER_AGENT, "Accept": "application/json,text/plain,*/*"}
    head.update(headers or {})
    if data is not None:
        head.setdefault("Content-Type", "application/x-www-form-urlencoded")
    req = urllib.request.Request(url, data=data, headers=head)
    try:
        with urllib.request.urlopen(req, timeout=_timeout()) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        transient = e.code in RETRY_STATUS
        raise _ProviderError(f"HTTP {e.code}", transient=transient) from e
    except urllib.error.URLError as e:
        raise _ProviderError(f"network unreachable ({e.reason})", transient=True) from e
    except (TimeoutError, OSError) as e:
        raise _ProviderError(f"network unreachable ({e.__class__.__name__})", transient=True) from e


def _default_fetch(url: str) -> str:
    """Backwards-compatible single-provider fetch used by older call sites and tests."""
    return _request(url)


# ------------------------------------------------------------------ provider adapters
def _decode_gtx(payload: str) -> str:
    """The gtx endpoint returns nested arrays; segment [i][0] is the translated text."""
    try:
        data = json.loads(payload)
    except (ValueError, TypeError) as e:
        raise _ProviderError("unreadable response") from e
    parts = []
    try:
        for segment in data[0]:
            if isinstance(segment, (list, tuple)) and segment and segment[0]:
                parts.append(str(segment[0]))
    except (IndexError, TypeError) as e:
        raise _ProviderError("unexpected response shape") from e
    out = "".join(parts).strip()
    if not out:
        raise _ProviderError("no text returned")
    return out


def _google_web(text: str, source: str, target: str) -> str:
    url = GTX_URL.format(sl=urllib.parse.quote(source), tl=urllib.parse.quote(target),
                         q=urllib.parse.quote(text))
    return _decode_gtx(_request(url))


def _google_web_alt(text: str, source: str, target: str) -> str:
    """A second keyless Google host - blocked independently of the first one."""
    url = GTX5_URL.format(sl=urllib.parse.quote(source), tl=urllib.parse.quote(target),
                          q=urllib.parse.quote(text))
    payload = _request(url)
    try:
        data = json.loads(payload)
    except (ValueError, TypeError) as e:
        raise _ProviderError("unreadable response") from e
    if isinstance(data, dict):
        return str(data.get("sentences") and "".join(
            s.get("trans", "") for s in data["sentences"]) or data.get("trans") or "").strip()
    if isinstance(data, list):
        return "".join(str(x) for x in data if isinstance(x, str)).strip()
    raise _ProviderError("unexpected response shape")


def _google_cloud(text: str, source: str, target: str) -> str:
    key = (os.environ.get("GOOGLE_TRANSLATE_API_KEY") or "").strip()
    if not key:
        raise _ProviderError("GOOGLE_TRANSLATE_API_KEY is not set")
    body = urllib.parse.urlencode({"q": text, "source": source, "target": target,
                                   "format": "text"}).encode()
    url = "https://translation.googleapis.com/language/translate/v2?key=" + urllib.parse.quote(key)
    payload = _request(url, data=body)
    try:
        return str(json.loads(payload)["data"]["translations"][0]["translatedText"]).strip()
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise _ProviderError("unexpected response shape") from e


def _deepl(text: str, source: str, target: str) -> str:
    key = (os.environ.get("DEEPL_API_KEY") or "").strip()
    if not key:
        raise _ProviderError("DEEPL_API_KEY is not set")
    free = (os.environ.get("DEEPL_FREE") or "1").strip() not in ("0", "false", "no")
    body = urllib.parse.urlencode({"text": text, "source_lang": source.upper(),
                                   "target_lang": target.split("-")[0].upper()}).encode()
    payload = _request(DEEPL_URL.format(free="api-free" if free else ""),
                       data=body, headers={"Authorization": f"DeepL-Auth-Key {key}"})
    try:
        return str(json.loads(payload)["translations"][0]["text"]).strip()
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise _ProviderError("unexpected response shape") from e


def _libretranslate(text: str, source: str, target: str) -> str:
    base = (os.environ.get("LIBRETRANSLATE_URL") or "").strip().rstrip("/")
    if not base:
        raise _ProviderError("LIBRETRANSLATE_URL is not set")
    form = {"q": text, "source": source, "target": target, "format": "text"}
    key = (os.environ.get("LIBRETRANSLATE_API_KEY") or "").strip()
    if key:
        form["api_key"] = key
    payload = _request(base + "/translate", data=urllib.parse.urlencode(form).encode())
    try:
        return str(json.loads(payload)["translatedText"]).strip()
    except (ValueError, KeyError, TypeError) as e:
        raise _ProviderError("unexpected response shape") from e


def _mymemory(text: str, source: str, target: str) -> str:
    if len(text) > 500:                     # the anonymous service rejects long queries
        raise _ProviderError("string too long for MyMemory")
    url = MYMEMORY_URL.format(q=urllib.parse.quote(text), sl=source, tl=target)
    email = (os.environ.get("MYMEMORY_EMAIL") or "").strip()
    if email:
        url += "&de=" + urllib.parse.quote(email)
    payload = _request(url)
    try:
        data = json.loads(payload)
        if str(data.get("responseStatus")) not in ("200", "None"):
            raise _ProviderError("HTTP %s" % data.get("responseStatus"))
        out = str(data["responseData"]["translatedText"]).strip()
    except (ValueError, KeyError, TypeError) as e:
        raise _ProviderError("unexpected response shape") from e
    if not out or "MYMEMORY WARNING" in out.upper():
        raise _ProviderError("quota exceeded", transient=True)
    return out


PROVIDERS = {
    "google": _google_web,
    "google-cloud": _google_cloud,
    "deepl": _deepl,
    "libretranslate": _libretranslate,
    "mymemory": _mymemory,
}


# ------------------------------------------------------------------ configuration
def translation_mode() -> str:
    return (os.environ.get("TRANSLATE_PROVIDER") or "auto").strip().lower() or "auto"


def providers_for(source: str, target: str) -> list[str]:
    """The provider order for one language pair."""
    mode = translation_mode()
    if mode in ("none", "off", "disabled", "manual"):
        return []
    src = source.split("-")[0].lower()
    tgt = target.split("-")[0].lower()
    if src == tgt:                       # same language: only a regional variant exists
        return []
    if mode not in ("", "auto"):
        return [mode] if mode in PROVIDERS else []
    order: list[str] = []
    if os.environ.get("GOOGLE_TRANSLATE_API_KEY"):
        order.append("google-cloud")
    if os.environ.get("DEEPL_API_KEY") and src in _DEEPL_LANGS:
        order.append("deepl")
    if os.environ.get("LIBRETRANSLATE_URL"):
        order.append("libretranslate")
    order += ["google", "mymemory", "google-alt"]
    return order


_DEEPL_LANGS = {"en", "de", "fr", "es", "it", "pt", "nl", "pl", "ru", "ja", "zh", "ko",
                "tr", "uk", "sv", "da", "fi", "nb", "cs", "sk", "hu", "ro", "el", "bg"}

_ADAPTERS = dict(PROVIDERS, **{"google-alt": _google_web_alt})


def _call_provider(name: str, text: str, source: str, target: str) -> str:
    fn = _ADAPTERS.get(name)
    if fn is None:
        raise _ProviderError("unknown provider")
    try:
        out = fn(text, source, target)
    except _ProviderError:
        raise
    except TranslationError:
        raise
    except Exception as e:                       # adapters must never leak raw tracebacks
        raise _ProviderError(e.__class__.__name__)
    if not (out or "").strip():
        raise _ProviderError("empty translation")
    return out.strip()


def translate_with_trace(text: str, target: str, source: str = "en") -> tuple[str, dict]:
    """Translate and report which provider answered plus every failed attempt."""
    attempts: list[dict] = []
    for name in providers_for(source, target):
        for attempt in (1, 2):
            try:
                out = _call_provider(name, text, source.split("-")[0], target.split("-")[0])
                return out, {"provider": name, "attempts": attempts}
            except _ProviderError as e:
                attempts.append({"provider": name, "error": str(e)})
                if e.transient and attempt == 1:
                    time.sleep(0.4)
                    continue
                break
    if not attempts:
        raise TranslationError("AI translation is switched off (TRANSLATE_PROVIDER=none)")
    seen, parts = set(), []
    for a in attempts:
        label = f"{a['provider']}: {a['error']}"
        if label not in seen:
            seen.add(label)
            parts.append(label)
    raise TranslationError("translation service unavailable (" + "; ".join(parts[-4:]) + ")")


def machine_translate(text: str, target: str, source: str = "en",
                      fetcher=None) -> str:
    """Translate one plain-text string. Raises :class:`TranslationError` on any failure."""
    text = (text or "").strip()
    if not text:
        return ""
    if source.split("-")[0] == "en" and target.startswith("en-") and target != source:
        return localize_english(text, target)
    if len(text) > MAX_CHARS:
        raise TranslationError(f"string longer than {MAX_CHARS} characters - translate by hand")
    if fetcher is not None:                  # test/embedding hook: google-web shaped payload
        url = GTX_URL.format(sl=urllib.parse.quote(source.split("-")[0]),
                             tl=urllib.parse.quote(target.split("-")[0]),
                             q=urllib.parse.quote(text))
        try:
            return _decode_gtx(fetcher(url))
        except _ProviderError as e:
            raise TranslationError(str(e)) from e
        except Exception as e:              # a test/embedding fetcher that raises
            raise TranslationError(f"machine translation unavailable ({e.__class__.__name__})") from e
    out, _trace = translate_with_trace(text, target, source)
    return out


# ------------------------------------------------------------------ status / diagnostics
def status(probe_text: str = "", probe_lang: str = "hi") -> dict:
    """What the Studio shows about the translator, and optionally a live probe.

    Never includes credentials - only provider names and the outcome of one call.
    """
    mode = translation_mode()
    names = providers_for("en-US", "hi")
    out = {
        "mode": mode,
        "enabled": bool(names),
        "providers": [{"name": n, "label": PROVIDER_LABELS.get(n, n)} for n in names],
        "configured": {
            "google_cloud": bool(os.environ.get("GOOGLE_TRANSLATE_API_KEY")),
            "deepl": bool(os.environ.get("DEEPL_API_KEY")),
            "libretranslate": bool(os.environ.get("LIBRETRANSLATE_URL")),
        },
        "hint": "",
        "probe": None,
    }
    if not names:
        out["hint"] = ("AI translation is switched off. Set TRANSLATE_PROVIDER to google, "
                       "deepl, google-cloud, libretranslate or mymemory, or translate by hand / CSV.")
    elif mode == "auto":
        out["hint"] = ("Trying " + ", ".join(PROVIDER_LABELS.get(n, n) for n in names) +
                       ". Set GOOGLE_TRANSLATE_API_KEY or DEEPL_API_KEY for a quota-backed "
                       "service on a hosted server.")
    if probe_text:
        try:
            text, trace = translate_with_trace(probe_text, probe_lang, "en")
            out["probe"] = {"ok": True, "provider": trace["provider"], "text": text,
                            "attempts": trace["attempts"]}
        except TranslationError as e:
            out["probe"] = {"ok": False, "error": str(e)}
    return out


# ------------------------------------------------------------------ English localisation

# Offline English-variant localisation.  When the target is another English flavour
# (en-GB, en-AU, ...) we never need the network: a deterministic spelling pass turns
# US spellings into the target flavour.  This keeps "AI-translate" genuinely useful
# for English regional studies even where no translation service is reachable.
_IZE_KEEP = {"size", "sizes", "sized", "sizing", "prize", "prizes", "prized",
             "seize", "seizes", "seized", "seizing", "capsize", "capsized"}
_OUR_BASE = ("color", "favor", "honor", "labor", "humor", "rumor", "odor", "flavor",
             "behavior", "neighbor", "harbor", "savor", "vapor", "ardor", "fervor",
             "clamor", "endeavor", "armor")
_OUR_SUFFIX = ("", "s", "ed", "ing", "ite", "ites", "able", "ably", "less", "ful",
               "fully", "ism")
_RE_WORDS = {"center": "centre", "centers": "centres", "theater": "theatre",
             "theaters": "theatres", "fiber": "fibre", "fibers": "fibres",
             "liter": "litre", "liters": "litres", "maneuver": "manoeuvre",
             "maneuvers": "manoeuvres", "gray": "grey", "grays": "greys"}


def localize_english(text: str, target: str) -> str:
    """US -> other-English spelling localisation (offline, deterministic)."""
    def ize(m):
        base, suf = m.group(1), m.group(2)
        if (base + suf).lower() in _IZE_KEEP:
            return base + suf
        return base + suf.replace("z", "s")

    def our(m):
        base = m.group(1)[:-2] + "our"          # color -> colour, honored -> honoured
        if m.group(1)[0].isupper():
            base = base[0].upper() + base[1:]
        return base + m.group(2)

    out = re.sub(r"\b([A-Za-z]+?)(ize|izes|ized|izing|ization|izations)\b", ize, text)
    pat = (r"\b(" + "|".join(_OUR_BASE) + r")(" +
           "|".join(sorted(_OUR_SUFFIX, key=len, reverse=True)) + r")\b")
    out = re.sub(pat, our, out, flags=re.IGNORECASE)
    out = re.sub(r"\b([A-Za-z]+?)yze(s|d)?\b",
                 lambda m: m.group(1) + "yse" + (m.group(2) or ""), out)
    out = re.sub(r"\b(catalog|analog|dialog|monolog|prolog|epilog)(ue)?(s)?\b",
                 lambda m: m.group(1) + "ue" + ("s" if m.group(3) else ""), out)
    out = re.sub(r"\b(travel|marvel)(ed|ing|er|ers)\b",
                 lambda m: m.group(1) + m.group(1)[-1] + m.group(2), out)
    for us, uk in _RE_WORDS.items():
        out = re.sub(r"\b%s\b" % us, uk, out, flags=re.IGNORECASE)
    return out


TAG_SPLIT = re.compile(r"(<[^>]+>)")


def translate_html(html: str, target: str, source: str = "en", fetcher=None) -> str:
    """Translate only the text nodes of a rich-text string, keeping every tag in place."""
    out, pending, joined = [], [], []

    def flush():
        if not pending:
            return
        # one request per run of adjacent text nodes keeps tags where they were
        blob = "\n".join(joined)
        done = machine_translate(blob, target, source, fetcher)
        lines = done.split("\n")
        for i, node in enumerate(pending):
            out.append(lines[i] if i < len(lines) else done)
        pending.clear(), joined.clear()

    for token in TAG_SPLIT.split(str(html)):
        if token.startswith("<") and token.endswith(">"):
            flush()
            out.append(token)
        elif token.strip():
            pending.append(token)
            joined.append(token)
        else:
            out.append(token)
    flush()
    return "".join(out)


def translate_string(text: str, target: str, source: str = "en",
                     fetcher=None, html: bool = False) -> str:
    return (translate_html(text, target, source, fetcher) if html
            else machine_translate(text, target, source, fetcher))
