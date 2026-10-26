"""Demo requests are their own queue - never a registration approval."""

from __future__ import annotations

from core import accounts


def _payload(**over):
    data = {"name": "Priya Raman", "email": "priya@example.com",
            "organization": "Meridian Insights", "role": "Research lead",
            "team_size": "11-50", "message": "Quota + PPT workflow"}
    data.update(over)
    return data


def test_demo_request_is_stored_separately(client, app):
    with app.app_context():
        before_users = len(accounts.list_users())
    r = client.post("/api/demo/request", json=_payload())
    assert r.status_code == 200 and r.get_json()["received"] is True
    with app.app_context():
        rows = [dict(x) for x in accounts.get_db().execute("SELECT * FROM demo_requests")]
        assert len(rows) == 1
        assert rows[0]["organization"] == "Meridian Insights"
        assert rows[0]["status"] == "new"
        # no account was created and no approval is pending because of a demo request
        assert len(accounts.list_users()) == before_users


def test_demo_queue_lists_and_decides(client):
    rid = client.post("/api/demo/request", json=_payload()).get_json()["id"]
    q = client.get("/api/admin/console/demo-requests").get_json()
    assert q["counts"]["new"] == 1 and q["requests"][0]["id"] == rid
    r = client.post("/api/admin/console/demo-requests/decide",
                    json={"id": rid, "status": "contacted", "note": "Called back"})
    assert r.get_json()["request"]["status"] == "contacted"
    assert r.get_json()["request"]["note"] == "Called back"
    assert client.post("/api/admin/console/demo-requests/decide",
                       json={"id": rid, "status": "nonsense"}).status_code == 400
    assert client.post("/api/admin/console/demo-requests/delete",
                       json={"id": rid}).get_json()["deleted"] == rid
    assert client.get("/api/admin/console/demo-requests").get_json()["total"] == 0


def test_demo_validation_and_honeypot(client):
    assert client.post("/api/demo/request", json=_payload(email="nope")).status_code == 400
    assert client.post("/api/demo/request", json=_payload(name="A")).status_code == 400
    assert client.post("/api/demo/request", json=_payload(organization="")).status_code == 400
    # bots that fill the invisible field get a success-shaped answer and nothing stored
    r = client.post("/api/demo/request", json=_payload(website="spam.example"))
    assert r.get_json()["received"] is False
    assert client.get("/api/admin/console/demo-requests").get_json()["total"] == 0


def test_duplicate_request_is_not_stored_twice(client):
    client.post("/api/demo/request", json=_payload())
    again = client.post("/api/demo/request", json=_payload(message="again"))
    assert again.get_json().get("duplicate") is True
    assert client.get("/api/admin/console/demo-requests").get_json()["total"] == 1


def test_demo_config_is_public(client):
    d = client.get("/api/demo/config").get_json()
    assert d["ok"] is True and "new" in d["statuses"]
