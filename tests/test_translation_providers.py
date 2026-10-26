"""Translation providers, the child-survey flow and the CSV round trip.

The hosted deployment is where AI translation used to fail silently, so these tests
pin the behaviour that keeps it explainable: a provider chain, readable errors, an
early stop when the service is unreachable, and a CSV path that needs no network.
"""

from __future__ import annotations

import pytest

from core import translator


@pytest.fixture()
def study(client):
    cfg = {"language": "en-US", "sections": [{"id": "S1", "title": "Screener"}],
           "questions": [{"id": "Q1", "section": "S1", "type": "single_select",
                          "stem": "Which therapy?",
                          "options": [{"code": 1, "label": "Chemotherapy"},
                                      {"code": 2, "label": "Immunotherapy"}]}]}
    assert client.post("/api/studio/save", json={"slug": "tr-parent", "title": "TR", "cfg": cfg}).status_code == 200
    return "tr-parent"


def test_google_payload_is_decoded():
    payload = '[[["नमस्ते", "Hello", null, null]], null, "en"]'
    assert translator._decode_gtx(payload) == "नमस्ते"


def test_fetcher_hook_still_works():
    assert translator.machine_translate("Hello", "hi", fetcher=lambda url: '[[["नमस्ते"]]]') == "नमस्ते"


def test_provider_chain_falls_back(monkeypatch):
    calls = []

    def boom(*a):
        calls.append("google")
        raise translator._ProviderError("HTTP 403")

    def works(*a):
        calls.append("mymemory")
        return "ठीक है"

    monkeypatch.setenv("TRANSLATE_PROVIDER", "auto")
    monkeypatch.delenv("GOOGLE_TRANSLATE_API_KEY", raising=False)
    monkeypatch.delenv("DEEPL_API_KEY", raising=False)
    monkeypatch.delenv("LIBRETRANSLATE_URL", raising=False)
    monkeypatch.setitem(translator._ADAPTERS, "google", boom)
    monkeypatch.setitem(translator._ADAPTERS, "mymemory", works)
    text, trace = translator.translate_with_trace("OK", "hi", "en")
    assert text == "ठीक है"
    assert trace["provider"] == "mymemory"
    assert calls == ["google", "mymemory"]


def test_error_names_every_provider(monkeypatch):
    monkeypatch.setenv("TRANSLATE_PROVIDER", "auto")
    monkeypatch.delenv("GOOGLE_TRANSLATE_API_KEY", raising=False)
    monkeypatch.delenv("DEEPL_API_KEY", raising=False)
    monkeypatch.delenv("LIBRETRANSLATE_URL", raising=False)
    for name in ("google", "mymemory"):
        monkeypatch.setitem(translator._ADAPTERS, name,
                            lambda *a, **k: (_ for _ in ()).throw(translator._ProviderError("HTTP 429")))
    with pytest.raises(translator.TranslationError) as e:
        translator.machine_translate("Hello", "hi")
    assert "google" in str(e.value) and "mymemory" in str(e.value)


def test_translation_can_be_switched_off(monkeypatch):
    monkeypatch.setenv("TRANSLATE_PROVIDER", "none")
    assert translator.providers_for("en-US", "hi") == []
    with pytest.raises(translator.TranslationError):
        translator.machine_translate("Hello", "hi")
    assert translator.status()["enabled"] is False


def test_english_variants_never_use_the_network(monkeypatch):
    monkeypatch.setenv("TRANSLATE_PROVIDER", "none")
    assert translator.machine_translate("Color the center", "en-GB") == "Colour the centre"


def test_providers_skip_same_language():
    assert translator.providers_for("en-US", "en-GB") == []


def test_status_reports_a_probe(monkeypatch):
    monkeypatch.setenv("TRANSLATE_PROVIDER", "auto")
    monkeypatch.setitem(translator._ADAPTERS, "google", lambda *a: "अगला")
    st = translator.status(probe_text="Next", probe_lang="hi")
    assert st["probe"] == {"ok": True, "provider": "google", "text": "अगला", "attempts": []}


