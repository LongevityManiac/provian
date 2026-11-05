"""The Python PE meter: the sealed box, the local PE store, and the daily batch sender.

The sealed-box vector is the TypeScript SDK's (pinned in the relay's ``sealed-box.test.ts``). The
store is the TypeScript store's on-disk format; ``test_ts_reads_and_extends_a_python_store`` proves
it against the real ``FsPeStore`` when node and the backend's ``tsx`` are installed. The relay
stand-in (:class:`conftest.FakeMeterRelay`) applies the relay's position rules; the real relay's
wire checks judge the captured Python batch in the backend suite
(``provian-backend/src/core/meter/python-sdk-batch.test.ts``).
"""

import json
import os

import pytest
import requests

from provian.meter import build_pe_v2
from provian.meter_wire import act_record_of, batch_hash_of, canonical_json, pe_hash_of
from provian.pe_store import FsPeStore, PeStoreCorruptError
from provian.sealed_box import from_b64u, hchacha20, open_with_key, seal_to_key, to_b64u

from .conftest import (
    RELAY,
    TEST_DEVICE_ID,
    TEST_KEY,
    TEST_SECRET,
    FakeMeterRelay,
    FakeResponse,
    make_recorder,
    relay_body_hmac_check,
    run_ts_oracle,
    ts_oracle_available,
)

SDK_SEAL_VECTOR = {
    "anchor_secret_b64u": "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
    "anchor_public_b64u": "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw",
    "ephemeral_secret_b64u": "yMfGxcTDwsHAv769vLu6ubi3trW0s7KxsK-urayrqqk",
    "plaintext": '{"pe_id":"pe_vector","schema":"provian.pe.v2"}',
    "blob_b64u": "AY2vz-6ukEXumnjXipn88y53geRB6wcwlsNCuOLcw7YSBhxegjkAhOvYmKkaOwWyKjscbkELnKxrLEPiFxPfTgubqeTe1f9Zpg8Cohqp1Tj3JczTYuBDRe_ndLIsG-I",
}

CONTENT = {
    "action_type": "compute_session",
    "description": "FREE-TEXT-STAYS-ON-DEVICE",
    "metadata": {"tool": "python-meter-test", "network_calls": 2},
    "compute": {"duration_ms": 10},
    "geo": None,
    "execution_env": {"runtime": "python"},
    "parent_goal_pe_id": None,
}


# --- sealed box ------------------------------------------------------------------------

def test_hchacha20_matches_the_xchacha_draft_vector():
    out = hchacha20(bytes.fromhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"),
                    bytes.fromhex("000000090000004a0000000031415927"))
    assert out.hex() == "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc"


def test_seals_exactly_what_the_ts_sdk_seals_and_opens_its_box():
    v = SDK_SEAL_VECTOR
    blob = seal_to_key(from_b64u(v["anchor_public_b64u"]), v["plaintext"].encode(), from_b64u(v["ephemeral_secret_b64u"]))
    assert to_b64u(blob) == v["blob_b64u"]
    assert open_with_key(from_b64u(v["anchor_secret_b64u"]), from_b64u(v["blob_b64u"])).decode() == v["plaintext"]


def test_red_a_flipped_byte_or_the_wrong_key_does_not_open():
    v = SDK_SEAL_VECTOR
    tampered = bytearray(from_b64u(v["blob_b64u"]))
    tampered[-1] ^= 1
    with pytest.raises(Exception):
        open_with_key(from_b64u(v["anchor_secret_b64u"]), bytes(tampered))
    with pytest.raises(Exception):
        open_with_key(bytes([7] * 32), from_b64u(v["blob_b64u"]))


# --- the store -------------------------------------------------------------------------

def _append(store, n):
    out = []
    for i in range(n):
        head = store.head()
        pe = build_pe_v2(dict(CONTENT, metadata=dict(CONTENT["metadata"], network_calls=i)),
                         store.device_id, head["last_pe_hash"], 1_790_000_000_000 + i)
        assert store.append(pe)["ok"] is True
        out.append(pe)
    return out


def test_the_store_chains_pes_and_reads_them_back(store_root):
    store = FsPeStore(TEST_DEVICE_ID, store_root)
    pes = _append(store, 3)
    assert store.head() == {"count": 3, "last_pe_hash": pes[-1]["pe_hash"]}
    assert [r["pe"] for r in store.read_pes(0, 10)] == pes
    assert pes[1]["prev_hash"] == pes[0]["pe_hash"] and pes[0]["prev_hash"] == "genesis"
    assert store.find_pe(pes[2]["pe_id"])["index"] == 2
    lines = open(os.path.join(store.location, "pes.jsonl"), encoding="utf-8").read().splitlines()
    assert [json.loads(line)["i"] for line in lines] == [0, 1, 2]
    assert oct(os.stat(os.path.join(store.location, "pes.jsonl")).st_mode & 0o777) == "0o600"


