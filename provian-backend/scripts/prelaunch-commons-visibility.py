#!/usr/bin/env python3
"""Review or apply the exact 2026-09-24 Commons display cleanup.

Run without flags for a read-only live plan. --apply requires a separate release
approval. Active featured bids require --forfeit-active-featured as an explicit
acknowledgment; the script never refunds, reprices, deletes, or closes anything.
"""

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request

PROJECT = "provian-ai"
DATABASE = os.environ.get("FIRESTORE_DATABASE_ID", "").strip() or "(default)"
if DATABASE != "(default)" and not re.fullmatch(r"[a-z][a-z0-9-]{2,61}[a-z0-9]", DATABASE):
    raise SystemExit(f"invalid FIRESTORE_DATABASE_ID {DATABASE!r}")
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/{urllib.parse.quote(DATABASE, safe='()')}/documents"
HUMAN = "user_6c31ec6c-fe47-4e4f-a3cf-a2467cd16667"
AGENT = "wallet_aw_af7012e6-bf06-4097-b646-3f9287728908"
HIDDEN = "hidden_prelaunch_test"

# Collection, document ID, immutable or narrowly expected fields. Every target
# was read live before this list was authored. Unexpected data aborts the run.
TARGETS = [
    ("commons_profiles", "user_7f9f7626-edd0-46bc-bdcd-2f0650a43b17", {"display_name": "FerdFerndock", "participant_type": "human", "status": "active"}),
    ("commons_profiles", "user_cb71f6d5-af68-4116-896c-e3546bd04bac", {"display_name": "FerdFerndock", "participant_type": "human", "status": "active"}),
    ("commons_profiles", AGENT, {"display_name": "Atlas Apprentice", "participant_type": "agent", "status": "active"}),
    ("commons_forum_posts", "post_15d5baa6-177d-4d9f-9498-8b53bb3754a2", {"author_wallet_id": HUMAN, "title": "Test post"}),
    ("commons_forum_posts", "post_3c36c05a-f61f-4cd6-938e-babc1a7a35b9", {"author_wallet_id": "wallet_aw_6c5e74b0-5202-414a-96d6-818d0a126ac5", "title": "Fact-base fixes drill"}),
    ("commons_forum_posts", "post_44126a8b-86ee-457e-bab9-078e424f9270", {"author_wallet_id": "wallet_aw_6c5e74b0-5202-414a-96d6-818d0a126ac5", "title": "Atlas — second post (challenge lapse control)"}),
    ("commons_forum_posts", "post_695d5869-7a00-4ffd-bb65-d091083934a4", {"author_wallet_id": "wallet_aw_6c5e74b0-5202-414a-96d6-818d0a126ac5", "parent_post_id": "post_c31da073-c7d8-4862-a5fc-b1d2f2afb632"}),
    ("commons_forum_posts", "post_c31da073-c7d8-4862-a5fc-b1d2f2afb632", {"author_wallet_id": "wallet_aw_6c5e74b0-5202-414a-96d6-818d0a126ac5", "title": "Atlas — proof"}),
    ("commons_human_jobs", "hjob_3dda33d5-1b01-4a46-a4e3-00e6569f1106", {"poster_wallet_id": HUMAN, "title": "Test", "status": "open", "applicant_count": 0}),
    ("commons_human_jobs", "hjob_56e03133-d830-47d6-ae27-c38826e7fb9f", {"poster_wallet_id": AGENT, "title": " proof: agent hires a person", "status": "completed"}),
    ("commons_human_jobs", "hjob_94769932-0002-4482-8c16-9551cc2249dc", {"poster_wallet_id": HUMAN, "title": "Compare origin stories", "status": "completed"}),
    ("commons_human_jobs", "hjob_dcbe379a-503b-46fd-9b06-a71feda42b92", {"poster_wallet_id": "wallet_aw_6c5e74b0-5202-414a-96d6-818d0a126ac5", "title": " proof: agent hires agent", "status": "completed"}),
    ("commons_human_jobs", "hjob_e19f3ea1-fd73-4804-b09a-dedc85bbf657", {"poster_wallet_id": HUMAN, "title": "Test person", "status": "completed"}),
    ("commons_wants", "want_beee5ca68f8c4ef0aaeb5b9381778692", {"poster_wallet_id": "wallet_aw_ba56afc1-56b0-4b54-98cc-25a967c6db93", "status": "cancelled"}),
    ("commons_wants", "want_e1671cd239314eb597a088a1e1d15857", {"poster_wallet_id": HUMAN, "outcome": "Test", "status": "open"}),
]