def test_child_survey_translates_questions_but_not_interface(client, study, monkeypatch):
    assert client.post("/api/studio/globalize", json={"slug": study, "lang": "hi"}).get_json()["slug"] == "tr-parent--hi"
    table = {
        "Which therapy?": "कौन सी चिकित्सा?",
        "Chemotherapy": "कीमोथेरेपी", "Immunotherapy": "इम्यूनोथेरेपी",
        "Screener": "स्क्रीनर",
    }
    monkeypatch.setenv("TRANSLATE_PROVIDER", "auto")
    monkeypatch.setitem(translator._ADAPTERS, "google",
                        lambda text, *a: table.get(text, "अनुवाद: " + text))
    r = client.post("/api/studio/autotranslate", json={"slug": "tr-parent--hi", "lang": "hi"}).get_json()
    assert r["translated"] > 0 and r["coverage"]["pct"] == 100
    # the questionnaire is translated, the interface chrome deliberately is not
    spec = client.get("/api/spec/tr-parent--hi?lang=hi").get_json()
    assert spec["questions"][0]["stem"] == "कौन सी चिकित्सा?"
    assert [o["label"] for o in spec["questions"][0]["options"]] == ["कीमोथेरेपी", "इम्यूनोथेरेपी"]
    assert spec["ui"]["next"] == "Next"
    assert spec["ui"]["begin"] == "Begin survey"
    assert spec["render_language"] == "hi"


def test_autotranslate_stops_when_the_service_is_blocked(client, study, monkeypatch):
    client.post("/api/studio/globalize", json={"slug": study, "lang": "hi"})
    monkeypatch.setenv("TRANSLATE_PROVIDER", "google")
    monkeypatch.setattr(translator, "_google_web",
                        lambda *a: (_ for _ in ()).throw(translator._ProviderError("HTTP 403")))
    monkeypatch.setitem(translator._ADAPTERS, "google", translator._google_web)
    r = client.post("/api/studio/autotranslate", json={"slug": "tr-parent--hi", "lang": "hi"}).get_json()
    assert r["translated"] == 0
    assert r["aborted"] is True
    assert len(r["failed"]) == 3
    assert "HTTP 403" in r["reason"]


def test_autotranslate_reports_when_switched_off(client, study, monkeypatch):
    client.post("/api/studio/globalize", json={"slug": study, "lang": "hi"})
    monkeypatch.setenv("TRANSLATE_PROVIDER", "none")
    r = client.post("/api/studio/autotranslate", json={"slug": "tr-parent--hi", "lang": "hi"})
    assert r.status_code == 409
    assert "switched off" in r.get_json()["error"]


def test_translation_csv_round_trip(client, study):
    client.post("/api/studio/globalize", json={"slug": study, "lang": "hi"})
    r = client.get("/api/studio/translations.csv?study=tr-parent--hi&lang=hi")
    assert r.status_code == 200
    text = r.data.decode("utf-8-sig")
    assert text.splitlines()[0] == "key,kind,context,source,translation"
    assert "q:Q1:stem" in text
    # buttons are not part of the translation worksheet - the interface stays English
    assert "ui:next" not in text
    assert not any(line.startswith("ui:") for line in text.splitlines())

    imp = client.post("/api/studio/translations/import",
                      json={"slug": "tr-parent--hi", "lang": "hi",
                            "csv": "key,translation\nq:Q1:stem,कौन सी चिकित्सा?\n"})
    assert imp.get_json()["applied"] == 1
    spec = client.get("/api/spec/tr-parent--hi?lang=hi").get_json()
    assert spec["questions"][0]["stem"] == "कौन सी चिकित्सा?"
    assert spec["ui"]["next"] == "Next"
    # a chrome key in an old spreadsheet is rejected, never stored
    chrome = client.post("/api/studio/translations/import",
                         json={"slug": "tr-parent--hi", "lang": "hi",
                               "rows": [{"key": "ui:next", "translation": "अगला"}]})
    assert chrome.status_code == 400
    # an unknown key can never be applied
    bad = client.post("/api/studio/translations/import",
                      json={"slug": "tr-parent--hi", "lang": "hi",
                            "rows": [{"key": "q:NOPE:stem", "translation": "x"}]})
    assert bad.status_code == 400


def test_status_endpoint(client, study, monkeypatch):
    monkeypatch.setenv("TRANSLATE_PROVIDER", "google")
    monkeypatch.setitem(translator._ADAPTERS, "google", lambda *a: "अगला")
    r = client.get("/api/studio/translate/status?study=tr-parent&lang=hi&probe=Next").get_json()
    assert r["probe"]["ok"] is True
    assert r["providers"][0]["name"] == "google"
