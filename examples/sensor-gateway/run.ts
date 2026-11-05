/**
 * Run the sensor gateway on a REGISTERED machine (new-type intake,).
 *
 * # once: register this machine (writes ~/.provian/credentials.json)
 * npx @provian/agent-sdk register-device
 *
 * # then: watch a directory for sensor readings
 * PROVIAN_SENSOR_DIR=/var/lib/sensors npx tsx run.ts
 *
 * # drop a reading:
 * echo '{"action_type" "kiln_cycle_completed","reading_id" "kiln-3/2026-10-22T12:00:00Z"}' \
 * > /var/lib/sensors/kiln-3-001.json
 *
 * The plugin is registered with the observer through its public API (`registerPlugin`). Each
 * reading becomes a PE in this machine's own PE store, stamped by the observer as the
 * `sensor-gateway` plugin's observation. The PEs ride the machine's daily signed batch to the
 * relay: with the observer daemon also running on this machine (`npx @provian/agent-sdk start`),
 * its batcher sends them — leave PROVIAN_SENSOR_BATCH unset; on a machine with no daemon, set
 * PROVIAN_SENSOR_BATCH=1 so this process runs the batcher itself.
 *
 * What the relay does with them: a never-seen type is RECORDED with no mint and queued for review
 * (it appears on GET /v1/pe/earning-proposals); once the operator signs a matrix row for it, readings
 * from the row's activation forward earn, once each. Nothing recorded earlier is repriced.
 */
import path from 'path';
import os from 'os';
import { loadCredentials } from '@provian/agent-sdk';
import { ProvianObserver } from '@provian/agent-sdk/observer';
import { SensorGatewayPlugin } from './sensor-gateway-plugin';

async function main(): Promise<void> {
  const credentials = loadCredentials();
  if (!credentials) {
    throw new Error('This machine is not registered: run `npx @provian/agent-sdk register-device` first.');
  }
  const dir = process.env.PROVIAN_SENSOR_DIR ?? path.join(os.homedir(), '.provian', 'sensor-readings');
  const observer = new ProvianObserver({
    idleThresholdMs: 30_000,
    maxSessionMs: 15 * 60_000,
    tickIntervalMs: 5_000,
    plugins: [],
    relayUrl: credentials.relayUrl,
    credentials,
    logLevel: 'info',
    meterBatching: process.env.PROVIAN_SENSOR_BATCH === '1',
  });
  observer.registerPlugin(new SensorGatewayPlugin(dir, (msg) => console.warn(msg)));
  await observer.start();
  console.log(`sensor-gateway: watching ${dir}`);

  // `stop()` drains the plugin, records its last readings, and then awaits the plugin's
  // `finalize()`, which waits for every move into processed/ — so exiting after it strands nothing.
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await observer.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
