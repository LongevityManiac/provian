"""This device's own PE store, ON DISK IN THE SAME FORMAT the TypeScript SDK and the observer
daemon keep (``provian-agent-sdk/src/meter/pe-store.ts`` ``FsPeStore``).

A PE lives with its owner: the relay keeps no PE. One device has ONE chain, and the Python
recorder records with the same device credential the daemon uses, so it appends to the daemon's
store, under the daemon's own lock, in the daemon's own line format. Two writers appending to two
separate chains for one device would fork it, and the relay refuses a forked chain.

Layout (``<root>/<device dir>/``; root = ``PROVIAN_PE_STORE_DIR`` or ``~/.provian/pe-store``)::

    pes.jsonl        one PE per line: {"i": index, "at": recorded ms, "k"?: idem key, "pe": PE}
    head.json        {"count", "last_pe_hash", "bytes"}: the chain head and the bytes it covers
    append.lock      "<pid>:<ms>", created exclusively (the cross-process append lock)
    idem/<key>.json  {"index", "pe_id", "offset"}
    batches.jsonl    every accepted batch (cursor records)     receipts.jsonl  the relay's receipts
    batch-head.json  {"batch": last accepted, "next_offset"}   inflight.json   the batch being sent
    proofs.jsonl     each anchored batch's inclusion proof      state.json      {"halt", "flags"}

The rules are the TypeScript store's: a PE is never rewritten; every append is fsynced before the
head moves; a torn final line (an append that never returned) is dropped; a head behind the file
is reconciled by re-verifying the extra lines.
"""

import json
import os
import secrets
import time
from typing import Dict, List, Mapping, Optional

from .exceptions import ProvianError
from .meter_wire import METER_GENESIS_PREV_HASH, PE_V2_SCHEMA, CanonicalJsonError, pe_hash_of, batch_leaf_of

PE_STORE_DIR_ENV = "PROVIAN_PE_STORE_DIR"
_LOCK_TIMEOUT_S = 10.0
_LOCK_STALE_MS = 60_000


class PeStoreCorruptError(ProvianError):
    def __init__(self, message: str):
        super().__init__(message, code="PE_STORE_CORRUPT")


def default_pe_store_root(environ: Optional[Mapping[str, str]] = None) -> str:
    env = os.environ if environ is None else environ
    configured = (env.get(PE_STORE_DIR_ENV) or "").strip()
    if configured:
        return os.path.abspath(configured)
    return os.path.join(os.path.expanduser("~"), ".provian", "pe-store")


def device_dir_name(device_id: str) -> str:
    ok = 0 < len(device_id) <= 200 and all(c.isascii() and (c.isalnum() or c in "_.:-") for c in device_id)
    if not ok or device_id in (".", ".."):
        raise ProvianError("pe_store_device_id_invalid", code="PE_STORE_DEVICE_ID_INVALID")
    return device_id.replace(":", "_")


def append_refusal(count: int, last_pe_hash: str, device_id: str, pe: Mapping[str, object]) -> Optional[str]:
    """The checks every store runs before a PE joins the chain (``appendRefusal``). None when it may."""
    if pe.get("schema") != PE_V2_SCHEMA:
        return "bad_schema"
    if pe.get("device_id") != device_id:
        return "device_mismatch"
    pe_id = pe.get("pe_id")
    if not isinstance(pe_id, str) or not 0 < len(pe_id) <= 200:
        return "bad_pe_id"
    action_type = pe.get("action_type")
    if not isinstance(action_type, str) or not 0 < len(action_type) <= 128:
        return "bad_action_type"
    ts = pe.get("timestamp")
    if not isinstance(ts, int) or isinstance(ts, bool) or ts <= 0 or ts > 2 ** 53 - 1:
        return "bad_timestamp"
    if pe.get("prev_hash") != last_pe_hash:
        return "prev_hash_mismatch"
    try:
        digest = pe_hash_of(pe)
    except CanonicalJsonError as exc:
        return "unhashable:%s" % exc
    return None if digest == pe.get("pe_hash") else "pe_hash_mismatch"