def test_red_the_store_refuses_a_fork_or_a_forged_hash_and_writes_nothing(store_root):
    store = FsPeStore(TEST_DEVICE_ID, store_root)
    pes = _append(store, 1)
    fork = build_pe_v2(CONTENT, TEST_DEVICE_ID, "genesis", 1_790_000_000_500)
    assert store.append(fork)["reason"] == "head_moved"
    forged = dict(build_pe_v2(CONTENT, TEST_DEVICE_ID, pes[0]["pe_hash"], 1_790_000_000_600), pe_hash="0" * 64)
    assert store.append(forged) == {"ok": False, "reason": "invalid", "detail": "pe_hash_mismatch"}
    other = build_pe_v2(CONTENT, "dev_other", pes[0]["pe_hash"], 1_790_000_000_700)
    assert store.append(other)["detail"] == "device_mismatch"
    assert store.head()["count"] == 1


def test_a_torn_line_is_dropped_and_a_head_behind_the_file_is_reconciled(store_root):
    store = FsPeStore(TEST_DEVICE_ID, store_root)
    pes = _append(store, 2)
    path = os.path.join(store.location, "pes.jsonl")
    # A crash after the PE line was written but before head.json moved: the head is re-derived.
    head = json.load(open(os.path.join(store.location, "head.json")))
    third = build_pe_v2(CONTENT, TEST_DEVICE_ID, pes[-1]["pe_hash"], 1_790_000_000_900)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"i": 2, "at": 1, "pe": third}, separators=(",", ":")) + "\n")
        fh.write('{"i":3,"at":1,"pe":{"torn')
    assert store.head() == {"count": 3, "last_pe_hash": third["pe_hash"]}
    assert json.load(open(os.path.join(store.location, "head.json")))["bytes"] > head["bytes"]
    assert open(path, "rb").read().endswith(b"\n")


