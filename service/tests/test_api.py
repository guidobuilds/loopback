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
    # The stored record carries its identifying data through unchanged.
    stored = next(rec for rec in recs if rec["id"] == "fb_01J8ZQK3M7N2P5R8T1V4W6X9Y0")
    assert stored["artifact"]["id"] == "prd-writer", stored
    assert stored["anonUserId"] == "u_8f2a1c9d", stored
    assert stored["serverId"].startswith("fb_srv_"), stored


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


def test_pagination_default_returns_all(client, token, admin_token):
    ids = _seed(client, token, 3)
    r = client.get("/feedback", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    assert sorted(rec["id"] for rec in r.json()) == sorted(ids)


def test_pagination_bad_params_are_400_not_422(client, admin_token):
    # Invalid pagination is client error -> 400; 422 stays reserved for quarantine.
    hdr = {"Authorization": f"Bearer {admin_token}"}
    assert client.get("/feedback?limit=0", headers=hdr).status_code == 400
    assert client.get("/feedback?limit=abc", headers=hdr).status_code == 400
    assert client.get("/feedback?offset=-1", headers=hdr).status_code == 400


def test_pagination_requires_token(client):
    # Auth is checked before pagination parsing.
    assert client.get("/feedback?limit=2").status_code == 401


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