# --- file helpers (the TS store's durability rules) -----------------------------------

def _dumps(value: object) -> str:
    # ASCII-escaped JSON parses to the same value in JavaScript; the hash is over canonical JSON,
    # never over these bytes.
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def _read_json(path: str) -> Optional[Dict[str, object]]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            value = json.load(fh)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def _file_size(path: str) -> int:
    try:
        return os.stat(path).st_size
    except OSError:
        return 0


def _fsync_dir(directory: str) -> None:
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _atomic_replace_private(path: str, contents: str) -> None:
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    temp = "%s.%d.%s.tmp" % (path, os.getpid(), secrets.token_hex(8))
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, contents.encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temp, path)
        os.chmod(path, 0o600)
        _fsync_dir(directory)
    finally:
        try:
            os.unlink(temp)
        except OSError:
            pass


def _append_line_durable(path: str, line: str) -> None:
    existed = os.path.exists(path)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, line.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    if not existed:
        _fsync_dir(os.path.dirname(path))


def _heal_jsonl_tail(path: str) -> None:
    """Drop a torn final line (never a complete one)."""
    size = _file_size(path)
    if size == 0:
        return
    with open(path, "r+b") as fh:
        fh.seek(size - 1)
        if fh.read(1) == b"\n":
            return
        fh.seek(0)
        data = fh.read()
        cut = data.rfind(b"\n") + 1
        fh.truncate(cut)
        fh.flush()
        os.fsync(fh.fileno())


def _read_jsonl(path: str) -> List[Dict[str, object]]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return []
    out: List[Dict[str, object]] = []
    lines = text.split("\n")
    for line in lines[:-1]:  # the last element is '' or a torn line never acknowledged
        if not line:
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            out.append(value)
    return out


def _pid_alive(pid: int) -> bool:
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


