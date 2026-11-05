"""an agent declaring its own work has no path to a PE.

The Python SDK's declaration surfaces are gone: the zero-setup
``provian.submit_pe`` / ``register_provisional`` (unauthenticated ``AgentKey``
provisional wallets, refused by the relay), and ``ProvianClient.submit_pe`` /
``submit_device_pe`` (the caller's own action type and description, or its own
fully formed body). What stays is observation: each agent program, LangChain and
CrewAI programs included, is witnessed by exactly one lane of the observer daemon,
so the SDK records no tool call of its own.
"""

import importlib.util

import provian
from provian import ProvianClient

from .conftest import TEST_CREDENTIAL


def test_zero_setup_submit_pe_and_register_provisional_are_gone():
    assert not hasattr(provian, "submit_pe")
    assert not hasattr(provian, "register_provisional")
    assert "submit_pe" not in provian.__all__
    assert importlib.util.find_spec("provian.provisional") is None


def test_client_has_no_declaration_methods():
    for name in ("submit_pe", "submit_device_pe", "is_provisional"):
        assert not hasattr(ProvianClient, name), name


def test_a_plain_identifier_never_sends_agentkey():
    # The relay refuses AgentKey on /v1/pe/submit; a plain identifier is a
    # read-only client (public profile / artifact reads) and carries no auth header.
    client = ProvianClient("my-agent", relay_url="https://r.test")
    assert not str(client._session.headers.get("Authorization", "")).startswith("AgentKey")


def test_a_device_client_still_constructs_for_reads():
    client = ProvianClient(TEST_CREDENTIAL, relay_url="https://r.test")
    assert client.identifier == TEST_CREDENTIAL
    assert str(client._session.headers["Authorization"]).startswith("DeviceKey ")


def test_the_sdk_records_no_tool_call_of_its_own():
    # one witness lane per program, the observer daemon's. A second recorder in
    # the SDK would be a second witness for the same work.
    import provian.device as device

    assert importlib.util.find_spec("provian.integrations") is None
    for name in ("build_tool_orchestration_content", "compute_turn_id", "assert_single_capture_lane"):
        assert not hasattr(device, name), name
