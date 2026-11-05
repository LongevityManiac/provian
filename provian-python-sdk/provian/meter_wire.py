"""PE METER WIRE FORMAT, in Python: the v2 Provenance Envelope, its act record, the daily
batch, and the fingerprints over them (: the relay is a meter, not an
archive).

This is a port of ``provian-backend/src/core/meter/meter-wire.ts`` (the ONE definition, kept
byte-identical in the relay, the TypeScript SDK and the app). Every function here must produce
exactly the bytes and hashes that file produces; ``tests/test_meter_wire_vectors.py`` proves it
against the pinned vectors the relay generated (``docs/audit/meter-wire-vectors.json``).

WHAT EACH THING IS
  PE (v2) the complete envelope. Built, hashed and kept by its OWNER's device. The relay
              never stores it.
  act record what the relay prices: the PE's identity fields, its pe_hash (which covers the
              complete PE), and ``pricing`` = the PE minus identity fields and free text.
  batch one signed, chained submission per device per day (plus one right
              before a presentation or payout); ``acts_root`` is the
              fingerprint over every act leaf.
  batch leaf what the daily on-chain anchor commits to (one per accepted batch).

Pure: no I/O, no clock, no randomness.
"""

import hashlib
import math
from typing import Dict, List, Mapping, Optional, Sequence, Tuple, Union

from .device import _js_number, _js_string, _utf16_sort_key

PE_V2_SCHEMA = "provian.pe.v2"
PE_BATCH_SCHEMA = "provian.pe-batch.v1"
METER_GENESIS_PREV_HASH = "genesis"
MAX_ACTS_PER_BATCH = 500
#: An act older than this when it reaches the relay is recorded into totals but does not mint.
METER_MINT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

_ACT_LEAF_DOMAIN = "provian.meter.act.v1\n"
_BATCH_LEAF_DOMAIN = "provian.meter.batch-leaf.v1\n"

#: Fields of a PE that are identity or free text, never pricing inputs.
NON_PRICING_PE_FIELDS: Tuple[str, ...] = (
    "schema",
    "pe_id",
    "device_id",
    "prev_hash",
    "timestamp",
    "action_type",
    "pe_hash",
    "signature",
    "description",
    "intent_text",
)

#: Fields excluded from a PE's own hash (the hash cannot cover itself; the signature signs it).
_PE_HASH_EXCLUDED: Tuple[str, ...] = ("pe_hash", "signature")

#: JavaScript's Number.MAX_SAFE_INTEGER. A larger integer would not survive the relay's JSON
#: parse unchanged, so its hash could never be reproduced; it is refused like a non-finite number.
MAX_SAFE_INTEGER = 2 ** 53 - 1

JSON = Union[None, bool, int, float, str, List["JSON"], Dict[str, "JSON"]]


class CanonicalJsonError(ValueError):
    """A value that canonical JSON cannot carry (a PE holding it could never be proven)."""


# --- canonical JSON ----------------------------------------------------------------

def canonical_json(value: object) -> str:
    """Canonical JSON, byte-identical to ``canonicalJson`` in ``meter-wire.ts``.

    Object keys sorted by UTF-16 code unit, no whitespace, strings and numbers exactly as
    ECMAScript ``JSON.stringify`` writes them. Non-finite numbers are refused, and so are integers
    beyond JavaScript's safe range. Tuples serialize as arrays. ``None`` is ``null`` (Python has
    no ``undefined``: leave a key out to omit it).
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalJsonError("canonical_json_unsafe_integer")
        return str(value)
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise CanonicalJsonError("canonical_json_non_finite_number")
        return _js_number(value)
    if isinstance(value, str):
        return _js_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, Mapping):
        for key in value.keys():
            if not isinstance(key, str):
                raise CanonicalJsonError("canonical_json_non_string_key")
        keys = sorted(value.keys(), key=_utf16_sort_key)
        return "{" + ",".join(_js_string(k) + ":" + canonical_json(value[k]) for k in keys) + "}"
    raise CanonicalJsonError("canonical_json_unsupported_type:%s" % type(value).__name__)


# --- bytes -------------------------------------------------------------------------

def _has_lone_surrogate(text: str) -> bool:
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in text)


def sha256_hex_of_text(text: str) -> str:
    """sha256 hex of the UTF-8 text. TextEncoder writes a lone surrogate as U+FFFD; canonical JSON
    never contains one (it escapes them), but the rule is mirrored so any text hashes alike."""
    if _has_lone_surrogate(text):
        text = "".join("�" if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in text)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _is_hex64(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def _omit(source: Mapping[str, object], drop: Sequence[str]) -> Dict[str, object]:
    return {k: v for k, v in source.items() if k not in drop}


# --- the PE and its act record -------------------------------------------------------

def pe_hash_of(pe: Mapping[str, object]) -> str:
    """sha256 hex over the complete PE minus its own hash and signature."""
    return sha256_hex_of_text(canonical_json(_omit(pe, _PE_HASH_EXCLUDED)))


def pricing_of(pe: Mapping[str, object]) -> Dict[str, object]:
    """The pricing projection: everything in the PE except identity fields and free text."""
    return _omit(pe, NON_PRICING_PE_FIELDS)


def act_record_of(pe: Mapping[str, object]) -> Dict[str, object]:
    """The act record the relay prices. ``pe_hash`` covers the complete PE, free text included."""
    return {
        "pe_id": pe["pe_id"],
        "pe_hash": pe_hash_of(pe),
        "prev_hash": pe["prev_hash"],
        "timestamp": pe["timestamp"],
        "action_type": pe["action_type"],
        "pricing": pricing_of(pe),
    }


def act_leaf_of(act: Mapping[str, object]) -> str:
    """The act's leaf in its batch's ``acts_root``."""
    return sha256_hex_of_text(_ACT_LEAF_DOMAIN + canonical_json(act))


def hardware_nonce_of_act(act: Mapping[str, object]) -> str:
    """The hardware-witness binding nonce: the act's identity and every pricing input but the slot."""
    pricing = act["pricing"]
    assert isinstance(pricing, Mapping)
    return sha256_hex_of_text(canonical_json({
        "pe_id": act["pe_id"],
        "prev_hash": act["prev_hash"],
        "timestamp": act["timestamp"],
        "action_type": act["action_type"],
        "pricing": _omit(pricing, ("hardware_witness",)),
    }))


