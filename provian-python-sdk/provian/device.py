"""The registered device: its credential, its body binding, and the relay's canonical JSON.

PE METER : the relay keeps no PE. The device builds each PE (v2),
keeps it in its own PE store, and sends one signed batch per day (:mod:`provian.meter`):

* ``Authorization: DeviceKey <pdk_...>:<pds_...>``, the registered device credential;
* ``X-Provian-Body-HMAC: hex(hmac_sha256(device_secret, raw_body))``, which binds the
  exact batch bytes to the device. A batch that is not body-bound has every act refused.

This module holds what the meter builds on:

* class:`DeviceCredentials` and :func:`load_device_credentials` read the credential
  ``register-device`` writes (``~/.provian/credentials``), in the TS SDK's order.
* func:`body_hmac_hex` is the body binding.
* func:`stable_stringify` is the relay's canonical JSON (``canonicalJson`` in
  ``core/hardware/binding.ts``). Its string, number and key-order helpers are the ones the
  meter wire (:mod:`provian.meter_wire`) serializes with.

The Python test suite pins these functions against vectors produced by running the
TypeScript and relay functions themselves.
"""

import hashlib
import hmac
import math
import os
import stat
from typing import Dict, List, Mapping, Optional

from .exceptions import ProvianError

DEFAULT_RELAY_URL = "https://api.provian.ai"


# ---------------------------------------------------------------------------
# Canonical JSON: byte-identical to the relay's canonicalJson / stableStringify
# ---------------------------------------------------------------------------

_SHORT_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def _js_string(value: str) -> str:
    """Serialize a string exactly as ECMAScript ``JSON.stringify`` does.

    ``"``, ``\\`` and the five short control escapes get their short form. Any other
    code point below U+0020, and any lone surrogate, becomes a lowercase ``\\uXXXX``
    escape. Everything else is emitted literally, as UTF-8 on the wire.
    """
    out: List[str] = ['"']
    for ch in value:
        short = _SHORT_ESCAPES.get(ch)
        if short is not None:
            out.append(short)
            continue
        cp = ord(ch)
        if cp < 0x20 or 0xD800 <= cp <= 0xDFFF:
            out.append("\\u%04x" % cp)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _js_number(value: float) -> str:
    """Serialize a float exactly as ECMAScript ``Number.prototype.toString`` (base 10).

    Non-finite values serialize to ``null``, as in ``JSON.stringify``.
    """
    if math.isnan(value) or math.isinf(value):
        return "null"
    if value == 0:
        return "0"  # JSON.stringify(-0) === "0"
    sign = "-" if value < 0 else ""
    # repr() yields the shortest round-tripping digits, the same digit string
    # ECMAScript's Number::toString selects. Only the layout differs, so re-lay it out.
    text = repr(abs(value))
    if "e" in text:
        mantissa, exp_text = text.split("e")
        exponent = int(exp_text)
    else:
        mantissa, exponent = text, 0
    if "." in mantissa:
        int_part, frac_part = mantissa.split(".")
    else:
        int_part, frac_part = mantissa, ""
    digits = (int_part + frac_part).lstrip("0")
    # n = position of the decimal point relative to the first significant digit.
    leading_zeros = len(int_part + frac_part) - len((int_part + frac_part).lstrip("0"))
    n = len(int_part) - leading_zeros + exponent
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    exp_str = ("+" if e >= 0 else "-") + str(abs(e))
    if k == 1:
        return sign + digits + "e" + exp_str
    return sign + digits[0] + "." + digits[1:] + "e" + exp_str


def _utf16_sort_key(key: str) -> bytes:
    # Array.prototype.sort() with no comparator orders strings by UTF-16 code
    # units. Big-endian UTF-16 bytes compare in exactly that order ("surrogatepass"
    # keeps a lone surrogate sortable instead of raising).
    return key.encode("utf-16-be", "surrogatepass")


