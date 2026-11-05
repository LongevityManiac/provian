"""Regenerate ``vectors.json`` by running the REAL TypeScript implementations.

    cd provian-python-sdk && python3 tests/parity/regenerate_vectors.py

The inputs below are fed to ``ts_vectors.ts`` (run with the backend's ``tsx``), which
answers with the relay's ``canonicalJson`` and node's HMAC-SHA256. The answers
are pinned verbatim. ``test_device_parity.py`` asserts the Python implementations
reproduce every pinned answer, and re-runs the oracle live when node is available.
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SDK_ROOT = os.path.dirname(os.path.dirname(HERE))
BACKEND = os.path.join(os.path.dirname(SDK_ROOT), "provian-backend")

CANONICAL_INPUTS = [
    None, True, False, 0, -7, 123456789012, 0.1, 1.5, -2.25, 100.0, 1e21, 1e20, 1e-7, 1.5e-7,
    0.000001, 123e-20, 5e-324, 1.7976931348623157e308, -0.0, 12345.678, 1 / 3,
    "", "plain", "quote\" backslash\\ slash/", "ctl\u0000\u0001\u001f\u007f\b\f\n\r\t",
    "unicode é ü 中文   ", "emoji \U0001F600", "lone \ud800 high",
    "lone \udfff low", "﻿bom",
    [], {}, [1, [2, [3, {}]]],
    {"b": 1, "a": 2, "A": 3, "_": 4, "aa": 5, "a\u0000": 6},
    {"￿": 1, "\U0001F600": 2, "": 3, "z": 4},
    {
        "action_type": "compute_session",
        "description": "Nightly build — 2 targets",
        "metadata": {
            "tool": "python-parity", "network_calls": 2, "targets": ["build", "test"],
            "service": None, "success": True, "nested": {"y": [1.25, None], "x": "v"},
        },
        "compute": {"duration_ms": 1234, "tokens_processed": None},
        "geo": None,
    },
]

HMAC_SECRET = "pds_parity_fixture_secret"


def run_oracle(payload):
    result = subprocess.run(
        ["npx", "tsx", os.path.join("..", "provian-python-sdk", "tests", "parity", "ts_vectors.ts")],
        cwd=BACKEND, input=json.dumps(payload), capture_output=True, text=True, timeout=300,
    )
    if result.returncode != 0:
        raise RuntimeError("oracle failed: %s" % result.stderr[-2000:])
    return json.loads(result.stdout)


def main():
    sys.path.insert(0, SDK_ROOT)
    from provian.device import stable_stringify

    hmac_bodies = [stable_stringify(CANONICAL_INPUTS[-1]), '{"a":"中 é"}']
    payload = {
        "canonical": CANONICAL_INPUTS,
        "hmac": [{"secret": HMAC_SECRET, "body": b} for b in hmac_bodies],
    }
    out = run_oracle(payload)
    vectors = {
        "_generated_by": "tests/parity/regenerate_vectors.py via ts_vectors.ts (real TS/relay functions)",
        "canonical": [{"input": i, "ts": o} for i, o in zip(CANONICAL_INPUTS, out["canonical"])],
        "hmac": [{"secret": HMAC_SECRET, "body": b, "ts": o} for b, o in zip(hmac_bodies, out["hmac"])],
    }
    with open(os.path.join(HERE, "vectors.json"), "w", encoding="ascii") as fh:
        json.dump(vectors, fh, ensure_ascii=True, indent=1)
        fh.write("\n")
    print("wrote %d canonical, %d hmac vectors" % (len(vectors["canonical"]), len(vectors["hmac"])))


if __name__ == "__main__":
    main()
