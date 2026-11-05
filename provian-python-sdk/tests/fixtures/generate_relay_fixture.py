"""Capture the exact batch the Python PE recorder sends.

    cd provian-python-sdk && python3 tests/fixtures/generate_relay_fixture.py

This drives the REAL recorder (:class:`provian.meter.PeRecorder`): it records two PEs in a fresh
local PE store while the observer daemon (stood in) holds batching, then a recorder with no daemon
beside it sends the device's first batch (``POST /v1/meter/batch``) to a stand-in relay
that names one seal target (a throwaway linked-human key). The method, path, headers and raw body
bytes of that batch POST, the PEs the store holds, and the throwaway recipient secret are written
to ``python_device_requests.json``. The backend suite
``provian-backend/src/core/meter/python-sdk-batch.test.ts`` replays those bytes into the relay's
own wire checks (``validateBatchShape``, ``batchHashOf``, ``verifyActChain``, ``actRecordOf``,
``peHashOf``), its body binding (``deviceBodyBinding``) and its sealed-box opener, so the relay's
own code judges what Python sends.

The credential and the recipient key are throwaway test values. The relay recomputes the body
HMAC from the secret in the ``Authorization`` header, exactly as it does in production.
"""

import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SDK_ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SDK_ROOT)

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey  # noqa: E402

from provian.sealed_box import to_b64u  # noqa: E402
from tests.conftest import RELAY, FakeMeterRelay, make_recorder  # noqa: E402

#: A throwaway linked-human x25519 key; its secret is in the fixture so the relay suite can open the box.
SEAL_SECRET = bytes(range(1, 33))
SEAL_PUBLIC = X25519PrivateKey.from_private_bytes(SEAL_SECRET).public_key().public_bytes(
    serialization.Encoding.Raw, serialization.PublicFormat.Raw)

#: The PEs the recorder records: two, so the batch's act chain links one act to the next.
CONTENTS = [
    {
        "action_type": "compute_session",
        "description": "Compiled the project and ran its unit tests",
        "metadata": {"tool": "python-fixture", "network_calls": 2},
        "compute": {"duration_ms": 1234},
        "geo": None,
        "execution_env": {"runtime": "python"},
        "parent_goal_pe_id": None,
    },
    {
        "action_type": "compute_session",
        "description": "Rebuilt the documentation site from source",
        "metadata": {"tool": "python-fixture", "network_calls": 0},
        "compute": {"duration_ms": 567},
        "geo": None,
        "execution_env": {"runtime": "python"},
        "parent_goal_pe_id": None,
    },
]


def _relay():
    return FakeMeterRelay(seal_targets=[{"to": "linked_human", "party_id": "wallet_fixture_human",
                                         "pubkey_b64u": to_b64u(SEAL_PUBLIC), "key_version": 1}])


def capture(name="recorder"):
    """The recorder's first batch POST and the PEs its store holds."""
    relay = _relay()
    with tempfile.TemporaryDirectory() as root:
        # While the daemon runs, record() only appends; both PEs then go out in one batch.
        recording = make_recorder(relay, root, daemon=True)
        for content in CONTENTS:
            recording.record(content)
        assert relay.posts == []
        sender = make_recorder(relay, root)
        sender.flush()
        pes = [row["pe"] for row in sender.sender().store.read_pes(0, 100)]
    assert len(relay.posts) == 1, (name, len(relay.posts))
    post = relay.posts[0]
    return {
        "capture": name,
        "method": "POST",
        "path": post["url"][len(RELAY):],
        "headers": post["headers"],
        "body_utf8": post["data"].decode("utf-8"),
        "pes": pes,
    }


def main():
    entries = [capture("recorder")]
    with open(os.path.join(HERE, "python_device_requests.json"), "w", encoding="utf-8") as fh:
        json.dump({"_generated_by": "tests/fixtures/generate_relay_fixture.py",
                   "seal_recipient_secret_b64u": to_b64u(SEAL_SECRET),
                   "requests": entries}, fh, ensure_ascii=True, indent=1)
        fh.write("\n")
    print("wrote %d requests" % len(entries))


if __name__ == "__main__":
    main()
