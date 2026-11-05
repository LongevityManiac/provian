"""PE METER for the Python SDK : PEs live with their owner.

The relay keeps no PE. A device builds each PE (v2) itself, keeps it in its local PE store, and
sends ONE signed batch per day of the act records (identity, pricing inputs and ``pe_hash`` —
never free text) to ``POST /v1/meter/batch``. The relay prices the acts, mints, keeps running
totals and answers with a receipt, which is filed beside the PEs. Totals, minted PVT and the
daily on-chain fingerprint are permanent; proving a specific act later requires keeping its PE.

This is a port of the TypeScript SDK's batcher (``provian-agent-sdk/src/meter/batcher.ts``) over
the same on-disk store (:mod:`provian.pe_store`) and the same wire (:mod:`provian.meter_wire`):

* class:`PeRecorder` appends a PE to this device's chain (under the store's lock) and, unless the
  observer daemon is running on this machine (the daemon batches every PE in the store), sends a
  batch once a day — timed from the last batch this store sent, so a short-lived script does not
  send on every run — and immediately before a presentation or an on-demand payout
  (:meth:`PeRecorder.send_before_use`), so those reflect the latest acts.
* class:`MeterSender` sends what the store holds: the batch being sent is persisted BEFORE it is
  sent and re-sent unchanged until the relay answers definitively; a batch is rebuilt only after a
  definitive refusal; when the relay's chain cannot be continued from this store, batching HALTS
  (persisted, shared with the daemon) — a PE is never rewritten to suit the relay.
* Each PE is sealed to whoever the relay names (an agent's linked human; a person's own phone) so
  the person receives an encrypted copy; the relay cannot open it.

The device HMAC body binding is the daemon's: ``Authorization: DeviceKey <pdk_…>:<pds_…>`` and
``X-Provian-Body-HMAC: hex(hmac_sha256(device_secret, exact wire body))``. A batch that is not
body-bound has every act refused.
"""

import atexit
import json
import logging
import os
import secrets
import threading
import time
from typing import Callable, Dict, List, Mapping, Optional, Sequence

import requests

from .device import DeviceCredentials, body_hmac_hex
from .exceptions import ProvianError
from .meter_wire import (
    MAX_ACTS_PER_BATCH,
    METER_GENESIS_PREV_HASH,
    PE_V2_SCHEMA,
    batch_hash_of,
    batch_leaf_of,
    build_batch,
    canonical_json,
    pe_hash_of,
    validate_batch_shape,
)
from .pe_store import FsPeStore, default_pe_store_root
from .sealed_box import from_b64u, seal_to_key, to_b64u

logger = logging.getLogger("provian.meter")

METER_BATCH_PATH = "/v1/meter/batch"
METER_BATCH_INTERVAL_S = 24 * 60 * 60
#: How soon to retry the proof read when the relay could not be read.
METER_PROOFS_RETRY_S = 60 * 60
#: Inclusion proofs exist once a day's batches are anchored; the daemon reads them daily.
METER_PROOFS_INTERVAL_S = 24 * 60 * 60
#: The relay lands at most one batch per 5 minutes per device unless the previous one was full.
METER_RELAY_MIN_INTERVAL_S = 5 * 60
METER_RETRY_BASE_S = 5 * 60
METER_RETRY_MAX_S = 60 * 60
METER_DEFAULT_MAX_BATCH_BYTES = 1_900_000
_MAX_SEALED_BOX_CHARS = 262_144
_CONCURRENT_RESENDS = 3

#: Printed with the store status: where PEs live.
PE_STORE_NOTICE = (
    "Your PEs live on this machine; the relay keeps totals, minted PVT and the fingerprint; "
    "proving an act requires keeping its PE."
)


def new_pe_id() -> str:
    """A fresh, unique PE id (``pe_`` + 24 hex), the TS SDK's ``newPeId`` form."""
    return "pe_" + secrets.token_hex(12)


