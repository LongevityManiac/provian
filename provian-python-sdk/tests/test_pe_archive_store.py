"""The paid PE Archive seen from the Python store.

The TypeScript observer daemon may drop a PE whose day the Archive confirmed: its line in
``pes.jsonl`` becomes a pointer ``{"i", "at", "a": {...}}`` and the file is rewritten through
``pes.jsonl.compact``. The Python store shares that file, so it must read past pointers (they keep
their chain position) and finish or discard an interrupted compaction exactly as the TS store does.
It never drops a PE itself.
"""

import json
import os

import pytest

from provian.meter import build_pe_v2
from provian.pe_store import FsPeStore, PeStoreCorruptError

from .conftest import TEST_DEVICE_ID, run_ts_oracle, ts_oracle_available
from .test_meter import CONTENT, _append


def _drop_like_the_daemon(store, indexes):
    """What the TS ``dropArchivedDay`` writes: pointer lines; the caller places the file and head."""
    path = os.path.join(store.location, "pes.jsonl")
    out = []
    with open(path, encoding="utf-8") as fh:
        raws = fh.read().splitlines()
    for raw in raws:
        line = json.loads(raw)
        if line["i"] in indexes and "pe" in line:
            pe = line["pe"]
            raw = json.dumps({"i": line["i"], "at": line["at"], "a": {
                "day": "2026-10-01", "wallet": "aw_owner", "pe_id": pe["pe_id"],
                "pe_hash": pe["pe_hash"], "prev_hash": pe["prev_hash"]}}, separators=(",", ":"))
        out.append(raw + "\n")
    compacted = "".join(out).encode("utf-8")
    head_path = os.path.join(store.location, "head.json")
    with open(head_path) as fh:
        head = json.load(fh)
    return compacted, head, head_path, path


def _write(path, data):
    with open(path, "wb") as fh:
        fh.write(data)


def _read(path):
    with open(path, "rb") as fh:
        return fh.read()


def _write_head(head_path, head):
    with open(head_path, "w") as fh:
        json.dump(head, fh)


def test_a_dropped_pe_keeps_its_place_and_the_chain_reads_and_extends(store_root):
    store = FsPeStore(TEST_DEVICE_ID, store_root)
    pes = _append(store, 3)
    compacted, head, head_path, path = _drop_like_the_daemon(store, {0, 1})
    _write(path, compacted)
    _write_head(head_path, dict(head, bytes=len(compacted)))
    reopened = FsPeStore(TEST_DEVICE_ID, store_root)
    assert reopened.head() == {"count": 3, "last_pe_hash": pes[2]["pe_hash"]}
    assert [r["pe"]["pe_id"] for r in reopened.read_pes(0, 10)] == [pes[2]["pe_id"]]
    assert reopened.find_pe(pes[0]["pe_id"]) is None
    assert reopened.find_pe(pes[2]["pe_id"])["index"] == 2
    more = _append(reopened, 1)
    assert more[0]["prev_hash"] == pes[2]["pe_hash"]
    assert reopened.head()["count"] == 4


def test_an_interrupted_compaction_is_finished_when_the_head_names_it(store_root):
    store = FsPeStore(TEST_DEVICE_ID, store_root)
    pes = _append(store, 3)
    compacted, head, head_path, path = _drop_like_the_daemon(store, {0})
    # The crash window: compact file written and the head moved, rename not done.
    _write(os.path.join(store.location, "pes.jsonl.compact"), compacted)
    _write_head(head_path, dict(head, bytes=len(compacted)))
    assert store.head() == {"count": 3, "last_pe_hash": pes[2]["pe_hash"]}
    assert _read(path) == compacted
    assert not os.path.exists(os.path.join(store.location, "pes.jsonl.compact"))
    assert store.find_pe(pes[0]["pe_id"]) is None


def test_red_a_compaction_the_head_never_named_is_discarded_and_nothing_is_lost(store_root):
    store = FsPeStore(TEST_DEVICE_ID, store_root)
    pes = _append(store, 3)
    path = os.path.join(store.location, "pes.jsonl")
    original = _read(path)
    compacted, _head, _hp, _p = _drop_like_the_daemon(store, {0})
    _write(os.path.join(store.location, "pes.jsonl.compact"), compacted[:17])
    assert store.head() == {"count": 3, "last_pe_hash": pes[2]["pe_hash"]}
    assert _read(path) == original
    assert not os.path.exists(os.path.join(store.location, "pes.jsonl.compact"))
    assert [r["pe"] for r in store.read_pes(0, 10)] == pes


def test_red_a_pointer_line_out_of_order_is_still_corruption(store_root):
    store = FsPeStore(TEST_DEVICE_ID, store_root)
    _append(store, 2)
    path = os.path.join(store.location, "pes.jsonl")
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    bad = json.dumps({"i": 5, "at": 1, "a": {"day": "2026-10-01", "wallet": "aw", "pe_id": "x",
                                              "pe_hash": "0" * 64, "prev_hash": "genesis"}}, separators=(",", ":"))
    _write(path, (bad + "\n" + lines[1] + "\n").encode("utf-8"))
    with pytest.raises(PeStoreCorruptError):
        store.find_pe("anything")


@pytest.mark.skipif(not ts_oracle_available(), reason="node + provian-backend tsx not installed")
def test_the_ts_daemons_real_drop_is_read_by_python(store_root):
    store = FsPeStore(TEST_DEVICE_ID, store_root)
    pes = _append(store, 3)
    plan = [{"index": i, "pe_id": pes[i]["pe_id"], "pe_hash": pes[i]["pe_hash"]} for i in (0, 1)]
    out = run_ts_oracle({"root": store_root, "device_id": TEST_DEVICE_ID, "day": "2026-10-01",
                         "wallet": "aw_owner", "pes": plan}, script="ts_archive_drop_oracle.ts")
    assert out == {"dropped": 2}
    assert store.head() == {"count": 3, "last_pe_hash": pes[2]["pe_hash"]}
    assert [r["pe"] for r in store.read_pes(0, 10)] == [pes[2]]
    nxt = build_pe_v2(CONTENT, TEST_DEVICE_ID, pes[2]["pe_hash"], 1_790_000_009_000)
    assert store.append(nxt)["ok"] is True
