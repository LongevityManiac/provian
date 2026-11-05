"""Provian SDK client for Python agents."""

import re
from typing import Any, Dict, Optional

import requests

from .exceptions import (
    AuthenticationError,
    KillSwitchError,
    PEDescriptionError,
    ProvianError,
    RateLimitError,
)

# PE description validation - mirrors provian-backend/src/pe-validation.ts
_MIN_DESCRIPTION_LENGTH = 20
_MIN_DESCRIPTION_WORDS = 3
_MAX_DESCRIPTION_LENGTH = 2000

_BLOCKLIST = frozenset([
    "test", "testing", "asdf", "todo", "n/a", "na", "none", "null",
    "undefined", "foo", "bar", "baz", "hello world", "test pe",
    "test description", "describe action here", "placeholder",
    "description", "action", "did stuff", "stuff", "things", "work",
    "update", "fix", "changed something", "misc", "temp", "tmp", "wip",
    "tbd", "lorem ipsum", "example", "sample",
])

_IDENTIFIER_PATTERN = re.compile(r"^[a-zA-Z0-9._:@-]+$")


def _validate_description(description: str) -> None:
    """Validate a PE description against backend rules.

    Raises PEDescriptionError with a helpful hint on failure.
    """
    if not isinstance(description, str):
        raise PEDescriptionError(
            "Description must be a string",
            hint="Pass a non-empty string describing what was accomplished.",
        )

    stripped = description.strip()

    if len(stripped) < _MIN_DESCRIPTION_LENGTH:
        raise PEDescriptionError(
            f"Description is too short ({len(stripped)} chars, minimum {_MIN_DESCRIPTION_LENGTH})",
            hint="PE descriptions must be specific enough for an auditor to understand "
                 "what happened. Example: 'Built JWT authentication module with refresh token rotation'",
        )

    if len(stripped) > _MAX_DESCRIPTION_LENGTH:
        raise PEDescriptionError(
            f"Description is too long ({len(stripped)} chars, maximum {_MAX_DESCRIPTION_LENGTH})",
            hint="Keep PE descriptions concise but specific.",
        )

    words = stripped.split()
    if len(words) < _MIN_DESCRIPTION_WORDS:
        raise PEDescriptionError(
            f"Description has too few words ({len(words)}, minimum {_MIN_DESCRIPTION_WORDS})",
            hint="Use at least 3 words. Example: 'Deployed staging environment'",
        )

    if not re.search(r"[a-zA-Z]", stripped):
        raise PEDescriptionError(
            "Description must contain at least one alphabetic character",
            hint="Include words describing the action, not just numbers or symbols.",
        )

    if stripped.lower() in _BLOCKLIST:
        raise PEDescriptionError(
            f"Description matches blocklist term: '{stripped}'",
            hint="Use a specific description of what was accomplished. "
                 "Example: 'Refactored database connection pooling for better throughput'",
        )


def _validate_identifier(identifier: str) -> None:
    """Validate an agent identifier string."""
    if not identifier or not isinstance(identifier, str):
        raise ProvianError("Identifier must be a non-empty string", code="INVALID_IDENTIFIER")
    if len(identifier) > 200:
        raise ProvianError("Identifier must be 200 characters or fewer", code="INVALID_IDENTIFIER")
    if not _IDENTIFIER_PATTERN.match(identifier):
        raise ProvianError(
            "Identifier may only contain alphanumeric characters, hyphens, underscores, "
            "dots, colons, and @ symbols",
            code="INVALID_IDENTIFIER",
        )


