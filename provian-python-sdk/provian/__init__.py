"""Provian SDK - the trust layer for the AI agent economy.

A read client, plus a registered device's local PE store and the meter batch
sender. PEs live with their owner; the observer daemon witnesses agent programs.

PE meter : the relay keeps no PE. Each PE (v2) is kept on this
machine in the device's local PE store (:mod:`provian.pe_store`, the same store the
observer daemon keeps) and goes to the relay as an act record in the device's daily
signed batch (:mod:`provian.meter`, wire in :mod:`provian.meter_wire`).

an agent's own claim about its work is never a PE, so
there is no ``submit_pe``. Register the machine (``npx @provian/agent-sdk
register-device``); the observer daemon then witnesses each agent program, LangChain
and CrewAI programs included, through exactly one of its lanes.
"""

from .client import ProvianClient
from .meter import PeRecorder
from .exceptions import (
    AuthenticationError,
    KillSwitchError,
    PEDescriptionError,
    ProvianError,
    RateLimitError,
)

__all__ = [
    "ProvianClient",
    "PeRecorder",
    "ProvianError",
    "PEDescriptionError",
    "RateLimitError",
    "AuthenticationError",
    "KillSwitchError",
]

__version__ = "0.4.0"