# --- Merkle (sha256; the same tagged, sorted-pair, power-of-two shape as PEAnchor) ----

_EMPTY_NODE = hashlib.sha256(b"").digest()


def _node_of(a: bytes, b: bytes) -> bytes:
    return hashlib.sha256(b"\x01" + a + b).digest() if a <= b else hashlib.sha256(b"\x01" + b + a).digest()


def _leaf_node_of(leaf_hex: str) -> bytes:
    if not _is_hex64(leaf_hex):
        raise ValueError("invalid_leaf")
    return hashlib.sha256(b"\x00" + bytes.fromhex(leaf_hex)).digest()


def _layers_of(leaf_hexes: Sequence[str]) -> List[List[bytes]]:
    if len(leaf_hexes) == 0:
        raise ValueError("empty_tree")
    base = [_leaf_node_of(h) for h in leaf_hexes]
    size = 1
    while size < len(base):
        size *= 2
    base.extend([_EMPTY_NODE] * (size - len(base)))
    layers = [base]
    current = base
    while len(current) > 1:
        current = [_node_of(current[i], current[i + 1]) for i in range(0, len(current), 2)]
        layers.append(current)
    return layers


def merkle_root_of(leaf_hexes: Sequence[str]) -> str:
    return _layers_of(leaf_hexes)[-1][0].hex()


def merkle_proof_of(leaf_hexes: Sequence[str], index: int) -> List[str]:
    if not isinstance(index, int) or index < 0 or index >= len(leaf_hexes):
        raise ValueError("leaf_index_out_of_range")
    layers = _layers_of(leaf_hexes)
    proof: List[str] = []
    i = index
    for level in range(len(layers) - 1):
        proof.append(layers[level][i + 1 if i % 2 == 0 else i - 1].hex())
        i //= 2
    return proof


def verify_merkle_proof_of(leaf_hex: str, proof: Sequence[str], root_hex: str) -> bool:
    try:
        node = _leaf_node_of(leaf_hex)
        for sibling in proof:
            if not _is_hex64(sibling):
                return False
            node = _node_of(node, bytes.fromhex(sibling))
        return node.hex() == root_hex
    except ValueError:
        return False


def acts_root_of(acts: Sequence[Mapping[str, object]]) -> str:
    """The fingerprint over a batch's acts, in order."""
    return merkle_root_of([act_leaf_of(a) for a in acts])


# --- the batch -----------------------------------------------------------------------

def batch_hash_of(batch: Mapping[str, object]) -> str:
    """sha256 over the batch minus its sealed copies (delivery payload, not part of the record)."""
    return sha256_hex_of_text(canonical_json(_omit(batch, ("sealed",))))


def batch_leaf_of(device_id: str, actor_id: str, seq: int, batch_hash: str, acts_root: str) -> str:
    """The 32-byte leaf the daily on-chain anchor commits to for one accepted batch."""
    return sha256_hex_of_text(_BATCH_LEAF_DOMAIN + canonical_json({
        "actor_id": actor_id,
        "acts_root": acts_root,
        "batch_hash": batch_hash,
        "device_id": device_id,
        "seq": seq,
    }))