def test_red_a_reconciled_line_that_does_not_continue_the_chain_is_corruption(store_root):
    store = FsPeStore(TEST_DEVICE_ID, store_root)
    _append(store, 1)
    stray = build_pe_v2(CONTENT, TEST_DEVICE_ID, "genesis", 1_790_000_001_000)
    with open(os.path.join(store.location, "pes.jsonl"), "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"i": 1, "at": 1, "pe": stray}, separators=(",", ":")) + "\n")
    with pytest.raises(PeStoreCorruptError):
        store.head()


@pytest.mark.skipif(not ts_oracle_available(), reason="node + provian-backend tsx not installed")
def test_ts_reads_and_extends_a_python_store(store_root):
    """The TypeScript FsPeStore (the daemon's) reads every Python-written PE, appends its own after
    them, and Python reads the TS-written PE back: one chain, one format."""
    store = FsPeStore(TEST_DEVICE_ID, store_root)
    pes = _append(store, 2)
    ts = run_ts_oracle({"root": store_root, "device_id": TEST_DEVICE_ID}, script="ts_store_oracle.ts")
    assert ts["head_before"] == {"count": 2, "last_pe_hash": pes[-1]["pe_hash"]}
    assert ts["pe_ids"] == [p["pe_id"] for p in pes]
    assert ts["appended"]["prev_hash"] == pes[-1]["pe_hash"]
    rows = store.read_pes(0, 10)
    assert [r["pe"]["pe_id"] for r in rows] == [p["pe_id"] for p in pes] + [ts["appended"]["pe_id"]]
    assert pe_hash_of(rows[2]["pe"]) == ts["appended"]["pe_hash"]
    more = _append(store, 1)
    assert more[0]["prev_hash"] == ts["appended"]["pe_hash"]


# --- the sender --------------------------------------------------------------------------

def _sender(store_root, relay):
    rec = make_recorder(relay, store_root)
    return rec, rec.sender()


def test_the_first_pe_goes_out_in_a_body_bound_batch_and_its_receipt_is_filed(relay, store_root):
    rec, sender = _sender(store_root, relay)
    result = rec.record(CONTENT)
    assert result["recorded_locally"] is True
    assert len(relay.posts) == 1
    post = relay.posts[0]
    assert post["url"] == RELAY + "/v1/meter/batch"
    assert post["headers"]["Authorization"] == "DeviceKey %s:%s" % (TEST_KEY, TEST_SECRET)
    assert relay_body_hmac_check(post["headers"]["Authorization"], post["headers"]["X-Provian-Body-HMAC"], post["data"])
    batch = json.loads(post["data"])
    assert post["data"] == canonical_json(batch).encode("utf-8")
    pe = sender.store.find_pe(result["pe_id"])["pe"]
    assert batch["acts"] == [act_record_of(pe)]
    assert b"FREE-TEXT-STAYS-ON-DEVICE" not in post["data"]  # free text never leaves the device
    last = sender.store.last_batch()
    assert last["seq"] == 1 and last["batch_hash"] == batch_hash_of(batch) and last["count"] == 1
    assert last["totals"]["eligible"] == 1
    receipt = sender.store.read_receipt(1)
    assert [a["pe_id"] for a in receipt["acts"]] == [result["pe_id"]]
    assert sender.store.read_receipt(2) is None
    assert sender.store.in_flight() is None


def test_later_pes_wait_for_the_day_then_chain_from_the_last_batch(relay, store_root):
    rec, sender = _sender(store_root, relay)
    rec.record(CONTENT)
    rec.record(CONTENT)
    rec.record(CONTENT)
    assert len(relay.posts) == 1  # daily: the next two wait
    report = rec.flush()
    assert report.outcome == "sent" and report.acts_accepted == 2
    second = json.loads(relay.posts[1]["data"])
    assert second["seq"] == 2
    assert second["prev_batch_hash"] == batch_hash_of(relay.accepted[0])
    assert second["acts"][0]["prev_hash"] == relay.accepted[0]["acts"][-1]["pe_hash"]
    assert rec.status()["unsent"] == 0


def test_an_unknown_outcome_resends_the_same_batch_unchanged(store_root):
    relay = FakeMeterRelay([requests.ConnectionError("down"), FakeResponse(503, {"error": "x"})])
    rec, sender = _sender(store_root, relay)
    rec.record(CONTENT)
    assert sender.store.in_flight() is not None  # persisted before it was sent
    assert rec.flush().outcome == "deferred"
    assert rec.flush().outcome == "sent"
    assert len(relay.posts) == 3
    assert len({batch_hash_of(json.loads(p["data"])) for p in relay.posts}) == 1
    assert sender.store.last_batch()["seq"] == 1


def test_red_a_broken_act_chain_halts_batching_and_nothing_is_rewritten(store_root):
    relay = FakeMeterRelay()
    relay.tip = {"seq": 0, "batch_hash": "genesis", "last_pe_hash": "f" * 64}
    rec, sender = _sender(store_root, relay)
    rec.record(CONTENT)
    halt = sender.store.halt()
    assert halt is not None and halt["reason"] == "act_chain_broken"
    before = open(os.path.join(sender.store.location, "pes.jsonl"), "rb").read()
    assert rec.flush().outcome == "halted"
    assert len(relay.posts) == 1  # a halted store sends nothing
    assert open(os.path.join(sender.store.location, "pes.jsonl"), "rb").read() == before


def test_a_relay_that_already_holds_this_devices_batch_is_adopted(store_root):
    relay = FakeMeterRelay()
    rec, sender = _sender(store_root, relay)
    rec.record(CONTENT)
    # Lose the local record of batch 1 (its cursor); the relay still holds it.
    for name in ("batch-head.json", "batches.jsonl", "receipts.jsonl"):
        os.unlink(os.path.join(sender.store.location, name))
    rec.record(CONTENT)
    rec.flush()
    assert sender.store.halt() is None
    batches = sender.store.list_batches()
    assert batches[0]["adopted"] is True and batches[0]["seq"] == 1
    assert batches[-1]["seq"] == 2 and len(relay.accepted) == 2


def test_a_429_defers_and_the_daemon_sends_when_it_runs(store_root):
    relay = FakeMeterRelay([FakeResponse(429, {"error": "Rate limit exceeded", "retry_after": 60})])
    rec, _sender_ = _sender(store_root, relay)
    rec.record(CONTENT)
    assert rec.last_report.outcome == "deferred"
    daemon = make_recorder(FakeMeterRelay(), store_root, daemon=True)
    daemon.record(CONTENT)
    assert daemon.flush() is None  # the observer daemon batches this store; never two batchers


def test_each_pe_is_sealed_to_the_linked_human_and_opens_to_the_exact_pe(store_root):
    secret = bytes(range(1, 33))
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    pub = X25519PrivateKey.from_private_bytes(secret).public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    relay = FakeMeterRelay(seal_targets=[{"to": "linked_human", "party_id": "wallet_h", "pubkey_b64u": to_b64u(pub), "key_version": 1}])
    rec, sender = _sender(store_root, relay)
    result = rec.record(CONTENT)
    batch = json.loads(relay.posts[0]["data"])
    assert [s["to"] for s in batch["sealed"]] == ["linked_human"]
    opened = json.loads(open_with_key(secret, from_b64u(batch["sealed"][0]["box"])))
    assert opened == sender.store.find_pe(result["pe_id"])["pe"]
    assert opened["description"] == "FREE-TEXT-STAYS-ON-DEVICE"  # the person gets the whole PE
    assert batch_hash_of(batch) == sender.store.last_batch()["batch_hash"]  # sealed copies are not hashed


def test_proofs_are_filed_and_one_that_does_not_recompute_is_kept_unverified(relay, store_root):
    rec, sender = _sender(store_root, relay)
    rec.record(CONTENT)
    last = sender.store.last_batch()
    receipt = relay.receipts[last["batch_hash"]]
    anchor = {"day": "2026-10-02", "anchor_batch_id": "0x" + "9" * 64, "leaf_index": 0, "leaf_count": 1,
              "leaf_hash": "0x" + "8" * 64, "proof": [], "merkle_root": "0x" + "6" * 64, "anchor_tx_hash": None, "anchored_at_ms": 1}
    relay.proofs = [
        {"seq": 1, "batch_hash": last["batch_hash"], "batch_leaf": receipt["batch_leaf"], "acts_root": last["acts_root"],
         "actor_id": receipt["actor_id"], "anchor": anchor},
        {"seq": 2, "batch_hash": "c" * 64, "batch_leaf": "d" * 64, "acts_root": "e" * 64, "actor_id": "x", "anchor": anchor},
    ]
    assert sender.fetch_proofs() == {"ok": 1, "fetched": 2, "unverified": 1}
    assert [p["verified"] for p in sender.store.list_proofs()] == [True, False]
    assert sender.fetch_proofs()["fetched"] == 0  # nothing held twice


def test_the_recorder_reads_proofs_daily_not_on_every_send(store_root):
    clock = [1_790_000_000.0]
    relay = FakeMeterRelay()
    rec = make_recorder(relay, store_root, now=lambda: clock[0])
    rec.record(CONTENT)
    proof_reads = [g for g in relay.gets if g.startswith("/v1/meter/proofs")]
    assert proof_reads == ["/v1/meter/proofs?after_seq=0"]
    clock[0] += 2 * 60 * 60
    rec.record(CONTENT)
    assert len(relay.posts) == 1  # daily: it waits
    rec.send_before_use()  # a presentation two hours later sends now, without a second proof read
    assert len(relay.posts) == 2
    assert len([g for g in relay.gets if g.startswith("/v1/meter/proofs")]) == 1
    clock[0] += 24 * 60 * 60
    rec.flush()
    assert len([g for g in relay.gets if g.startswith("/v1/meter/proofs")]) == 2


def test_one_batch_a_day_holds_across_processes_and_a_presentation_sends_at_once(store_root):
    clock = [1_790_000_000.0]
    relay = FakeMeterRelay()
    first = make_recorder(relay, store_root, now=lambda: clock[0])
    first.record(CONTENT)
    assert len(relay.posts) == 1
    # A new process an hour later, on the same store: the day is not up, so nothing is sent —
    # not on record, not at exit.
    clock[0] += 60 * 60
    second = make_recorder(relay, store_root, now=lambda: clock[0])
    second.record(CONTENT)
    assert second.maybe_send() is None
    assert len(relay.posts) == 1
    # Right before a presentation or payout, the latest acts go out immediately.
    assert second.send_before_use().acts_accepted == 1
    assert len(relay.posts) == 2
    # Then a full day after THAT batch, the next one is due.
    clock[0] += 23 * 60 * 60
    second.record(CONTENT)
    assert len(relay.posts) == 2
    clock[0] += 60 * 60 + 1
    second.record(CONTENT)
    assert len(relay.posts) == 3


@pytest.mark.parametrize("append_adopted", [False, True])
def test_restored_unverified_proof_revalidates_and_keeps_anchor_segment(relay, store_root, append_adopted):
    rec, sender = _sender(store_root, relay)
    rec.record(CONTENT)
    batch = sender.store.last_batch()
    receipt = relay.receipts[batch['batch_hash']]
    proof = {'seq': batch['seq'], 'batch_hash': batch['batch_hash'], 'batch_leaf': receipt['batch_leaf'],
             'acts_root': batch['acts_root'], 'actor_id': receipt['actor_id'], 'verified': False,
             'anchor': {'day': '2026-10-10', 'segment': 2}}
    sender.store.record_proof(proof)
    sender.store.record_proof(dict(proof, seq=999))
    if append_adopted:
        sender.store.record_batch(dict(batch, adopted=True, acts_root=None, actor_id=None), None)
    recovered = FsPeStore(sender.store.device_id, store_root)
    restored = recovered.list_proofs()
    assert len(restored) == 2
    assert restored[0]['verified'] is True
    assert restored[0]['anchor']['segment'] == 2
    assert restored[1]['verified'] is False
