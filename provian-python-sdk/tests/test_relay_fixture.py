"""The captured batch the backend suite replays into the relay's own code.

``provian-backend/src/core/meter/python-sdk-batch.test.ts`` feeds these bytes to the relay's
wire checks, its body binding and its sealed-box opener. This suite checks that the fixture
still matches what the recorder sends today: the same header set, the same batch and PE keys,
canonical bytes, a valid HMAC, and acts that are exactly the stored PEs' act records.
"""

import json
import os

import pytest

from provian.meter_wire import act_record_of, batch_hash_of, canonical_json, pe_hash_of, validate_batch_shape, verify_act_chain
from provian.sealed_box import from_b64u, open_with_key

from .conftest import relay_body_hmac_check

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "python_device_requests.json")


def _fixture():
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


def _load():
    return _fixture()["requests"]


def _population_problem(reqs):
    """None when the fixture is the recorder's one batch of at least two acts, one per stored PE."""
    if [r["capture"] for r in reqs] != ["recorder"]:
        return "population"
    for r in reqs:
        if len(r["pes"]) < 2:
            return "single_act"
        if len(json.loads(r["body_utf8"])["acts"]) != len(r["pes"]):
            return "acts_mismatch"
    return None


def test_fixture_population_is_the_recorder_batch_of_more_than_one_act():
    # a pass over an empty population, or over one act, proves nothing about the act chain.
    assert _population_problem(_load()) is None


def test_red_the_population_check_refuses_an_empty_single_act_or_renamed_fixture():
    req = _load()[0]
    assert _population_problem([]) == "population"
    assert _population_problem([dict(req, capture="other")]) == "population"
    assert _population_problem([dict(req, pes=req["pes"][:1])]) == "single_act"
    assert _population_problem([dict(req, pes=req["pes"] * 2)]) == "acts_mismatch"


@pytest.mark.parametrize("req", _load(), ids=lambda r: r["capture"])
def test_fixture_batch_is_body_bound_canonical_and_the_stored_pes_acts(req):
    raw = req["body_utf8"].encode("utf-8")
    assert req["path"] == "/v1/meter/batch"
    assert relay_body_hmac_check(req["headers"]["Authorization"], req["headers"]["X-Provian-Body-HMAC"], raw)
    batch = json.loads(req["body_utf8"])
    assert canonical_json(batch) == req["body_utf8"]
    assert validate_batch_shape(batch) is None
    assert verify_act_chain("genesis", batch["acts"]) is None
    assert batch["acts"] == [act_record_of(pe) for pe in req["pes"]]
    assert all(pe_hash_of(pe) == pe["pe_hash"] for pe in req["pes"])
    secret = from_b64u(_fixture()["seal_recipient_secret_b64u"])
    assert [json.loads(open_with_key(secret, from_b64u(s["box"]))) for s in batch["sealed"]] == req["pes"]
    assert batch_hash_of(batch) == batch_hash_of(dict(batch, sealed=[]))  # sealed copies are not hashed


@pytest.mark.parametrize("req", _load(), ids=lambda r: r["capture"])
def test_fixture_matches_what_the_recorder_sends_now(req):
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "generate_relay_fixture", os.path.join(os.path.dirname(__file__), "fixtures", "generate_relay_fixture.py"))
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    now_req = gen.capture(req["capture"])
    now = json.loads(now_req["body_utf8"])
    pinned = json.loads(req["body_utf8"])
    assert sorted(now_req["headers"]) == sorted(req["headers"])
    assert sorted(now) == sorted(pinned)
    assert [sorted(a) for a in now["acts"]] == [sorted(a) for a in pinned["acts"]]
    assert [sorted(a["pricing"]) for a in now["acts"]] == [sorted(a["pricing"]) for a in pinned["acts"]]
    assert [a["pricing"] for a in now["acts"]] == [a["pricing"] for a in pinned["acts"]]
    assert [sorted(pe) for pe in now_req["pes"]] == [sorted(pe) for pe in req["pes"]]
    assert [a["action_type"] for a in now["acts"]] == [a["action_type"] for a in pinned["acts"]]
    assert [s["to"] for s in now["sealed"]] == [s["to"] for s in pinned["sealed"]] == ["linked_human"] * len(pinned["acts"])
