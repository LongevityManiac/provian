# Sensor gateway — an observer with a plugin for a sensor

A kiln controller, a soil probe or a lab instrument drops one JSON reading per file into a
directory on a registered machine. This example is an SDK observer on that machine with a plugin
for the sensor: `run.ts` starts `ProvianObserver` from `@provian/agent-sdk/observer` and adds
`SensorGatewayPlugin` (`sensor-gateway-plugin.ts`) with `registerPlugin`. Each reading becomes
one PE, of the reading's own `action_type`, in this machine's PE store, and rides the machine's
daily signed batch to the relay.

**PEs prove provenance.** A PE exists only when something other than the actor vouches for it.
The sensor's own say-so is not a witness; here the witness is the registered machine's observer.
The observer — never the plugin — stamps each reading `metadata.source: "observer_plugin"` and
`metadata.observer_plugin: "sensor-gateway"`, overwriting anything the plugin set there, and the
relay admits a new type on the device batch only with that marker. A plugin cannot carry a
built-in lane's marker: the observer refuses a `link_spend` or `agent_tool_orchestration` from a
plugin, and so does the relay.

## How a sensor connects

A sensor's work reaches the network through one of two paths:

1. **A hardware-attested device submits on the sovereign lane.** `POST /v1/pe/submit-sovereign`
   (SDK `submitHardwareWitnessedWork`) records an occurrence signed by a registered, active agent
   wallet's own key (one EIP-191 signature over the canonical `provian_sovereign_work_v1` message)
   that also carries a `hardware_witness`: a report from a supported scheme (`tpm2_quote`,
   `apple_app_attest`, `aws_nitro`, `gcp_confidential_space`, `azure_attestation`, `nvidia_cc`)
   that a key other than the agent's signed over the hash of that exact body, verified to the
   scheme's pinned public root. The signature alone is refused
   (`403 actor_declared_work_is_not_a_pe`).
2. **A sensor reports through a registered machine whose owner runs an SDK observer with a plugin
   for it.** That is this example.

The daemon the one-command setup installs (`curl … /v1/bootstrap/agent | sh`,
`npx @provian/agent-sdk onboard`, or `register-device`) witnesses the machine's own work — commits,
compute, inference, agent tool calls — through its built-in lanes. It loads no sensor plugin. To
witness a sensor on that machine, run this observer beside the daemon.

Three more witnesses reach a sensor's work with no observer plugin and no daemon: a payment for its
readings (Provian's chain watchers read the payment's on-chain settlement on Base; the owner's
`receive` mints only from a counterparty the owner has dealt with — an earlier send or x402 payment
to the payer, a shared escrow or a shared job — and a first payment from a stranger records without
minting), a counterparty's witnessed PE citing an output the machine signed
(`Provian-Output-Signature`; it counts toward the owner's Consumption and pays nothing), and a
hardware root on the sensor itself, which reaches the relay through the sovereign lane (path 1).

## Run it

```bash
# once: register this machine (writes ~/.provian/credentials.json)
npx @provian/agent-sdk register-device

# then: watch a directory for sensor readings
PROVIAN_SENSOR_DIR=/var/lib/sensors npx tsx run.ts

# drop a reading:
echo '{"action_type":"kiln_cycle_completed","reading_id":"kiln-3/2026-10-22T12:00:00Z"}' \
  > /var/lib/sensors/kiln-3-001.json
```

Run `run.ts` from a directory where `@provian/agent-sdk` resolves. Without
`PROVIAN_SENSOR_DIR` it watches `~/.provian/sensor-readings`.

Who sends the batch:

- **With the observer daemon also running on this machine** (`npx @provian/agent-sdk start`),
  its batcher sends the readings' PEs. Leave `PROVIAN_SENSOR_BATCH` unset.
- **On a machine with no daemon**, set `PROVIAN_SENSOR_BATCH=1` so this process runs the batcher
  itself.

`SIGINT` / `SIGTERM` stop the observer cleanly: it records the plugin's last readings and waits for
every file move to finish, so nothing is stranded.

## The reading file

One reading per `*.json` file:

```json
{ "action_type": "kiln_cycle_completed",
  "reading_id": "kiln-3/2026-10-22T12:00:00Z",
  "observed_at": 1792675200000 }
```

- `action_type` — the type of work: a flat identifier or a lowercase `namespace:name`.
- `reading_id` — unique per reading; it is the only field copied into the PE's metadata.
- `observed_at` — optional, epoch ms the sensor observed it.
- Any other fields are hashed into the reading's digest and never sent.

One reading, one PE: the PE carries the sha256 of the file's bytes in `output_digests` and is
recorded under the idempotency key `sensor_<digest>`, so the same bytes seen again (a restart, a
rescan, a failed move) are answered with the PE already recorded. A recorded reading moves to
`processed/<name>.<digest>.json`; a file that is not a valid reading (bad JSON, a bad
`action_type` or `reading_id`, a relay-owned `service:` or `git_` type) moves to
`rejected/<name>.<digest>.json`. Nothing is overwritten.

## What the relay does with a never-seen type

A type the network has never seen, such as `kiln_cycle_completed`:

- is **recorded with no mint**, at device tier;
- **enters review**: it is filed in the pending-policy queue under the device gateway lane and
  appears on the public proposals dashboard (`GET /v1/pe/earning-proposals`,
  [provian.ai/proposals](https://provian.ai/proposals));
- **earns from the day its row is signed and the type is granted for this lane** — once per
  witnessed reading, from that row's effective time forward. Readings recorded earlier stay
  records; nothing is repriced. Submitters are notified when the type earns.

A named type (`send`, `escrow_completed`, …) is refused on this path — its witness is someone
else's — and so is any type in a namespace the relay owns (`service:`, `git_`).

See also: [External Device Integration Guide](../../docs/EXTERNAL_DEVICE_INTEGRATION.md),
Section 11b.
