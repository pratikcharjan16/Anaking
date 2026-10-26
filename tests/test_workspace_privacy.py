"""Accepted-member privacy checks for team rosters and workspace activity."""

from core.kart import (
    can_view_workspace_activity,
    list_teams_and_collaboration,
    list_workspace_changelogs,
    read_changelog_file_text,
    record_workspace_change,
)
from models import get_db, now


def test_team_activity_and_roster_exclude_pending_and_unrelated_users(app, client):
    slug = "accepted-privacy"
    assert client.post("/api/studio/save", json={
        "slug": slug, "title": "Accepted privacy",
        "cfg": {"sections": [], "questions": []},
    }).status_code == 200
    with app.app_context():
        db, ts = get_db(), now()
        cur = db.execute(
            "INSERT INTO workspace_teams (name, slug, creator_id, description, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            ("Accepted team", "accepted-team", 101, "", ts, ts),
        )
        team_id = cur.lastrowid
        db.execute("INSERT INTO team_projects (team_id,study_slug,added_by,created_at) VALUES (?,?,?,?)",
                   (team_id, slug, 101, ts))
        members = [
            (101, "creator@team.test", "accepted", "creator-token"),
            (202, "viewer@team.test", "accepted", "viewer-token"),
            (303, "actor@team.test", "accepted", "actor-token"),
            (404, "pending@team.test", "pending", "pending-token"),
        ]
        for uid, email, status, token in members:
            db.execute(
                "INSERT INTO team_members (team_id,invited_by,user_id,email,role,status,token,created_at,accepted_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (team_id, 101, uid, email, "collaborator", status, token, ts, ts if status == "accepted" else ""),
            )

        record_workspace_change(slug, "edit", "creator update", team_id=team_id,
                                actor_user={"id": 101, "name": "Creator", "email": "creator@team.test"})
        record_workspace_change(slug, "edit", "approved update", team_id=team_id,
                                actor_user={"id": 303, "name": "Approved colleague", "email": "actor@team.test"})
        record_workspace_change(slug, "edit", "pending update", team_id=team_id,
                                actor_user={"id": 404, "name": "Pending person", "email": "pending@team.test"})
        record_workspace_change(slug, "edit", "unrelated update", team_id=team_id,
                                actor_user={"id": 999, "name": "Unrelated person", "email": "outsider@team.test"})
        record_workspace_change(slug, "edit", "anonymous update", team_id=team_id,
                                actor_user={"id": 0, "name": "Local preview", "email": "local-preview"})

        assert can_view_workspace_activity(202, "viewer@team.test", team_id=team_id)
        assert not can_view_workspace_activity(404, "pending@team.test", team_id=team_id)
        visible = list_workspace_changelogs(team_id=team_id, user_id=202,
                                            user_email="viewer@team.test", limit=50)
        summaries = {row["short_summary"] for row in visible}
        assert summaries == {"creator update", "approved update"}
        rendered = read_changelog_file_text(team_id=team_id, user_id=202,
                                            user_email="viewer@team.test", limit=50)
        assert "creator update" in rendered and "approved update" in rendered
        assert "pending@team.test" not in rendered and "outsider@team.test" not in rendered

        state = list_teams_and_collaboration(202, "viewer@team.test")
        team = next(t for t in state["teams"] if t["id"] == team_id)
        member_ids = {m.get("user_id") for m in team["members"]}
        member_emails = {m.get("email") for m in team["members"]}
        assert member_ids == {101, 202, 303}
        assert "pending@team.test" not in member_emails
        assert "pending-token" not in str(team)
        assert {row["short_summary"] for row in state["changelogs"]} == summaries

    # An anonymous request cannot use an explicit team scope to read the JSON feed or raw file.
    assert client.get("/api/workspace/changelog", query_string={"team_id": team_id}).status_code == 403
    assert client.get("/api/workspace/changelog.log", query_string={"team_id": team_id}).status_code == 403