def value(field):
    for key in ("stringValue", "integerValue", "doubleValue", "booleanValue", "nullValue"):
        if key in field:
            raw = field[key]
            return int(raw) if key == "integerValue" else raw
    return None


def fields(document):
    return {key: value(field) for key, field in document.get("fields", {}).items()}


def request(token, path, *, method="GET", body=None, query=None):
    url = BASE + "/" + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    headers = {"Authorization": "Bearer " + token, "X-Goog-User-Project": PROJECT}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def commit(token, writes):
    req = urllib.request.Request(
        BASE + ":commit", method="POST", data=json.dumps({"writes": writes}).encode(),
        headers={"Authorization": "Bearer " + token, "X-Goog-User-Project": PROJECT,
                 "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def list_documents(token, collection):
    page = None
    while True:
        query = {"pageSize": 100}
        if page:
            query["pageToken"] = page
        data = request(token, collection, query=query)
        yield from data.get("documents", [])
        page = data.get("nextPageToken")
        if not page:
            break


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--forfeit-active-featured", action="store_true")
    args = parser.parse_args()
    if args.forfeit_active_featured and not args.apply:
        parser.error("--forfeit-active-featured is only meaningful with --apply")

    token = subprocess.check_output(
        ["gcloud", "auth", "print-access-token", "--account=frank.drew@gmail.com"], text=True
    ).strip()
    checked = []
    for collection, doc_id, expected in TARGETS:
        doc = request(token, f"{collection}/{doc_id}")
        actual = fields(doc)
        for key, wanted in expected.items():
            if actual.get(key) != wanted:
                raise RuntimeError(f"{collection}/{doc_id}: {key} drifted; expected {wanted!r}, got {actual.get(key)!r}")
        if actual.get("public_visibility") not in (None, HIDDEN):
            raise RuntimeError(f"{collection}/{doc_id}: unknown visibility marker")
        checked.append((collection, doc_id, doc))

    forum_ids = {doc_id for collection, doc_id, _ in checked if collection == "commons_forum_posts"}
    for doc in list_documents(token, "commons_challenges"):
        row = fields(doc)
        if row.get("post_id") in forum_ids and row.get("status") == "open":
            raise RuntimeError("a forum proof has an unresolved challenge")
    open_job = fields(request(token, "commons_human_jobs/hjob_3dda33d5-1b01-4a46-a4e3-00e6569f1106"))
    if open_job.get("escrow_id") is not None or open_job.get("accepted_applicant_wallet_id") is not None:
        raise RuntimeError("the open Test job now has a funded or accepted hire")
    for doc in list_documents(token, "commons_human_job_applications"):
        if fields(doc).get("job_id") == "hjob_3dda33d5-1b01-4a46-a4e3-00e6569f1106":
            raise RuntimeError("the open Test job now has an application")

    open_target_ids = {doc_id for _, doc_id, doc in checked if fields(doc).get("status") == "open"}
    now_ms = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
    paid = []
    for doc in list_documents(token, "commons_featured_placements"):
        row = fields(doc)
        if row.get("item_id") in open_target_ids and int(row.get("featured_until") or 0) > now_ms:
            paid.append((row.get("board"), row.get("item_id"), row.get("wallet_id"),
                         row.get("amount_atomic"), row.get("featured_until")))

    print(f"Reviewed {len(checked)} exact Commons documents; none will be deleted or repriced.")
    for board, item, wallet, amount, until in paid:
        when = dt.datetime.fromtimestamp(int(until) / 1000, dt.timezone.utc).isoformat()
        print(f"ACTIVE FEATURED {board}/{item}: bidder={wallet}, bid_atomic={amount}, ends={when}")
    if not args.apply:
        print("DRY RUN: no writes")
        return
    if paid and not args.forfeit_active_featured:
        raise RuntimeError("active paid featured visibility would end early; --forfeit-active-featured required")

    audit_path = os.path.join(tempfile.gettempdir(), f"provian-commons-cleanup-{now_ms}.json")
    fd = os.open(audit_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as audit:
        json.dump({"captured_at_ms": now_ms, "documents": [doc for _, _, doc in checked]}, audit, indent=2)
    print(f"Private pre-write snapshot: {audit_path}")

    writes = []
    for _, _, doc in checked:
        if fields(doc).get("public_visibility") == HIDDEN:
            continue
        writes.append({
            "update": {"name": doc["name"], "fields": {"public_visibility": {"stringValue": HIDDEN}}},
            "updateMask": {"fieldPaths": ["public_visibility"]},
            "currentDocument": {"updateTime": doc["updateTime"]},
        })
    if writes:
        commit(token, writes)
    print("APPLIED: public test visibility markers")


if __name__ == "__main__":
    main()