def stable_stringify(value: object) -> str:
    """Canonical JSON: recursively sorted keys and no whitespace.

    Byte-identical to the relay's ``canonicalJson``
    (``provian-backend/src/core/hardware/binding.ts``) and to the TypeScript SDK's
    ``ProvianClient.stableStringify`` for any JSON value. Tuples are serialized as
    arrays. Anything that is not JSON data raises ``TypeError`` rather than being
    guessed at.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, str):
        return _js_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(stable_stringify(v) for v in value) + "]"
    if isinstance(value, Mapping):
        parts: List[str] = []
        for key in sorted(value.keys(), key=_check_key_and_sort):
            parts.append(_js_string(key) + ":" + stable_stringify(value[key]))
        return "{" + ",".join(parts) + "}"
    raise TypeError("stable_stringify: unsupported type %s" % type(value).__name__)


def _check_key_and_sort(key: object) -> bytes:
    if not isinstance(key, str):
        raise TypeError("stable_stringify: object keys must be strings")
    return _utf16_sort_key(key)


def body_hmac_hex(device_secret: str, wire_body: bytes) -> str:
    """``hex(hmac_sha256(device_secret, raw_body))``, which the relay recomputes over ``req.rawBody``."""
    return hmac.new(device_secret.encode("utf-8"), wire_body, hashlib.sha256).hexdigest()


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

class DeviceCredentials:
    """A registered device's bearer credential. Its repr never shows the secret.

    ``device_id`` names this device's PE store; when absent it is read from the relay.
    """

    __slots__ = ("device_key", "device_secret", "relay_url", "device_id")

    def __init__(self, device_key: str, device_secret: str, relay_url: str = DEFAULT_RELAY_URL,
                 device_id: Optional[str] = None):
        if not device_key.startswith("pdk_") or not device_secret.startswith("pds_"):
            raise ProvianError(
                "Device credentials must be a pdk_… key and a pds_… secret "
                "(from `npx @provian/agent-sdk register-device`).",
                code="DEVICE_CREDENTIALS_INVALID",
            )
        self.device_key = device_key
        self.device_secret = device_secret
        self.relay_url = relay_url.rstrip("/")
        self.device_id = device_id or None

    def __repr__(self) -> str:
        return "DeviceCredentials(device_key=%r, device_secret='pds_***', relay_url=%r)" % (
            self.device_key[:12] + "…",
            self.relay_url,
        )

    @classmethod
    def parse(cls, credential: str, relay_url: str = DEFAULT_RELAY_URL, device_id: Optional[str] = None) -> "DeviceCredentials":
        """Parse a combined ``pdk_…:pds_…`` credential string."""
        key, sep, secret = credential.partition(":")
        if not sep:
            raise ProvianError(
                "A device credential is 'pdk_…:pds_…'. Provisional identifiers are not "
                "accepted here, because provisional PEs seal record_only and mint nothing.",
                code="DEVICE_CREDENTIALS_REQUIRED",
            )
        return cls(key, secret, relay_url, device_id)


def default_credentials_path() -> str:
    """The machine-local file ``register-device`` writes (shared with the TS observer)."""
    return os.path.join(os.path.expanduser("~"), ".provian", "credentials")


def _parse_credentials_file(content: str) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _credentials_file_is_private(path: str) -> bool:
    """The TS SDK's rule (``readCredentialsFile``): a credentials file another user can read or
    write, or a symlink, is ignored rather than trusted — a device secret is not shared with every
    account on the box. Windows carries no POSIX bits, so the file is taken as it is. Raises
    ``OSError`` when the file is absent."""
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        return False
    if os.name == "nt":
        return True
    return (st.st_mode & 0o077) == 0


def load_device_credentials(
    credential: Optional[str] = None,
    relay_url: Optional[str] = None,
    environ: Optional[Mapping[str, str]] = None,
    credentials_path: Optional[str] = None,
) -> DeviceCredentials:
    """Resolve the device credential. This fails closed, with no provisional fallback.

    Resolution order (the TS SDK's ``loadCredentials`` order, file before env):

    1. the explicit ``credential`` argument (``pdk_…:pds_…``);
    2. ``~/.provian/credentials``, the file ``register-device`` writes and the TS observer reads;
    3. the ``PROVIAN_DEVICE_KEY`` and ``PROVIAN_DEVICE_SECRET`` environment variables.

    The key and the secret always come from the SAME source: a file holding only a key is
    not paired with an env secret (that pairing can only 401).

    The relay URL comes from the ``relay_url`` argument, then the credentials file, then
    ``PROVIAN_RELAY_URL``, then production.
    """
    env = os.environ if environ is None else environ
    file_values: Dict[str, str] = {}
    ignored_file: Optional[str] = None
    path = credentials_path or default_credentials_path()
    try:
        if _credentials_file_is_private(path):
            with open(path, "r", encoding="utf-8") as fh:
                file_values = _parse_credentials_file(fh.read())
        else:
            ignored_file = path
    except OSError:
        file_values = {}
    url = (
        relay_url
        or file_values.get("PROVIAN_RELAY_URL")
        or env.get("PROVIAN_RELAY_URL")
        or DEFAULT_RELAY_URL
    )
    device_id = file_values.get("PROVIAN_DEVICE_ID") or env.get("PROVIAN_DEVICE_ID") or None
    if credential is not None:
        return DeviceCredentials.parse(credential, url, device_id)
    key: Optional[str] = None
    secret: Optional[str] = None
    for source in (file_values, env):
        if source.get("PROVIAN_DEVICE_KEY") and source.get("PROVIAN_DEVICE_SECRET"):
            key, secret = source["PROVIAN_DEVICE_KEY"], source["PROVIAN_DEVICE_SECRET"]
            # The device id belongs to the same credential source.
            device_id = source.get("PROVIAN_DEVICE_ID") or None
            break
    if not key or not secret:
        hint = ""
        if ignored_file is not None:
            hint = (
                " (%s was ignored: it is readable by other users or is a symlink; "
                "make it a regular file with mode 0600)" % ignored_file
            )
        raise ProvianError(
            "No registered device credential found. Register this machine with "
            "`npx @provian/agent-sdk register-device`, or set PROVIAN_DEVICE_KEY and "
            "PROVIAN_DEVICE_SECRET. The provisional path is not used here, because its "
            "PEs seal record_only and mint nothing." + hint,
            code="DEVICE_CREDENTIALS_REQUIRED",
        )
    return DeviceCredentials(key, secret, url, device_id)