def build_batch(
    device_id: str,
    seq: int,
    prev_batch_hash: str,
    created_at_ms: int,
    pes: Sequence[Mapping[str, object]],
    sealed: Optional[Sequence[Mapping[str, str]]] = None,
) -> Dict[str, object]:
    """Build a batch from complete PEs (client side)."""
    acts = [act_record_of(pe) for pe in pes]
    batch: Dict[str, object] = {
        "schema": PE_BATCH_SCHEMA,
        "device_id": device_id,
        "seq": seq,
        "prev_batch_hash": prev_batch_hash,
        "created_at_ms": created_at_ms,
        "acts": acts,
        "acts_root": acts_root_of(acts),
    }
    if sealed:
        batch["sealed"] = [dict(s) for s in sealed]
    return batch


_ACT_KEYS = ["action_type", "pe_hash", "pe_id", "prev_hash", "pricing", "timestamp"]


def _safe_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and abs(value) <= MAX_SAFE_INTEGER


def validate_batch_shape(batch: object) -> Optional[Tuple[str, Optional[int]]]:
    """The relay's structural check (``validateBatchShape``). None when the batch passes, else
    ``(error, act_index)``. Never trusts ``acts_root``: recomputes it."""
    if not isinstance(batch, Mapping) or batch.get("schema") != PE_BATCH_SCHEMA:
        return ("bad_schema", None)
    device_id = batch.get("device_id")
    if not isinstance(device_id, str) or not 0 < len(device_id) <= 200:
        return ("bad_device_id", None)
    seq = batch.get("seq")
    if not _safe_int(seq) or seq < 1:
        return ("bad_seq", None)
    prev = batch.get("prev_batch_hash")
    if not isinstance(prev, str) or (prev != METER_GENESIS_PREV_HASH and not _is_hex64(prev)):
        return ("bad_prev_batch_hash", None)
    created = batch.get("created_at_ms")
    if not _safe_int(created) or created <= 0:
        return ("bad_created_at", None)
    acts = batch.get("acts")
    if not isinstance(acts, list) or len(acts) == 0:
        return ("no_acts", None)
    if len(acts) > MAX_ACTS_PER_BATCH:
        return ("too_many_acts", None)
    seen = set()
    for i, a in enumerate(acts):
        if not isinstance(a, Mapping) or sorted(a.keys()) != _ACT_KEYS:
            return ("bad_act", i)
        if not isinstance(a["pe_id"], str) or not 0 < len(a["pe_id"]) <= 200:
            return ("bad_act", i)
        if not _is_hex64(a["pe_hash"]):
            return ("bad_act", i)
        if not isinstance(a["prev_hash"], str) or (a["prev_hash"] != METER_GENESIS_PREV_HASH and not _is_hex64(a["prev_hash"])):
            return ("bad_act", i)
        if not _safe_int(a["timestamp"]) or a["timestamp"] <= 0:
            return ("bad_act", i)
        if not isinstance(a["action_type"], str) or not 0 < len(a["action_type"]) <= 128:
            return ("bad_act", i)
        if not isinstance(a["pricing"], Mapping) or any(k in NON_PRICING_PE_FIELDS for k in a["pricing"]):
            return ("bad_act", i)
        if a["pe_id"] in seen:
            return ("duplicate_pe_id", i)
        seen.add(a["pe_id"])
    if batch.get("acts_root") != acts_root_of(acts):
        return ("acts_root_mismatch", None)
    sealed = batch.get("sealed")
    if sealed is not None:
        if not isinstance(sealed, list) or len(sealed) > MAX_ACTS_PER_BATCH * 2:
            return ("bad_sealed", None)
        for s in sealed:
            if (not isinstance(s, Mapping) or not isinstance(s.get("to"), str) or not isinstance(s.get("pe_id"), str)
                    or not isinstance(s.get("box"), str) or not 0 < len(s["box"]) <= 262_144 or s["pe_id"] not in seen):
                return ("bad_sealed", None)
    return None


def verify_act_chain(last_accepted_pe_hash: str, acts: Sequence[Mapping[str, object]]) -> Optional[int]:
    """None when the acts continue the device's chain, else the index of the first that does not."""
    prev = last_accepted_pe_hash
    for i, act in enumerate(acts):
        if act["prev_hash"] != prev:
            return i
        prev = act["pe_hash"]  # type: ignore[assignment]
    return None


def verify_act_inclusion(pe: Mapping[str, object], proof: Mapping[str, object]) -> Optional[str]:
    """Hop 1 of an inclusion proof: the batch leaf the PE's act proves, or None."""
    act = act_record_of(pe)
    act_proof = proof.get("act_proof")
    acts_root = proof.get("acts_root")
    batch = proof.get("batch")
    if not isinstance(act_proof, list) or not isinstance(acts_root, str) or not isinstance(batch, Mapping):
        return None
    if not verify_merkle_proof_of(act_leaf_of(act), act_proof, acts_root):
        return None
    return batch_leaf_of(batch["device_id"], batch["actor_id"], batch["seq"], batch["batch_hash"], acts_root)  # type: ignore[arg-type]