def build_pe_v2(
    content: Mapping[str, object],
    device_id: str,
    prev_hash: str,
    timestamp_ms: int,
    pe_id: Optional[str] = None,
) -> Dict[str, object]:
    """One complete PE v2 at a chain position, with its ``pe_hash`` (``buildPeV2`` in the TS SDK).

    ``content`` carries ``action_type``, optional ``description``, ``metadata``, ``compute``,
    ``geo``, ``execution_env``, ``parent_goal_pe_id`` and the optional ``input_origins``,
    ``output_digests``, ``economic_session_lineage``. Raises ``CanonicalJsonError`` for content
    that cannot be hashed canonically: such a PE could never be proven, so it is never recorded.
    """
    action_type = content.get("action_type")
    if not isinstance(action_type, str) or not action_type:
        raise ValueError("content needs an action_type")
    metadata = content.get("metadata")
    pe: Dict[str, object] = {
        "schema": PE_V2_SCHEMA,
        "pe_id": pe_id or new_pe_id(),
        "device_id": device_id,
        "prev_hash": prev_hash,
        "timestamp": int(timestamp_ms),
        "action_type": action_type,
    }
    if isinstance(content.get("description"), str):
        pe["description"] = content["description"]
    pe["metadata"] = dict(metadata) if isinstance(metadata, Mapping) else {}
    for key in ("compute", "geo", "execution_env", "parent_goal_pe_id"):
        pe[key] = content.get(key)
    for key in ("input_origins", "output_digests", "economic_session_lineage"):
        if content.get(key) is not None:
            pe[key] = content[key]
    # Refuse what canonical JSON refuses, then normalise to plain JSON: the PE that is hashed is
    # byte for byte the PE that is stored and later re-read.
    canonical_json(pe)
    pe = json.loads(json.dumps(pe, allow_nan=False))
    pe["pe_hash"] = pe_hash_of(pe)
    return pe


# --- the daemon ----------------------------------------------------------------------