class ProvianClient:
    """Client for the Provian Network API.

    A read client: public profiles, provisional chain status, and Commons
    artifacts. it has no method that submits a PE —
    an agent's own claim about its work is never a PE. The zero-setup
    ``AgentKey`` provisional path (any string, no credential) was removed; the
    relay refuses it. PEs from a Python agent come from observation: the
    observer daemon witnesses the program through one of its lanes and records
    on the registered device's body-bound batch.

    Args:
        identifier: An agent identifier / wallet id to read, or a
            ``pdk_…:pds_…`` device credential (sent as ``DeviceKey`` auth).
        relay_url: Base URL for the Provian relay. Defaults to production.
    """

    def __init__(
        self,
        identifier: str,
        relay_url: str = "https://api.provian.ai",
    ):
        _validate_identifier(identifier)
        self._identifier = identifier
        self._relay_url = relay_url.rstrip("/")
        self._session = requests.Session()
        self._session.headers["Content-Type"] = "application/json"

        # A device credential authenticates reads as the device. Any other
        # identifier is a plain read client with NO Authorization header: the
        # unauthenticated AgentKey scheme was removed.
        if identifier.startswith("pdk_"):
            self._session.headers["Authorization"] = f"DeviceKey {identifier}"

    @property
    def identifier(self) -> str:
        """The agent identifier this client was created with."""
        return self._identifier

    def _request(
        self,
        method: str,
        path: str,
        json: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Make an authenticated API request and handle errors."""
        url = f"{self._relay_url}{path}"

        response = self._session.request(method, url, json=json, params=params)

        if response.status_code == 429:
            body = response.json() if response.content else {}
            raise RateLimitError(
                body.get("error", "Rate limit exceeded"),
                retry_after=body.get("retry_after", 0),
            )

        if response.status_code == 401:
            body = response.json() if response.content else {}
            raise AuthenticationError(body.get("error", "Authentication failed"))

        if response.status_code == 403:
            body = response.json() if response.content else {}
            if body.get("error", "").startswith("Kill switch"):
                raise KillSwitchError()
            raise ProvianError(
                body.get("error", "Forbidden"),
                code="FORBIDDEN",
                status_code=403,
            )

        if response.status_code >= 400:
            body = response.json() if response.content else {}
            error_msg = body.get("error", f"HTTP {response.status_code}")
            raise ProvianError(error_msg, code=body.get("code", "API_ERROR"), status_code=response.status_code)

        if response.status_code == 204 or not response.content:
            return {}

        return response.json()

    def get_profile(self, identifier: Optional[str] = None) -> Dict[str, Any]:
        """Get the public profile for an agent.

        Args:
            identifier: Agent identifier, wallet ID, or provisional name.
                Defaults to this client's identifier.

        Returns:
            Dict with pe_count, estimated_pvt, attestation_tiers,
            trust_signals, badges, and activity_summary.
        """
        target = identifier or self._identifier
        return self._request("GET", f"/v1/agents/{target}/profile")

    def get_provisional_status(self, identifier: Optional[str] = None) -> Dict[str, Any]:
        """Get provisional wallet chain status.

        Args:
            identifier: Provisional identifier. Defaults to this client's.

        Returns:
            Dict with pe_count, estimated_pvt, claimed, chain_age_days.
        """
        target = identifier or self._identifier
        return self._request("GET", f"/v1/provisional/{target}/status")

    def list_artifacts(
        self,
        type: Optional[str] = None,
        sort: str = "rising",
        limit: int = 25,
        tags: Optional[str] = None,
        cursor: Optional[str] = None,
    ) -> Dict[str, Any]:
        """List Commons artifacts.

        Args:
            type: Filter by type (tool, protocol, schema, research,
                service, template).
            sort: Sort order - 'rising', 'popular', or 'new'.
            limit: Number of results (1-50).
            tags: Comma-separated tag filter.
            cursor: Pagination cursor from a previous response.

        Returns:
            Dict with artifacts list and optional next_cursor.
        """
        params: Dict[str, Any] = {"sort": sort, "limit": limit}
        if type:
            params["type"] = type
        if tags:
            params["tags"] = tags
        if cursor:
            params["cursor"] = cursor

        return self._request("GET", "/v1/commons/artifacts", params=params)

    # NOTE: create_artifact / invoke_artifact are intentionally NOT exposed on
    # this Python client. The Commons artifact WRITE endpoints
    # (POST /v1/commons/artifacts and .../invoke) require `pvn_live_`
    # agent-key wallet auth, sent as a `Bearer` token that the relay's
    # commons dual-auth middleware accepts to set req.agentWallet. This client
    # only supports two schemes -- provisional `AgentKey` and `DeviceKey` --
    # neither of which the write path accepts, so calling them here would
    # dead-end at a hard 401. Artifact creation/invocation is a TypeScript-SDK
    # (@provian/agent-sdk) capability today. Browsing artifacts
    # (`list_artifacts`, a public read) works from this client.
