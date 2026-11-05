"""Shared test helpers: a stand-in relay for the meter routes and the relay's own body-HMAC check."""

import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
from typing import Dict, List, Optional

import pytest

SDK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(SDK_ROOT)
BACKEND = os.path.join(REPO_ROOT, "provian-backend")
#: The relay-generated wire vectors every package reproduces (relay, TS SDK, app, this SDK).
METER_VECTORS_PATH = os.path.join(REPO_ROOT, "docs", "audit", "meter-wire-vectors.json")
if SDK_ROOT not in sys.path:
    sys.path.insert(0, SDK_ROOT)

TEST_KEY = "pdk_test0123456789abcdef"
TEST_SECRET = "pds_test_secret_never_in_body"
TEST_CREDENTIAL = TEST_KEY + ":" + TEST_SECRET
TEST_DEVICE_ID = "dev_" + "ab" * 32
TEST_ACTOR_ID = "wallet_aw_python_test"
RELAY = "https://relay.test"


class FakeResponse:
    def __init__(self, status_code: int, payload: Optional[object] = None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.content = json.dumps(self._payload).encode("utf-8")

    def json(self):
        return self._payload


def relay_body_hmac_check(authorization: str, body_hmac_header: str, raw_body: bytes) -> bool:
    """Python mirror of routes/meter.ts deviceBodyBinding: hmac_sha256(secret from the DeviceKey header, rawBody)."""
    if not authorization.startswith("DeviceKey "):
        return False
    secret = authorization[len("DeviceKey "):].partition(":")[2]
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    try:
        provided = bytes.fromhex(body_hmac_header)
    except ValueError:
        return False
    return hmac.compare_digest(provided, bytes.fromhex(expected))


class FakeMeterRelay:
    """Stands in for ``requests.Session`` against the relay's ``/v1/meter/*`` routes.

    The batch route applies the relay's position rules: body-bound or 401, the batch extends this
    device's tip (seq, prev_batch_hash) or 409 ``batch_replay``, the acts continue the device's
    last accepted PE or 409 ``act_chain_broken``, and the same batch re-sent answers 200 with the
    stored receipt. ``answers`` scripts the next POST answers (a Response, or an exception to raise).
    """

    def __init__(self, answers: Optional[List[object]] = None, seal_targets: Optional[List[Dict[str, object]]] = None):
        from provian.meter_wire import METER_GENESIS_PREV_HASH

        self.posts: List[Dict[str, object]] = []
        self.gets: List[str] = []
        self.answers = list(answers or [])
        self.seal_targets = list(seal_targets or [])
        self.proofs: List[Dict[str, object]] = []
        self.tip = {"seq": 0, "batch_hash": METER_GENESIS_PREV_HASH, "last_pe_hash": METER_GENESIS_PREV_HASH}
        self.accepted: List[Dict[str, object]] = []
        self.receipts: Dict[str, Dict[str, object]] = {}
        self.headers: Dict[str, str] = {}

    def get(self, url, headers=None, timeout=None):
        path = url[len(RELAY):]
        self.gets.append(path)
        if path.startswith("/v1/meter/seal-targets"):
            return FakeResponse(200, {"targets": self.seal_targets})
        if path.startswith("/v1/meter/tip"):
            return FakeResponse(200, {"device_id": TEST_DEVICE_ID, **self.tip, "accepted_at_ms": None})
        if path.startswith("/v1/meter/proofs"):
            after = int(path.partition("after_seq=")[2] or 0)
            return FakeResponse(200, {"proofs": [p for p in self.proofs if p["seq"] > after], "next_after_seq": None})
        return FakeResponse(404, {"error": "not_found"})

    def post(self, url, data=None, headers=None, timeout=None):
        self.posts.append({"url": url, "data": data, "headers": dict(headers or {}), "timeout": timeout})
        if self.answers:
            answer = self.answers.pop(0)
            if isinstance(answer, BaseException):
                raise answer
            return answer
        return self._ingest(data, dict(headers or {}))

    def _ingest(self, data: bytes, headers: Dict[str, str]):
        from provian.meter_wire import batch_hash_of, batch_leaf_of

        if not relay_body_hmac_check(headers.get("Authorization", ""), headers.get("X-Provian-Body-HMAC", ""), data):
            return FakeResponse(401, {"error": "X-Provian-Body-HMAC verification failed"})
        batch = json.loads(data.decode("utf-8"))
        bh = batch_hash_of(batch)
        if bh in self.receipts:
            return FakeResponse(200, self.receipts[bh])
        if batch["seq"] != self.tip["seq"] + 1 or batch["prev_batch_hash"] != self.tip["batch_hash"]:
            return FakeResponse(409, {"error": "batch_replay", "expected_seq": self.tip["seq"] + 1,
                                      "expected_prev_batch_hash": self.tip["batch_hash"], "last_pe_hash": self.tip["last_pe_hash"]})
        prev = self.tip["last_pe_hash"]
        for act in batch["acts"]:
            if act["prev_hash"] != prev:
                return FakeResponse(409, {"error": "act_chain_broken", "last_pe_hash": self.tip["last_pe_hash"]})
            prev = act["pe_hash"]
        receipt = {
            "schema": "provian.pe-batch-receipt.v1", "device_id": batch["device_id"], "actor_id": TEST_ACTOR_ID,
            "seq": batch["seq"], "batch_hash": bh, "acts_root": batch["acts_root"],
            "batch_leaf": batch_leaf_of(batch["device_id"], TEST_ACTOR_ID, batch["seq"], bh, batch["acts_root"]),
            "accepted_at_ms": 1_790_000_000_000,
            "acts": [{"pe_id": a["pe_id"], "pe_hash": a["pe_hash"], "relay_pe_id": "rpe_%d" % i, "leaf_index": i,
                      "disposition": "eligible", "reason": "eligible", "record_points_atomic": "1000000000000000000",
                      "mint_status": "eligible"} for i, a in enumerate(batch["acts"])],
            "totals": {"eligible_points_atomic": str(10 ** 18 * len(batch["acts"])), "acts": len(batch["acts"]),
                       "eligible": len(batch["acts"])},
        }
        self.receipts[bh] = receipt
        self.accepted.append(batch)
        self.tip = {"seq": batch["seq"], "batch_hash": bh, "last_pe_hash": prev}
        return FakeResponse(201, receipt)


def ts_oracle_available() -> bool:
    return shutil.which("node") is not None and os.path.exists(
        os.path.join(BACKEND, "node_modules", ".bin", "tsx")
    )


def run_ts_oracle(payload: Dict[str, object], script: str = "ts_vectors.ts") -> Dict[str, object]:
    result = subprocess.run(
        [os.path.join(BACKEND, "node_modules", ".bin", "tsx"),
         os.path.join("..", "provian-python-sdk", "tests", "parity", script)],
        cwd=BACKEND, input=json.dumps(payload), capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    return json.loads(result.stdout)


@pytest.fixture
def relay():
    return FakeMeterRelay()


@pytest.fixture
def store_root(tmp_path):
    return str(tmp_path / "pe-store")


def make_recorder(session, store_root: str, daemon: bool = False, **kwargs):
    from provian.device import DeviceCredentials
    from provian.meter import PeRecorder

    return PeRecorder(
        DeviceCredentials(TEST_KEY, TEST_SECRET, RELAY, TEST_DEVICE_ID),
        session=session, store_root=store_root, sleep=lambda _s: None,
        daemon_running=lambda: daemon, flush_at_exit=False, **kwargs,
    )


@pytest.fixture
def recorder(relay, store_root):
    return make_recorder(relay, store_root)
