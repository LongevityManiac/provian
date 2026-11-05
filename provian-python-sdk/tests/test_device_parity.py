"""Cross-language parity: the Python device module against the REAL TypeScript and relay functions.

``tests/parity/vectors.json`` was produced by running ``ts_vectors.ts``, which calls the
relay's ``canonicalJson`` and node's HMAC-SHA256. Each pinned answer must be reproduced
byte for byte. When node and the backend's ``tsx`` are installed, the oracle is also
re-run live, so a change on either side fails here.
"""

import hashlib
import hmac
import json
import os

import pytest

from provian.device import body_hmac_hex, stable_stringify

from .conftest import run_ts_oracle, ts_oracle_available

VECTORS_PATH = os.path.join(os.path.dirname(__file__), "parity", "vectors.json")
with open(VECTORS_PATH, encoding="ascii") as _fh:
    VECTORS = json.load(_fh)


def test_vector_population_is_non_empty():
    # a universally quantified parity claim over zero vectors proves nothing.
    assert len(VECTORS["canonical"]) >= 30
    assert len(VECTORS["hmac"]) >= 2


@pytest.mark.parametrize("vector", VECTORS["canonical"], ids=lambda v: repr(v["input"])[:40])
def test_canonical_json_matches_relay_canonicalJson(vector):
    assert stable_stringify(vector["input"]) == vector["ts"]


def test_red_control_a_naive_canonicalizer_is_caught_by_the_vectors():
    # A plausible but wrong implementation (json.dumps with sorted keys) must
    # disagree with the relay on several vectors, which shows the vectors can fail.
    def naive(value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    mismatches = 0
    for v in VECTORS["canonical"]:
        try:
            if naive(v["input"]) != v["ts"]:
                mismatches += 1
        except (TypeError, ValueError):
            mismatches += 1
    assert mismatches >= 8


@pytest.mark.parametrize("vector", VECTORS["hmac"], ids=lambda v: v["ts"][:12])
def test_body_hmac_matches_node_crypto(vector):
    assert body_hmac_hex(vector["secret"], vector["body"].encode("utf-8")) == vector["ts"]


def test_red_control_tampered_body_hmac_does_not_match_node_crypto():
    vector = VECTORS["hmac"][0]
    tampered = vector["body"].replace('"network_calls":2', '"network_calls":3')
    assert tampered != vector["body"]
    assert body_hmac_hex(vector["secret"], tampered.encode("utf-8")) != vector["ts"]


@pytest.mark.skipif(not ts_oracle_available(), reason="node + provian-backend tsx not installed")
def test_live_oracle_agrees_with_python_on_every_vector():
    payload = {
        "canonical": [v["input"] for v in VECTORS["canonical"]],
        "hmac": [{"secret": v["secret"], "body": v["body"]} for v in VECTORS["hmac"]],
    }
    live = run_ts_oracle(payload)
    assert live["canonical"] == [stable_stringify(v["input"]) for v in VECTORS["canonical"]]
    assert live["hmac"] == [body_hmac_hex(v["secret"], v["body"].encode("utf-8")) for v in VECTORS["hmac"]]


def test_hmac_is_keyed_by_the_secret_not_the_key():
    body = b'{"a":1}'
    assert body_hmac_hex("pds_a", body) == hmac.new(b"pds_a", body, hashlib.sha256).hexdigest()
    assert body_hmac_hex("pds_a", body) != body_hmac_hex("pds_b", body)
