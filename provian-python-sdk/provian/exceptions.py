"""Exception classes for the Provian SDK."""


class ProvianError(Exception):
    """Base exception for all Provian SDK errors."""

    def __init__(self, message: str, code: str = "UNKNOWN", status_code: int = 0):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class PEDescriptionError(ProvianError):
    """Raised when a PE description fails validation."""

    def __init__(self, message: str, hint: str = ""):
        super().__init__(message, code="INVALID_DESCRIPTION", status_code=400)
        self.hint = hint


class RateLimitError(ProvianError):
    """Raised when the API rate limit is exceeded."""

    def __init__(self, message: str, retry_after: int = 0):
        super().__init__(message, code="RATE_LIMITED", status_code=429)
        self.retry_after = retry_after


class AuthenticationError(ProvianError):
    """Raised when authentication fails."""

    def __init__(self, message: str = "Authentication failed"):
        super().__init__(message, code="AUTH_FAILED", status_code=401)


class KillSwitchError(ProvianError):
    """Raised when the kill switch is active."""

    def __init__(self):
        super().__init__(
            "Kill switch is active - all actions blocked",
            code="KILL_SWITCH_ACTIVE",
            status_code=403,
        )