class _AppendLock:
    """The TS store's ``append.lock`` protocol: ``wx`` create, ``<pid>:<ms>``; a holder is robbed only
    when its pid is gone, it is our own pid (a synchronous lock leftover), or the lock is stale."""

    def __init__(self, path: str):
        self._path = path
        self._token: Optional[str] = None

    def _holder_gone(self) -> bool:
        try:
            with open(self._path, "r", encoding="utf-8") as fh:
                pid_text, _, at_text = fh.read().partition(":")
            pid, at_ms = int(pid_text), int(at_text)
        except (OSError, ValueError):
            return True
        if pid == os.getpid() or not _pid_alive(pid):
            return True
        return int(time.time() * 1000) - at_ms > _LOCK_STALE_MS

    def _try(self) -> bool:
        for _ in range(3):
            try:
                fd = os.open(self._path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                if not self._holder_gone():
                    return False
                try:
                    os.unlink(self._path)
                except OSError:
                    pass
                continue
            token = "%d:%d" % (os.getpid(), int(time.time() * 1000))
            try:
                os.write(fd, token.encode("ascii"))
            finally:
                os.close(fd)
            self._token = token
            return True
        return False

    def __enter__(self) -> "_AppendLock":
        deadline = time.monotonic() + _LOCK_TIMEOUT_S
        while not self._try():
            if time.monotonic() >= deadline:
                raise ProvianError("pe_store_locked: %s is held by a running process" % self._path, code="PE_STORE_LOCKED")
            time.sleep(0.005)
        return self

    def __exit__(self, *_exc: object) -> None:
        try:
            with open(self._path, "r", encoding="utf-8") as fh:
                mine = fh.read() == self._token
            if mine:
                os.unlink(self._path)
        except OSError:
            pass


class FsPeStore:
    """One device's PE store (format-compatible with the TypeScript ``FsPeStore``)."""

    def __init__(self, device_id: str, root: Optional[str] = None):
        self.device_id = device_id
        self.location = os.path.join(root or default_pe_store_root(), device_dir_name(device_id))
        self._pes = os.path.join(self.location, "pes.jsonl")
        self._head = os.path.join(self.location, "head.json")
        self._idem = os.path.join(self.location, "idem")
        self._batches = os.path.join(self.location, "batches.jsonl")
        self._receipts = os.path.join(self.location, "receipts.jsonl")
        self._batch_head = os.path.join(self.location, "batch-head.json")
        self._inflight = os.path.join(self.location, "inflight.json")
        self._proofs = os.path.join(self.location, "proofs.jsonl")
        self._state = os.path.join(self.location, "state.json")
        self._lock = os.path.join(self.location, "append.lock")
        # The paid PE Archive : the TypeScript daemon may replace a PE line whose day
        # the Archive confirmed with a pointer ``{"i", "at", "a": {...}}``, rewriting pes.jsonl
        # through ``pes.jsonl.compact``. This store reads both; it never drops a PE itself.
        self._compact = os.path.join(self.location, "pes.jsonl.compact")

    # --- the chain ----------------------------------------------------------------

    def _scan(self, start_index: int, start_offset: int):
        """Yield (stored, offset, next_offset) for every complete PE line from (index, offset)."""
        try:
            fh = open(self._pes, "rb")
        except OSError:
            return
        with fh:
            fh.seek(start_offset)
            offset = start_offset
            index = start_index
            for raw in fh:
                if not raw.endswith(b"\n"):
                    return  # an append in progress elsewhere, or a torn line: not visited
                next_offset = offset + len(raw)
                text = raw[:-1].decode("utf-8")
                if text:
                    try:
                        line = json.loads(text)
                    except ValueError:
                        raise PeStoreCorruptError("unparseable PE line at byte %d of %s" % (offset, self._pes))
                    if line.get("i") != index:
                        raise PeStoreCorruptError("PE line at byte %d has index %r, expected %d" % (offset, line.get("i"), index))
                    if "pe" not in line and isinstance(line.get("a"), dict):
                        # A PE dropped here after its day was confirmed in the PE Archive: it keeps
                        # its chain position; its content lives in the Archive.
                        index += 1
                        offset = next_offset
                        continue
                    stored = {"index": index, "pe": line["pe"], "recorded_at_ms": line.get("at")}
                    if "k" in line:
                        stored["idempotency_key"] = line["k"]
                    index += 1
                    yield stored, offset, next_offset
                offset = next_offset

    def _finish_compaction_locked(self) -> None:
        """A PE Archive drop interrupted by a crash: finish the rename when the head already names the
        compacted size, otherwise discard the temp file (pes.jsonl is untouched). Mirrors the TS store."""
        if not os.path.exists(self._compact):
            return
        recorded = _read_json(self._head)
        if recorded is not None and _file_size(self._compact) == recorded.get("bytes") and _file_size(self._pes) != recorded.get("bytes"):
            os.replace(self._compact, self._pes)
            _fsync_dir(self.location)
        else:
            os.unlink(self._compact)

    def _reconcile_head_locked(self) -> Dict[str, object]:
        self._finish_compaction_locked()
        recorded = _read_json(self._head)
        head = recorded or {"count": 0, "last_pe_hash": METER_GENESIS_PREV_HASH, "bytes": 0}
        size = _file_size(self._pes)
        if size == head["bytes"]:
            return head
        if size < head["bytes"]:  # type: ignore[operator]
            raise PeStoreCorruptError("%s is %d bytes but its head records %r; PEs are missing" % (self._pes, size, head["bytes"]))
        _heal_jsonl_tail(self._pes)
        count, last, nbytes = int(head["count"]), str(head["last_pe_hash"]), int(head["bytes"])  # type: ignore[call-overload]
        for stored, offset, next_offset in self._scan(count, nbytes):
            refusal = append_refusal(count, last, self.device_id, stored["pe"])
            if refusal is not None:
                raise PeStoreCorruptError("PE %d does not continue the chain (%s)" % (stored["index"], refusal))
            if "idempotency_key" in stored:
                self._write_idem(str(stored["idempotency_key"]), stored["index"], stored["pe"]["pe_id"], offset)
            count, last, nbytes = count + 1, stored["pe"]["pe_hash"], next_offset
        head = {"count": count, "last_pe_hash": last, "bytes": nbytes}
        _atomic_replace_private(self._head, _dumps(head))
        return head

    def _write_idem(self, key: str, index: int, pe_id: str, offset: int) -> None:
        os.makedirs(self._idem, mode=0o700, exist_ok=True)
        _atomic_replace_private(os.path.join(self._idem, key + ".json"), _dumps({"index": index, "pe_id": pe_id, "offset": offset}))

    def head(self) -> Dict[str, object]:
        """``{"count", "last_pe_hash"}`` of this device's chain."""
        recorded = _read_json(self._head)
        size = _file_size(self._pes)
        if recorded is not None and size == recorded.get("bytes") and not os.path.exists(self._compact):
            return {"count": recorded["count"], "last_pe_hash": recorded["last_pe_hash"]}
        if recorded is None and size == 0:
            return {"count": 0, "last_pe_hash": METER_GENESIS_PREV_HASH}
        os.makedirs(self.location, mode=0o700, exist_ok=True)
        with _AppendLock(self._lock):
            head = self._reconcile_head_locked()
        return {"count": head["count"], "last_pe_hash": head["last_pe_hash"]}

    def append(self, pe: Mapping[str, object]) -> Dict[str, object]:
        """Append one complete PE (with its pe_hash) at the head. Returns ``{"ok": True, "stored"}``,
        or ``{"ok": False, "reason": "head_moved" | "invalid", ...}`` (the PE was not written)."""
        os.makedirs(self.location, mode=0o700, exist_ok=True)
        with _AppendLock(self._lock):
            head = self._reconcile_head_locked()
            if pe.get("prev_hash") != head["last_pe_hash"]:
                return {"ok": False, "reason": "head_moved", "head": {"count": head["count"], "last_pe_hash": head["last_pe_hash"]}}
            refusal = append_refusal(int(head["count"]), str(head["last_pe_hash"]), self.device_id, pe)  # type: ignore[call-overload]
            if refusal is not None:
                return {"ok": False, "reason": "invalid", "detail": refusal}
            recorded_at = int(time.time() * 1000)
            line = _dumps({"i": head["count"], "at": recorded_at, "pe": pe}) + "\n"
            _append_line_durable(self._pes, line)
            next_bytes = int(head["bytes"]) + len(line.encode("utf-8"))  # type: ignore[call-overload]
            _atomic_replace_private(self._head, _dumps({"count": int(head["count"]) + 1, "last_pe_hash": pe["pe_hash"], "bytes": next_bytes}))  # type: ignore[call-overload]
            return {"ok": True, "stored": {"index": head["count"], "pe": dict(pe), "recorded_at_ms": recorded_at}}

    def read_pes(self, from_index: int, limit: int) -> List[Dict[str, object]]:
        count = int(self.head()["count"])  # type: ignore[call-overload]
        wanted = min(max(0, limit), max(0, count - from_index))
        out: List[Dict[str, object]] = []
        if wanted <= 0:
            return out
        start_index, start_offset = 0, 0
        hint = _read_json(self._batch_head)
        if hint and isinstance(hint.get("next_offset"), int) and isinstance(hint.get("batch"), dict):
            b = hint["batch"]
            hint_index = int(b["first_index"]) + int(b["count"])  # type: ignore[index]
            if hint_index <= from_index:
                start_index, start_offset = hint_index, int(hint["next_offset"])  # type: ignore[call-overload]
        try:
            rows = self._scan(start_index, start_offset)
            for stored, _offset, _next in rows:
                if stored["index"] < from_index:
                    continue
                out.append(stored)
                if len(out) >= wanted:
                    break
        except PeStoreCorruptError:
            if start_offset == 0:
                raise
            out = []
            for stored, _offset, _next in self._scan(0, 0):
                if stored["index"] < from_index:
                    continue
                out.append(stored)
                if len(out) >= wanted:
                    break
        return out

    def find_pe(self, pe_id: str) -> Optional[Dict[str, object]]:
        for stored, _o, _n in self._scan(0, 0):
            if stored["pe"].get("pe_id") == pe_id:
                return stored
        return None

    # --- batches, in flight, proofs, state ---------------------------------------

    def last_batch(self) -> Optional[Dict[str, object]]:
        hint = _read_json(self._batch_head)
        batch = hint.get("batch") if hint else None
        return batch if isinstance(batch, dict) else None

    def list_batches(self) -> List[Dict[str, object]]:
        return _read_jsonl(self._batches)

    def record_batch(self, batch: Mapping[str, object], receipt: Optional[Mapping[str, object]]) -> None:
        os.makedirs(self.location, mode=0o700, exist_ok=True)
        if receipt is not None:
            _heal_jsonl_tail(self._receipts)
            _append_line_durable(self._receipts, _dumps(receipt) + "\n")
        _heal_jsonl_tail(self._batches)
        _append_line_durable(self._batches, _dumps(batch) + "\n")
        _atomic_replace_private(self._batch_head, _dumps({"batch": batch, "next_offset": None}))

    def read_receipt(self, seq: int) -> Optional[Dict[str, object]]:
        """The relay's receipt for batch ``seq`` (the newest if it was filed twice), or None."""
        found = None
        for receipt in _read_jsonl(self._receipts):
            if receipt.get("seq") == seq:
                found = receipt
        return found

    def in_flight(self) -> Optional[Dict[str, object]]:
        return _read_json(self._inflight)

    def set_in_flight(self, inflight: Optional[Mapping[str, object]]) -> None:
        if inflight is None:
            try:
                os.unlink(self._inflight)
            except OSError:
                pass
            return
        os.makedirs(self.location, mode=0o700, exist_ok=True)
        _atomic_replace_private(self._inflight, _dumps(inflight))

    def list_proofs(self) -> List[Dict[str, object]]:
        # Verification describes the metadata held now, including a recovered batch.
        # Keep the persisted proof and all owner backup files unchanged.
        batches = self.list_batches()
        out = []
        for proof in _read_jsonl(self._proofs):
            if (proof.get("verified") is not True
                    and isinstance(proof.get("actor_id"), str) and isinstance(proof.get("acts_root"), str)
                    and any(batch.get("seq") == proof.get("seq") and batch.get("adopted") is not True
                            and batch.get("batch_hash") == proof.get("batch_hash")
                            and batch.get("acts_root") == proof.get("acts_root")
                            and batch.get("actor_id") == proof.get("actor_id") for batch in batches)):
                leaf = batch_leaf_of(self.device_id, proof["actor_id"], proof["seq"], proof["batch_hash"], proof["acts_root"])
                if leaf == proof.get("batch_leaf"):
                    proof = dict(proof, verified=True)
            out.append(proof)
        return out

    def record_proof(self, proof: Mapping[str, object]) -> None:
        os.makedirs(self.location, mode=0o700, exist_ok=True)
        _heal_jsonl_tail(self._proofs)
        _append_line_durable(self._proofs, _dumps(proof) + "\n")

    def halt(self) -> Optional[Dict[str, object]]:
        state = _read_json(self._state) or {}
        halt = state.get("halt")
        return halt if isinstance(halt, dict) else None

    def set_halt(self, halt: Optional[Mapping[str, object]]) -> None:
        os.makedirs(self.location, mode=0o700, exist_ok=True)
        state = _read_json(self._state) or {"halt": None, "flags": []}
        state["halt"] = dict(halt) if halt is not None else None
        state.setdefault("flags", [])
        _atomic_replace_private(self._state, _dumps(state))
