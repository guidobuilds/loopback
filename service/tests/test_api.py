"""B2: POST /feedback status contract + append-only persistence; read-back.

Covers: 401 (no/bad token), 400 (schema-invalid), 422+quarantine (leaked PII
NOT stored in `records`), 200 (valid record stored), and that a stored record is
retrievable via the admin-only GET /feedback read-back.

Auth model: any valid per-user token may POST; GET /feedback requires an ADMIN
token (403 for a valid non-admin token, 401 for no/invalid token).
"""
from __future__ import annotations

from tests.conftest import load_fixture


def test_healthz_ok(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_no_token_is_401(client):
    r = client.post("/feedback", json=load_fixture("record.valid.json"))
    assert r.status_code == 401


def test_wrong_token_is_401(client):
    r = client.post(
        "/feedback",
        json=load_fixture("record.valid.json"),
        headers={"Authorization": "Bearer nope"},
    )
    assert r.status_code == 401


def test_post_works_with_non_admin_token(client, token):
    # Any valid per-user token (admin or not) may submit feedback.
    r = client.post(
        "/feedback",
        json=load_fixture("record.valid.json"),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text


def test_post_works_with_admin_token(client, admin_token):
    body = load_fixture("record.valid.json")
    body["id"] = "fb_01J8ZQK3M7N2P5R8T1V4W6X9A1"
    r = client.post(
        "/feedback",
        json=body,
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200, r.text


def test_schema_invalid_is_400_not_422(client, token):
    # Missing required `summary` -> schema-invalid -> 400 (NOT 422; 422 reserved).
    r = client.post(
        "/feedback",
        json=load_fixture("record.missing-summary.json"),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 400, r.text


def test_extra_field_is_400(client, token):
    body = load_fixture("record.valid.json")
    body["sneaky"] = "extra"  # additionalProperties: false
    r = client.post(
        "/feedback", json=body, headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 400, r.text


def test_leaked_pii_is_422_and_quarantined_not_stored(client, token, admin_token):
    r = client.post(
        "/feedback",
        json=load_fixture("record.with-leaked-email.json"),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 422, r.text
    body = r.json()
    assert "email" in body.get("patterns", [])

    # The quarantined record is NOT in the append-only store (admin read-back).
    rr = client.get("/feedback", headers={"Authorization": f"Bearer {admin_token}"})
    assert rr.status_code == 200
    ids = [rec["id"] for rec in rr.json()]
    assert "fb_01J8ZQK3M7N2P5R8T1V4W6X9Y2" not in ids


def test_happy_path_stores_and_returns_server_id(client, token):
    r = client.post(
        "/feedback",
        json=load_fixture("record.valid.json"),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"].startswith("fb_srv_"), body
    assert body["status"] == "stored", body
    # The MVP response is just {id, status}; routing fields are gone.
    assert set(body.keys()) == {"id", "status"}, body


def test_stored_record_is_retrievable_via_get_feedback(client, token, admin_token):
    # Append-only store: a valid record is retrievable via the admin-only
    # GET /feedback ("review all feedback received").
    post = client.post(
        "/feedback",
        json=load_fixture("record.valid.json"),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert post.status_code == 200, post.text

    via_feedback = client.get(
        "/feedback", headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert via_feedback.status_code == 200
    recs = via_feedback.json()
    assert any(rec["id"] == "fb_01J8ZQK3M7N2P5R8T1V4W6X9Y0" for rec in recs), recs
    # The stored record carries its data through unchanged. anonUserId is gone
    # from the wire contract entirely — the submitter is resolved server-side
    # from the auth token (records.user_id), never carried on the record.
    stored = next(rec for rec in recs if rec["id"] == "fb_01J8ZQK3M7N2P5R8T1V4W6X9Y0")
    assert stored["artifact"]["id"] == "prd-writer", stored
    assert "anonUserId" not in stored, stored
    assert stored["serverId"].startswith("fb_srv_"), stored

    # The persisted record links to the authenticated submitter (records.user_id
    # NOT NULL FK), resolved from the POSTing token — here the non-admin `dev`.
    from sqlalchemy import select

    from app.orm import Record, User

    session = client.app.state.session_factory()
    try:
        row = session.execute(
            select(User.email)
            .join(Record, Record.user_id == User.id)
            .where(Record.id == stored["serverId"])
        ).scalar_one()
    finally:
        session.close()
    assert row == "dev@example.com", row


def test_get_feedback_requires_token(client):
    assert client.get("/feedback").status_code == 401


def test_get_feedback_invalid_token_is_401(client):
    assert client.get(
        "/feedback", headers={"Authorization": "Bearer nope"}
    ).status_code == 401


def test_get_feedback_non_admin_token_is_403(client, token):
    # A valid but non-admin token is authenticated yet NOT authorized to read.
    r = client.get("/feedback", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403, r.text


def test_get_feedback_admin_token_is_200(client, admin_token):
    r = client.get("/feedback", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200, r.text


def test_prose_with_slashes_is_200_not_422(client, token):
    # Regression: the redaction re-check must NOT treat ordinary "/"-delimited
    # prose ("Problem/Solution/Metrics", "TCP/IP", "and/or") as a filesystem path.
    # A clean summary like this must be ACCEPTED (200), never quarantined (422).
    body = load_fixture("record.valid.json")
    body["id"] = "fb_01J8ZQK3M7N2P5R8T1V4W6X9Z9"
    body["summary"] = (
        "PRDs should use the Problem/Solution/Metrics template; "
        "support TCP/IP and/or UDP; read/write access required."
    )
    body["evidenceExcerpt"] = "Problem/Solution/Metrics and/or freeform — no leak here."
    r = client.post(
        "/feedback", json=body, headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "stored"


def _seed(client, token, n):
    # Append n valid records with distinct ids; returns them oldest-first by id.
    ids = []
    for i in range(n):
        body = load_fixture("record.valid.json")
        body["id"] = f"fb_01J8ZQK3M7N2P5R8T1V4W6X{i:03d}"
        r = client.post(
            "/feedback", json=body, headers={"Authorization": f"Bearer {token}"}
        )
        assert r.status_code == 200, r.text
        ids.append(body["id"])
    return ids


def test_pagination_limit_and_offset(client, token, admin_token):
    ids = _seed(client, token, 5)
    hdr = {"Authorization": f"Bearer {admin_token}"}

    # limit caps the page; records come back oldest-first (created_at order).
    page = client.get("/feedback?limit=2", headers=hdr)
    assert page.status_code == 200, page.text
    assert [r["id"] for r in page.json()] == ids[:2]

    # offset skips into the list; limit+offset windows the result.
    page2 = client.get("/feedback?limit=2&offset=2", headers=hdr)
    assert [r["id"] for r in page2.json()] == ids[2:4]

    # offset past the end yields an empty page, not an error.
    assert client.get("/feedback?offset=99", headers=hdr).json() == []


def test_pagination_default_caps_at_100(client, token, admin_token):
    # Part B: a param-less GET now returns at most the default page (100), NOT
    # the whole corpus. Seed 101 and assert exactly 100 come back (oldest-first).
    ids = _seed(client, token, 101)
    r = client.get("/feedback", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 100
    assert [rec["id"] for rec in body] == ids[:100]


def test_limit_zero_returns_all(client, token, admin_token):
    # Part B: ?limit=0 is the explicit "give me everything" escape hatch.
    ids = _seed(client, token, 105)
    r = client.get("/feedback?limit=0", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    assert [rec["id"] for rec in r.json()] == ids  # all 105, oldest-first


def test_pagination_bad_params_are_400_not_422(client, admin_token):
    # Invalid pagination is client error -> 400; 422 stays reserved for quarantine.
    # NOTE: limit=0 is now VALID (means "all"); the negative case is limit=-1.
    hdr = {"Authorization": f"Bearer {admin_token}"}
    assert client.get("/feedback?limit=-1", headers=hdr).status_code == 400
    assert client.get("/feedback?limit=abc", headers=hdr).status_code == 400
    assert client.get("/feedback?offset=-1", headers=hdr).status_code == 400


def test_pagination_requires_token(client):
    # Auth is checked before pagination parsing.
    assert client.get("/feedback?limit=2").status_code == 401


def _seed_record(client, *, id, artifact_id="prd-writer", severity=None,
                 confidence=None, created_at=None, user_email="dev@example.com",
                 is_admin=False):
    """Insert one Record directly via the ORM with controlled attributes.

    POSTing goes through redaction/now() and can't set created_at or arbitrary
    severity combos precisely, so the filter/range tests write rows directly
    (linked to a real user so the email filter + submitterEmail can be exercised).
    """
    from app import db as db_mod
    from app.orm import Record

    session = client.app.state.session_factory()
    try:
        user = db_mod.get_or_create_user(
            session, user_email, is_admin=is_admin, created_at="2026-01-01T00:00:00Z"
        )
        session.flush()
        session.add(Record(
            id="fb_srv_" + id,
            client_id=id,
            schema_version=1,
            artifact_kind="skill",
            artifact_id=artifact_id,
            summary="seeded record " + id,
            severity=severity,
            confidence=confidence,
            created_at=created_at or "2026-05-24T00:00:00Z",
            user_id=user.id,
        ))
        session.commit()
    finally:
        session.close()
    return id


def test_filter_by_artifact(client, admin_token):
    _seed_record(client, id="a1", artifact_id="prd-writer")
    _seed_record(client, id="a2", artifact_id="code-reviewer")
    hdr = {"Authorization": f"Bearer {admin_token}"}
    r = client.get("/feedback?artifact=prd-writer", headers=hdr)
    assert r.status_code == 200, r.text
    ids = [rec["id"] for rec in r.json()]
    assert ids == ["a1"], ids


def test_filter_by_severity(client, admin_token):
    _seed_record(client, id="s1", severity="high")
    _seed_record(client, id="s2", severity="low")
    hdr = {"Authorization": f"Bearer {admin_token}"}
    r = client.get("/feedback?severity=high", headers=hdr)
    assert r.status_code == 200, r.text
    assert [rec["id"] for rec in r.json()] == ["s1"]


def test_filter_by_confidence(client, admin_token):
    _seed_record(client, id="c1", confidence="high")
    _seed_record(client, id="c2", confidence="medium")
    hdr = {"Authorization": f"Bearer {admin_token}"}
    r = client.get("/feedback?confidence=medium", headers=hdr)
    assert r.status_code == 200, r.text
    assert [rec["id"] for rec in r.json()] == ["c2"]


def test_filter_by_email(client, admin_token):
    _seed_record(client, id="e1", user_email="alice@example.com")
    _seed_record(client, id="e2", user_email="bob@example.com")
    hdr = {"Authorization": f"Bearer {admin_token}"}
    r = client.get("/feedback?email=alice@example.com", headers=hdr)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [rec["id"] for rec in body] == ["e1"]
    assert body[0]["submitterEmail"] == "alice@example.com"


def test_filter_by_received_range_inclusive(client, admin_token):
    _seed_record(client, id="d1", created_at="2026-05-20T00:00:00Z")
    _seed_record(client, id="d2", created_at="2026-05-21T00:00:00Z")
    _seed_record(client, id="d3", created_at="2026-05-22T00:00:00Z")
    hdr = {"Authorization": f"Bearer {admin_token}"}
    # Inclusive on both ends: from d1's date to d2's date includes both.
    r = client.get(
        "/feedback?received_from=2026-05-20T00:00:00Z&received_to=2026-05-21T00:00:00Z",
        headers=hdr,
    )
    assert r.status_code == 200, r.text
    assert [rec["id"] for rec in r.json()] == ["d1", "d2"]


def test_combined_filters(client, admin_token):
    _seed_record(client, id="m1", artifact_id="prd-writer", severity="high",
                 user_email="alice@example.com")
    _seed_record(client, id="m2", artifact_id="prd-writer", severity="low",
                 user_email="alice@example.com")
    _seed_record(client, id="m3", artifact_id="code-reviewer", severity="high",
                 user_email="alice@example.com")
    hdr = {"Authorization": f"Bearer {admin_token}"}
    r = client.get(
        "/feedback?artifact=prd-writer&severity=high&email=alice@example.com",
        headers=hdr,
    )
    assert r.status_code == 200, r.text
    assert [rec["id"] for rec in r.json()] == ["m1"]


def test_invalid_severity_filter_is_400(client, admin_token):
    hdr = {"Authorization": f"Bearer {admin_token}"}
    assert client.get("/feedback?severity=critical", headers=hdr).status_code == 400


def test_invalid_confidence_filter_is_400(client, admin_token):
    hdr = {"Authorization": f"Bearer {admin_token}"}
    assert client.get("/feedback?confidence=maybe", headers=hdr).status_code == 400


def test_submitter_email_present(client, token, admin_token):
    # The GET response carries a server-added submitterEmail matching the user
    # whose token submitted the record (the non-admin `dev`), and never anonUserId.
    post = client.post(
        "/feedback",
        json=load_fixture("record.valid.json"),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert post.status_code == 200, post.text
    r = client.get("/feedback", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    rec = next(x for x in r.json() if x["id"] == "fb_01J8ZQK3M7N2P5R8T1V4W6X9Y0")
    assert rec["submitterEmail"] == "dev@example.com", rec
    assert "anonUserId" not in rec, rec


def test_real_path_in_summary_is_422(client, token):
    # The narrowed heuristic must STILL catch genuine paths: a real absolute path
    # in an otherwise prose-y summary is a leak -> 422 + quarantine.
    body = load_fixture("record.valid.json")
    body["id"] = "fb_01J8ZQK3M7N2P5R8T1V4W6X9Z8"
    body["summary"] = "Problem/Solution/Metrics template lives at /Users/alice/secret/notes.md"
    r = client.post(
        "/feedback", json=body, headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 422, r.text
    assert "posix_user_path" in r.json().get("patterns", [])