def observer_daemon_running(home: Optional[str] = None) -> bool:
    """True when the TS observer daemon's pidfile names a live process. The daemon batches every PE
    in the store, so a second batcher for the same device would only race it."""
    path = os.path.join(home or os.path.expanduser("~"), ".provian", "observer.pid")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            pid = int(fh.read().strip())
    except (OSError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


# --- transport -----------------------------------------------------------------------

class MeterAnswer:
    """One relay answer: ``status`` (None = no HTTP answer at all), parsed ``body``, ``error``."""

    __slots__ = ("status", "body", "error")

    def __init__(self, status: Optional[int], body: object, error: Optional[str]):
        self.status = status
        self.body = body
        self.error = error

    def error_code(self) -> Optional[str]:
        return self.body.get("error") if isinstance(self.body, dict) and isinstance(self.body.get("error"), str) else None


class PreparedBatch:
    """The exact bytes and headers of one batch POST. Its repr never shows the credential."""

    __slots__ = ("url", "body", "headers")

    def __init__(self, url: str, body: bytes, headers: Dict[str, str]):
        self.url = url
        self.body = body
        self.headers = headers

    def __repr__(self) -> str:
        return "PreparedBatch(url=%r, body_bytes=%d)" % (self.url, len(self.body))


class MeterTransport:
    """The device's ``/v1/meter/*`` surface, device-authenticated; the batch POST body-bound."""

    def __init__(self, credentials: DeviceCredentials, session: Optional[requests.Session] = None, timeout_s: float = 10.0):
        self._credentials = credentials
        self._session = session or requests.Session()
        self._timeout_s = timeout_s

    def _auth(self) -> Dict[str, str]:
        return {"Authorization": "DeviceKey %s:%s" % (self._credentials.device_key, self._credentials.device_secret)}

    def prepare_batch(self, batch: Mapping[str, object]) -> PreparedBatch:
        """The wire body is the batch's canonical JSON; the HMAC is over exactly those bytes."""
        wire = canonical_json(batch).encode("utf-8")
        headers = {"Content-Type": "application/json", **self._auth()}
        headers["X-Provian-Body-HMAC"] = body_hmac_hex(self._credentials.device_secret, wire)
        return PreparedBatch(self._credentials.relay_url + METER_BATCH_PATH, wire, headers)

    def _answer(self, call: Callable[[], requests.Response]) -> MeterAnswer:
        try:
            response = call()
        except requests.RequestException as exc:
            return MeterAnswer(None, None, "transport: %s" % type(exc).__name__)
        try:
            body = response.json() if response.content else None
        except ValueError:
            body = None
        ok = 200 <= response.status_code < 300
        return MeterAnswer(response.status_code, body, None if ok else "HTTP %d" % response.status_code)

    def post_batch(self, batch: Mapping[str, object]) -> MeterAnswer:
        prepared = self.prepare_batch(batch)
        return self._answer(lambda: self._session.post(prepared.url, data=prepared.body, headers=prepared.headers, timeout=self._timeout_s))

    def _get(self, path: str) -> MeterAnswer:
        url = self._credentials.relay_url + path
        return self._answer(lambda: self._session.get(url, headers={"Accept": "application/json", **self._auth()}, timeout=self._timeout_s))

    def get_tip(self) -> MeterAnswer:
        return self._get("/v1/meter/tip")

    def get_seal_targets(self) -> MeterAnswer:
        return self._get("/v1/meter/seal-targets")

    def get_proofs(self, after_seq: int) -> MeterAnswer:
        return self._get("/v1/meter/proofs?after_seq=%d" % int(after_seq))


def resolve_device_id(credentials: DeviceCredentials, transport: MeterTransport) -> str:
    """The device id names the store: ``PROVIAN_DEVICE_ID`` in the credentials, else the relay's tip."""
    if credentials.device_id:
        return credentials.device_id
    answer = transport.get_tip()
    if answer.status == 200 and isinstance(answer.body, dict) and isinstance(answer.body.get("device_id"), str) and answer.body["device_id"]:
        return answer.body["device_id"]
    raise ProvianError(
        "This device's id is not in its credentials and the relay could not supply it (%s)." % (answer.status or answer.error),
        code="DEVICE_ID_UNKNOWN",
    )


# --- the sender ----------------------------------------------------------------------

def _hex64(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


class SendReport:
    __slots__ = ("outcome", "batches_accepted", "acts_accepted", "retry_at", "last_status", "halt")

    def __init__(self, outcome: str, batches_accepted: int, acts_accepted: int, retry_at: Optional[float],
                 last_status: Optional[int], halt: Optional[Dict[str, object]] = None):
        self.outcome = outcome
        self.batches_accepted = batches_accepted
        self.acts_accepted = acts_accepted
        self.retry_at = retry_at
        self.last_status = last_status
        self.halt = halt

    def __repr__(self) -> str:
        return "SendReport(outcome=%r, batches=%d, acts=%d, status=%r)" % (
            self.outcome, self.batches_accepted, self.acts_accepted, self.last_status)


class MeterSender:
    """Sends this device's unsent PEs as signed batches (``MeterBatcher.sendPending`` in the TS SDK)."""

    def __init__(
        self,
        store: FsPeStore,
        transport: MeterTransport,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        max_batch_bytes: int = METER_DEFAULT_MAX_BATCH_BYTES,
        seal_random: Optional[Callable[[int], bytes]] = None,
    ):
        self.store = store
        self.transport = transport
        self._now = now
        self._sleep = sleep
        self._max_batch_bytes = max_batch_bytes
        self._seal_random = seal_random
        self._failures = 0
        self._lock = threading.Lock()

    def _ms(self) -> int:
        return int(self._now() * 1000)

    def _position(self) -> Dict[str, object]:
        last = self.store.last_batch()
        if last is None:
            return {"seq": 0, "batch_hash": METER_GENESIS_PREV_HASH, "last_pe_hash": METER_GENESIS_PREV_HASH, "next_index": 0}
        return {"seq": last["seq"], "batch_hash": last["batch_hash"], "last_pe_hash": last["last_pe_hash"],
                "next_index": int(last["first_index"]) + int(last["count"])}  # type: ignore[call-overload]

    def _halt_with(self, reason: str, detail: str) -> Dict[str, object]:
        halt = {"reason": reason, "detail": detail, "at_ms": self._ms()}
        self.store.set_halt(halt)
        logger.error(
            "PE METER HALTED for device %s: %s - %s. PEs keep being recorded on this machine, but no "
            "batch is sent until this is resolved. PEs are never rewritten to suit the relay.",
            self.store.device_id, reason, detail)
        return halt

    def _retry_after_failure(self) -> float:
        self._failures += 1
        exp = min(self._failures - 1, 10)
        return self._now() + min(METER_RETRY_BASE_S * (2 ** exp), METER_RETRY_MAX_S)

    def seal_targets(self) -> Optional[List[Dict[str, object]]]:
        """Whom to seal each PE to. None = the relay could not be asked (the batch waits)."""
        answer = self.transport.get_seal_targets()
        if answer.status == 200 and isinstance(answer.body, dict) and isinstance(answer.body.get("targets"), list):
            return [t for t in answer.body["targets"] if isinstance(t, dict) and isinstance(t.get("to"), str)
                    and isinstance(t.get("party_id"), str) and isinstance(t.get("pubkey_b64u"), str)]
        if answer.status is not None and 400 <= answer.status < 500 and answer.status not in (401, 429):
            return []  # the relay answered and has nothing for us: send without sealed copies
        return None

    def _seal(self, pes: Sequence[Mapping[str, object]], targets: Sequence[Mapping[str, object]]) -> List[Dict[str, str]]:
        sealed: List[Dict[str, str]] = []
        for target in targets:
            try:
                key = from_b64u(str(target["pubkey_b64u"]))
            except (ValueError, TypeError):
                logger.warning("pe meter: a seal target key is malformed; sending without that copy")
                continue
            for pe in pes:
                try:
                    eph = self._seal_random(32) if self._seal_random else None
                    box = to_b64u(seal_to_key(key, canonical_json(pe).encode("utf-8"), eph))
                except ValueError as exc:
                    logger.warning("pe meter: could not seal to a target key (%s); sending without that copy", exc)
                    break
                if len(box) > _MAX_SEALED_BOX_CHARS:
                    logger.warning("pe meter: PE %s too large to seal within the relay limit; its sealed copy is skipped", pe.get("pe_id"))
                    continue
                sealed.append({"to": str(target["to"]), "pe_id": str(pe["pe_id"]), "box": box})
        return sealed

    def _build_next(self, position: Mapping[str, object], targets: Sequence[Mapping[str, object]]) -> Optional[Dict[str, object]]:
        """The next batch (an in-flight record), None when nothing is unsent; a halt dict on a local fault."""
        next_index = int(position["next_index"])  # type: ignore[call-overload]
        rows = self.store.read_pes(next_index, MAX_ACTS_PER_BATCH)
        if not rows:
            return None
        prev = position["last_pe_hash"]
        for i, row in enumerate(rows):
            if row["index"] != next_index + i or row["pe"].get("prev_hash") != prev:
                return {"halt": self._halt_with("local_chain_gap", "PE %d does not continue the batched chain" % (next_index + i))}
            prev = row["pe"]["pe_hash"]
        count = len(rows)
        while True:
            pes = [row["pe"] for row in rows[:count]]
            batch = build_batch(self.store.device_id, int(position["seq"]) + 1, str(position["batch_hash"]),  # type: ignore[call-overload]
                                self._ms(), pes, self._seal(pes, targets))
            size = len(canonical_json(batch).encode("utf-8"))
            if size > self._max_batch_bytes and count > 1:
                count = max(1, min(count - 1, int(count * (self._max_batch_bytes / size) * 0.95)))
                continue
            shape = validate_batch_shape(json.loads(canonical_json(batch)))
            if shape is not None:
                return {"halt": self._halt_with("local_batch_invalid", "the batch built from PEs %d..%d fails the wire check (%s)" % (
                    next_index, next_index + count - 1, shape[0]))}
            return {"batch": batch, "batch_hash": batch_hash_of(batch), "first_index": next_index, "count": count,
                    "last_pe_hash": pes[-1]["pe_hash"], "persisted_at_ms": self._ms()}

    def _accept(self, inflight: Mapping[str, object], receipt: Mapping[str, object]) -> None:
        batch = inflight["batch"]
        assert isinstance(batch, Mapping)
        record = {
            "seq": batch["seq"], "batch_hash": inflight["batch_hash"], "prev_batch_hash": batch["prev_batch_hash"],
            "acts_root": batch["acts_root"], "first_index": inflight["first_index"], "count": inflight["count"],
            "last_pe_hash": inflight["last_pe_hash"], "created_at_ms": batch["created_at_ms"],
            "accepted_at_ms": receipt.get("accepted_at_ms") if isinstance(receipt.get("accepted_at_ms"), int) else None,
            "actor_id": receipt.get("actor_id") if isinstance(receipt.get("actor_id"), str) else None,
            "totals": receipt.get("totals"),
        }
        # ORDER: receipt + cursor first, then the in-flight copy goes (a crash between the two leaves
        # an in-flight batch at or below the cursor, which the next cycle recognises and clears).
        self.store.record_batch(record, receipt)
        self.store.set_in_flight(None)
        totals = receipt.get("totals") if isinstance(receipt.get("totals"), dict) else {}
        logger.info("pe batch accepted: seq %s, %s act(s), %s eligible", record["seq"], record["count"], totals.get("eligible"))

    def _resync(self, answer: MeterAnswer, inflight: Mapping[str, object]) -> object:
        """The relay refused the batch's position. Adopt its tip only when its last PE is one of this
        device's own unbatched PEs (lost local bookkeeping); anything else halts."""
        tip = self.transport.get_tip()
        relay = None
        if tip.status == 200 and isinstance(tip.body, dict) and isinstance(tip.body.get("seq"), int) \
                and isinstance(tip.body.get("batch_hash"), str) and isinstance(tip.body.get("last_pe_hash"), str):
            relay = (tip.body["seq"], tip.body["batch_hash"], tip.body["last_pe_hash"])
        elif isinstance(answer.body, dict) and isinstance(answer.body.get("expected_seq"), int) \
                and isinstance(answer.body.get("expected_prev_batch_hash"), str) and isinstance(answer.body.get("last_pe_hash"), str):
            relay = (answer.body["expected_seq"] - 1, answer.body["expected_prev_batch_hash"], answer.body["last_pe_hash"])
        batch = inflight["batch"]
        assert isinstance(batch, Mapping)
        if relay is None:
            return self._halt_with("relay_tip_unreadable", "the relay refused batch seq %s (%s) and its tip could not be read" % (batch["seq"], answer.error_code()))
        local = self._position()
        if relay[0] > int(local["seq"]) and _hex64(relay[2]):  # type: ignore[call-overload]
            count = int(self.store.head()["count"])  # type: ignore[call-overload]
            index = int(local["next_index"])  # type: ignore[call-overload]
            while index < count:
                for row in self.store.read_pes(index, MAX_ACTS_PER_BATCH):
                    if row["pe"].get("pe_hash") == relay[2]:
                        self.store.record_batch({
                            "seq": relay[0], "batch_hash": relay[1], "prev_batch_hash": local["batch_hash"], "acts_root": None,
                            "first_index": local["next_index"], "count": int(row["index"]) - int(local["next_index"]) + 1,  # type: ignore[call-overload]
                            "last_pe_hash": relay[2], "created_at_ms": None, "accepted_at_ms": None, "actor_id": None,
                            "totals": None, "adopted": True,
                        }, None)
                        self.store.set_in_flight(None)
                        logger.warning("pe meter: the relay already held batches this machine had no record of; resynced to its tip (no PE changed)")
                        return "adopted"
                index += MAX_ACTS_PER_BATCH
        reason = "relay_behind_local" if relay[0] < int(local["seq"]) else "relay_chain_diverged"  # type: ignore[call-overload]
        return self._halt_with(reason, "relay tip seq %s / last PE %s; this machine's last accepted seq %s / last PE %s" % (
            relay[0], relay[2], local["seq"], local["last_pe_hash"]))

    def send_pending(self) -> SendReport:
        """Send every unsent PE that can go now. Single-flight in this process; never raises."""
        if not self._lock.acquire(blocking=False):
            return SendReport("busy", 0, 0, None, None)
        try:
            return self._send_pending_once()
        except Exception as exc:  # a send failure never reaches the caller's agent
            logger.warning("pe meter send failed: %s", exc)
            return SendReport("deferred", 0, 0, self._retry_after_failure(), None)
        finally:
            self._lock.release()

    def _send_pending_once(self) -> SendReport:
        accepted_batches = 0
        accepted_acts = 0
        last_status: Optional[int] = None
        resends = 0
        rebuilds = 0

        def report(outcome: str, retry_at: Optional[float], halt: Optional[Dict[str, object]] = None) -> SendReport:
            return SendReport(outcome, accepted_batches, accepted_acts, retry_at, last_status, halt)

        for _guard in range(1000):
            halted = self.store.halt()
            if halted is not None:
                return report("halted", None, halted)
            position = self._position()
            inflight = self.store.in_flight()
            if inflight is not None and int(inflight["batch"]["seq"]) <= int(position["seq"]):  # type: ignore[index, call-overload]
                self.store.set_in_flight(None)  # its receipt was filed before a crash cleared it
                inflight = None
            if inflight is not None and (inflight["batch"]["seq"] != int(position["seq"]) + 1  # type: ignore[index, call-overload]
                                         or inflight["batch"]["prev_batch_hash"] != position["batch_hash"]  # type: ignore[index]
                                         or inflight["first_index"] != position["next_index"]):
                return report("halted", None, self._halt_with(
                    "inflight_inconsistent", "the persisted in-flight batch does not extend the last accepted batch (seq %s)" % position["seq"]))
            if inflight is None:
                targets = self.seal_targets()
                if targets is None:
                    logger.warning("pe meter: relay unreachable (seal targets); PEs stay queued on this machine")
                    return report("sent" if accepted_batches else "deferred", self._retry_after_failure())
                built = self._build_next(position, targets)
                if built is None:
                    self._failures = 0
                    return report("sent" if accepted_batches else "nothing_to_send", None)
                if "halt" in built:
                    return report("halted", None, built["halt"])  # type: ignore[arg-type]
                # Durable BEFORE it is sent: a crash from here on re-sends exactly this batch.
                self.store.set_in_flight(built)
                inflight = built

            batch = inflight["batch"]
            assert isinstance(batch, Mapping)
            answer = self.transport.post_batch(batch)
            last_status = answer.status
            code = answer.error_code()

            if answer.status in (200, 201):
                receipt = answer.body
                if (not isinstance(receipt, dict) or receipt.get("schema") != "provian.pe-batch-receipt.v1"
                        or receipt.get("batch_hash") != inflight["batch_hash"] or receipt.get("seq") != batch["seq"]):
                    return report("halted", None, self._halt_with(
                        "receipt_mismatch", "the relay answered %s with a receipt for a different batch than seq %s" % (answer.status, batch["seq"])))
                self._accept(inflight, receipt)
                accepted_batches += 1
                accepted_acts += int(inflight["count"])  # type: ignore[call-overload]
                resends = 0
                self._failures = 0
                if int(inflight["count"]) >= MAX_ACTS_PER_BATCH:  # type: ignore[call-overload]
                    continue  # a full batch: the relay takes the next one at once
                more = int(self.store.head()["count"]) > int(inflight["first_index"]) + int(inflight["count"])  # type: ignore[call-overload]
                return report("sent", self._now() + METER_RELAY_MIN_INTERVAL_S + 5 if more else None)

            if answer.status == 409 and code in ("batch_concurrent", "batch_retry"):
                if resends < _CONCURRENT_RESENDS:
                    resends += 1
                    self._sleep(1.0)
                    continue
                return report("sent" if accepted_batches else "deferred", self._retry_after_failure())

            if answer.status == 409 and code in ("batch_replay", "batch_chain_broken"):
                outcome = self._resync(answer, inflight)
                if outcome == "adopted":
                    continue
                return report("halted", None, outcome)  # type: ignore[arg-type]

            if answer.status == 409 and code == "act_chain_broken":
                body = answer.body if isinstance(answer.body, dict) else {}
                acts = batch.get("acts")
                first_prev = acts[0].get("prev_hash") if isinstance(acts, list) and acts else "?"
                return report("halted", None, self._halt_with(
                    "act_chain_broken", "the relay's last accepted PE for this device is %s, but this device's batch continues from %s" % (
                        body.get("last_pe_hash"), first_prev)))

            if answer.status == 429:
                body = answer.body if isinstance(answer.body, dict) else {}
                after_s = (body["retry_after_ms"] / 1000.0 if isinstance(body.get("retry_after_ms"), (int, float))
                           else float(body["retry_after"]) if isinstance(body.get("retry_after"), (int, float)) else METER_RELAY_MIN_INTERVAL_S)
                return report("sent" if accepted_batches else "deferred", self._now() + max(1.0, after_s))

            if answer.status == 413:
                # Definitive: nothing was committed. Rebuild smaller (a PE is never changed).
                self.store.set_in_flight(None)
                if int(inflight["count"]) <= 1 or rebuilds >= 8:  # type: ignore[call-overload]
                    return report("halted", None, self._halt_with("pe_too_large", "PE %s alone exceeds the relay's request-size limit" % inflight["first_index"]))
                rebuilds += 1
                size = len(canonical_json(batch).encode("utf-8"))
                self._max_batch_bytes = max(1_000, min(self._max_batch_bytes, size // 2))
                continue

            if answer.status == 400 and code == "batch_invalid":
                body = answer.body if isinstance(answer.body, dict) else {}
                return report("halted", None, self._halt_with("batch_invalid", "the relay refused the batch's shape (%s)" % body.get("code")))

            if answer.status == 403 and code == "batch_device_mismatch":
                return report("halted", None, self._halt_with("batch_device_mismatch", "the relay authenticated a different device than %s" % self.store.device_id))

            # No answer, 5xx, 401/407, anything unrecognised: the outcome may be unknown, so the SAME
            # batch stays in flight and is re-sent later.
            logger.warning("pe meter: batch not accepted yet (status %s, %s); it stays queued and is re-sent", answer.status, code or answer.error)
            return report("sent" if accepted_batches else "deferred", self._retry_after_failure())
        return report("deferred", self._retry_after_failure())

    def fetch_proofs(self) -> Dict[str, int]:
        """File each anchored batch's inclusion proof (``/v1/meter/proofs``). A proof whose batch leaf
        does not recompute from this device's own batch record is kept as ``verified: false``."""
        held = self.store.list_proofs()
        held_seqs = {p.get("seq") for p in held}
        after = max([int(p["seq"]) for p in held if isinstance(p.get("seq"), int)] or [0])
        batches = {b.get("seq"): b for b in self.store.list_batches()}
        fetched = unverified = 0
        for _page in range(100):
            answer = self.transport.get_proofs(after)
            if answer.status != 200 or not isinstance(answer.body, dict) or not isinstance(answer.body.get("proofs"), list):
                return {"ok": 0, "fetched": fetched, "unverified": unverified}
            proofs = answer.body["proofs"]
            for raw in proofs:
                if (not isinstance(raw, dict) or not isinstance(raw.get("seq"), int) or not _hex64(raw.get("batch_hash"))
                        or not _hex64(raw.get("batch_leaf")) or not _hex64(raw.get("acts_root"))
                        or not isinstance(raw.get("actor_id"), str) or not isinstance(raw.get("anchor"), dict)):
                    continue
                if raw["seq"] in held_seqs:
                    continue
                own = batches.get(raw["seq"])
                leaf = batch_leaf_of(self.store.device_id, raw["actor_id"], raw["seq"], raw["batch_hash"], raw["acts_root"])
                verified = (own is not None and own.get("adopted") is not True and own.get("batch_hash") == raw["batch_hash"]
                            and own.get("acts_root") == raw["acts_root"] and leaf == raw["batch_leaf"])
                if not verified:
                    unverified += 1
                self.store.record_proof({
                    "seq": raw["seq"], "batch_hash": raw["batch_hash"], "batch_leaf": raw["batch_leaf"],
                    "acts_root": raw["acts_root"], "actor_id": raw["actor_id"], "anchor": raw["anchor"],
                    "fetched_at_ms": self._ms(), "verified": verified,
                })
                held_seqs.add(raw["seq"])
                fetched += 1
                after = max(after, raw["seq"])
            nxt = answer.body.get("next_after_seq")
            if not proofs or not isinstance(nxt, int):
                break
            after = max(after, nxt)
        return {"ok": 1, "fetched": fetched, "unverified": unverified}


# --- the recorder ----------------------------------------------------------------------

class PeRecorder:
    """Records observed PEs on this device's chain and sends them in one batch a day.

    ``record(content)`` builds a PE v2 at the store's head and appends it (no network). After each
    record, and at interpreter exit, it sends a batch when one is due (a day after the last batch
    this store sent) — unless the observer daemon
    is running here, which batches every PE in the store itself.
    """

    def __init__(
        self,
        credentials: DeviceCredentials,
        session: Optional[requests.Session] = None,
        store_root: Optional[str] = None,
        timeout_s: float = 10.0,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        daemon_running: Callable[[], bool] = observer_daemon_running,
        flush_at_exit: bool = True,
        seal_random: Optional[Callable[[int], bytes]] = None,
    ):
        self.transport = MeterTransport(credentials, session=session, timeout_s=timeout_s)
        self._credentials = credentials
        self._store_root = store_root or default_pe_store_root()
        self._now = now
        self._sleep = sleep
        self._daemon_running = daemon_running
        self._seal_random = seal_random
        self._sender: Optional[MeterSender] = None
        self._next_send_at = 0.0
        self._next_proofs_at = 0.0
        self.last_report: Optional[SendReport] = None
        if flush_at_exit:
            atexit.register(self._flush_at_exit)

    @property
    def relay_url(self) -> str:
        return self._credentials.relay_url

    def sender(self) -> MeterSender:
        if self._sender is None:
            device_id = resolve_device_id(self._credentials, self.transport)
            self._sender = MeterSender(FsPeStore(device_id, self._store_root), self.transport,
                                       now=self._now, sleep=self._sleep, seal_random=self._seal_random)
        return self._sender

    def record(self, content: Mapping[str, object]) -> Dict[str, object]:
        """Append one PE to this device's chain. Returns ``{pe_id, pe_hash, recorded_locally}``."""
        store = self.sender().store
        for _attempt in range(8):
            head = store.head()
            pe = build_pe_v2(content, store.device_id, str(head["last_pe_hash"]), int(self._now() * 1000))
            result = store.append(pe)
            if result["ok"]:
                self.maybe_send()
                return {"pe_id": pe["pe_id"], "pe_hash": pe["pe_hash"], "recorded_locally": True}
            if result["reason"] == "invalid":
                raise ProvianError("PE refused by the local store: %s" % result.get("detail"), code="PE_REFUSED")
        raise ProvianError("the PE store head kept moving", code="PE_STORE_BUSY")

    def maybe_send(self) -> Optional[SendReport]:
        """Send when a batch is due (a day after the store's last batch, sooner after a deferral).

        The due time is read from the store (the last batch's ``created_at_ms``), so it holds across
        processes. The daemon batches when it runs.
        """
        if self._daemon_running() or self._now() < self._next_send_at:
            return None
        last = self.sender().store.last_batch()
        created = last.get("created_at_ms") if last else None
        if isinstance(created, (int, float)) and self._now() < created / 1000.0 + METER_BATCH_INTERVAL_S:
            return None
        return self.flush()

    def send_before_use(self) -> Optional[SendReport]:
        """Send what the store holds NOW — call this right before a presentation or an on-demand
        payout so it reflects the latest acts. Never raises."""
        return self.flush()

    def flush(self) -> Optional[SendReport]:
        """Send now (unless the daemon runs here). Never raises."""
        if self._daemon_running():
            return None
        try:
            report = self.sender().send_pending()
        except Exception as exc:  # resolving the device id can fail offline
            logger.warning("pe meter: could not send (%s); PEs stay on this machine", exc)
            self._next_send_at = self._now() + METER_RETRY_BASE_S
            return None
        self.last_report = report
        self._next_send_at = report.retry_at if report.retry_at is not None else self._now() + METER_BATCH_INTERVAL_S
        if self._now() >= self._next_proofs_at:
            try:
                fetched = self.sender().fetch_proofs()
            except Exception as exc:  # a proof read never reaches the caller's agent
                logger.warning("pe meter: could not fetch inclusion proofs (%s)", exc)
                fetched = {"ok": 0}
            # Daily, like the daemon; an hour when the relay could not be read.
            self._next_proofs_at = self._now() + (METER_PROOFS_INTERVAL_S if fetched.get("ok") else METER_PROOFS_RETRY_S)
        return report

    def _flush_at_exit(self) -> None:
        try:
            if self._sender is not None:
                self.maybe_send()  # only when a batch is due; the PEs stay in the store otherwise
        except Exception:  # pragma: no cover - interpreter shutdown
            pass

    def status(self) -> Dict[str, object]:
        """Where this device's PEs live and how far batching has got."""
        store = self.sender().store
        head = store.head()
        last = store.last_batch()
        batched = int(last["first_index"]) + int(last["count"]) if last else 0  # type: ignore[call-overload]
        return {
            "device_id": store.device_id,
            "location": store.location,
            "pes_stored": head["count"],
            "unsent": max(0, int(head["count"]) - batched),  # type: ignore[call-overload]
            "last_batch": last,
            "proofs_fetched": len(store.list_proofs()),
            "halted": store.halt(),
            "notice": PE_STORE_NOTICE,
        }
