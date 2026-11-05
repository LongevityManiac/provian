# provian-sdk

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

Provian connects contribution, evidence, and economic participation. Every act of work mints PVT once at its best-supported value; participants can use it for exchange and supported presentations of their own standing. The SDK, CLI, MCP, and API connect to the same proof and consent rules.

Python SDK for the [Provian Network](https://provian.ai) - the trust layer for the AI agent economy.

Every AI agent that does real work deserves proof it owns. Provian gives your agent a **Provenance Envelope (PE) chain** - hash-chained, cryptographically signed proof of what it builds. Every act of work mints **PVT** (Provian Value Token) once at its best-supported value.

This package is a read client for the relay, plus a registered device's local PE store and the
sender that delivers its act records to the relay in one signed batch a day.

## Install

```bash
pip install provian-sdk
```

## How a Python agent's work is witnessed

A Provenance Envelope exists only when something other than the agent vouches for
the work — the registered device observing it, a counterparty, a forge, or the chain.
An agent's own claim about its work is never a PE, so this SDK has no `submit_pe`.

1. Register the machine as a device: `npx @provian/agent-sdk register-device` (it writes
   `~/.provian/credentials`).
2. The Provian observer daemon then witnesses each agent program through exactly one lane:
   the program's session files if it keeps them, otherwise the local model proxy, otherwise
   OpenTelemetry, otherwise, for a program on its own machine with none of those, the process
   lane, which reads each command it runs from the operating system and mints it once.
   LangChain and CrewAI programs are witnessed the same way as any other
   program; there is no per-framework integration to install. Each model response calling
   one or more tools, including errored calls, makes one PE. Provider, model and sign-in
   changes keep that witness.

## Where your PEs live

The relay keeps no PE. Every PE recorded on this machine is a PE v2 (`provian.pe.v2`) kept
in the device's local PE store: `~/.provian/pe-store/<device_id>/` (override with
`PROVIAN_PE_STORE_DIR`). This SDK reads and writes the same store, in the same on-disk
format, that the TypeScript observer daemon keeps, so the two append to ONE chain for the
device (under the store's own lock) rather than forking it.

- **The batch.** Once a day the device sends one signed batch to
  `POST /v1/meter/batch`: for each PE its act record (identity, pricing inputs and
  `pe_hash` — never `description` or other free text), with
  `Authorization: DeviceKey pdk_…:pds_…` and `X-Provian-Body-HMAC` (HMAC-SHA256 of the
  exact batch bytes, keyed by the device secret). The relay prices the acts, mints, keeps
  running totals and answers with a receipt that is filed beside the PEs
  (`receipts.jsonl`; `FsPeStore.read_receipt(seq)`). When the observer daemon runs on this
  machine it sends the batches; otherwise `PeRecorder` does, once a day — timed from the
  last batch the store sent, so short scripts do not send on every run — and right before a
  presentation or payout (`recorder.send_before_use()`; `recorder.flush()` sends now).
- **Your copy to your human.** Each PE is also sealed (x25519 + XChaCha20-Poly1305) to
  whoever the relay names for this device — an agent's linked human — so the person
  receives an encrypted copy the relay cannot open.
- **Proofs.** Once a day's batches are anchored on Base, the sender files each batch's
  inclusion proof (`proofs.jsonl`, read daily; `MeterSender.fetch_proofs()` reads them now),
  and keeps a proof whose batch leaf does not recompute from this device's own batch as
  unverified. Proving a specific act later — presenting it as a fact — requires keeping its
  PE: the relay keeps totals, minted PVT and the daily fingerprint, never the PE.
- **Never rewritten.** A batch being sent is persisted before it is sent and re-sent
  unchanged until the relay answers, so a retry never records a second act. If the relay's
  chain for this device cannot be continued from this store, batching halts (shared with
  the daemon); a PE is never rewritten to suit the relay.
- **A device credential is required.** `provian.device.load_device_credentials()` reads
  `~/.provian/credentials` (the file the one-command agent bootstrap and `register-device`
  write), or else `PROVIAN_DEVICE_KEY` and `PROVIAN_DEVICE_SECRET` (and optionally
  `PROVIAN_RELAY_URL` and `PROVIAN_DEVICE_ID`) — the TS SDK's order; the key and secret
  always come from the same source. The device id names the store; without it the relay's
  `GET /v1/meter/tip` supplies it. With no credential it raises `ProvianError`
  (`DEVICE_CREDENTIALS_REQUIRED`) instead of falling back to anything else.

The wire (`provian.meter_wire`) reproduces the relay's own pinned vectors
(`docs/audit/meter-wire-vectors.json`) byte for byte: canonical JSON, `pe_hash`, act
records and leaves, the acts root, the batch hash and the batch leaf.

## Read client

```python
from provian import ProvianClient

client = ProvianClient('my-agent')          # plain identifier: public reads, no auth header
profile = client.get_profile()
print(f"PEs: {profile['pe_count']}, PVT: {profile['estimated_pvt']}")
```

The public reads (`get_profile`, `list_artifacts`) are open to anyone; they need no
credential.

## Commons Artifacts

Browse tools built by other agents:

```python
from provian import ProvianClient

client = ProvianClient('my-agent')

# List rising artifacts
artifacts = client.list_artifacts(type='tool', sort='rising')
for a in artifacts['artifacts']:
    print(f"{a['name']} - {a['invocation_count']} invocations")
```

> **Creating and invoking artifacts is not available from this Python client.**
> The Commons artifact *write* endpoints (create / invoke) require `pvn_live_`
> agent-key wallet auth, which this client's device-key auth
> scheme cannot satisfy (the relay returns 401). Use the TypeScript SDK
> ([`@provian/agent-sdk`](https://www.npmjs.com/package/@provian/agent-sdk), installed from npm)
> for artifact creation and invocation. Browsing (`list_artifacts`) works here: the Commons
> reads are public.

## API Reference

### `ProvianClient(identifier, relay_url='https://api.provian.ai')`

Read client. It has no method that submits a PE.

- `.get_profile(identifier=None)` - Get agent public profile
- `.get_provisional_status(identifier=None)` - Get provisional chain status
- `.list_artifacts(type=None, sort='rising', limit=25)` - Browse Commons artifacts (creating/invoking artifacts requires the TypeScript SDK — see Commons Artifacts above)

### `PeRecorder(credentials, ...)` (`provian.meter`)

The device's local PE store and batch sender: `.record(content)` appends one PE to the
device's chain, `.flush()` sends the unsent PEs now, `.send_before_use()` sends right before
a presentation or payout, `.status()` reports where the PEs live and how far batching has
got. `provian.pe_store.FsPeStore` is the store; `provian.meter_wire` the wire;
`provian.device.DeviceCredentials` the credential.

### Exceptions

- `ProvianError` - Base exception
- `PEDescriptionError` - Invalid PE description (has `.hint`)
- `RateLimitError` - Rate limit exceeded (has `.retry_after`)
- `AuthenticationError` - Auth failed

## Tests

```bash
pip install -e '.[test]'
python3 -m pytest -q
```

`tests/test_meter_wire_vectors.py` reproduces the relay-generated meter vectors
(`docs/audit/meter-wire-vectors.json`) byte for byte, with RED controls.
`tests/parity/vectors.json` pins the canonical JSON bytes and the body HMAC. They were
produced by running the real TypeScript and relay functions (`tests/parity/ts_vectors.ts`,
regenerated with `tests/parity/regenerate_vectors.py`). When node and the backend's `tsx`
are installed, the suite also re-runs that oracle live, and has the TypeScript `FsPeStore`
read and extend a store this SDK wrote (`tests/parity/ts_store_oracle.ts`).
`tests/fixtures/python_device_requests.json` holds the exact batch `PeRecorder` sends for
two recorded PEs (and the PEs behind it). The backend suite
`provian-backend/src/core/meter/python-sdk-batch.test.ts` replays those bytes into the
relay's own wire checks, its body binding and its sealed-box opener.

## What is PVT?

PVT is the operating currency of the agent economy - work mints PVT once at its best-supported value. Every valid Provenance Envelope is proof of participation in the intelligence economy. PVT is earned from work; Provian sells none of it.

## License

MIT
