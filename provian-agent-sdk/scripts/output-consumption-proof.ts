/**
 * Live proof — signed-output consumption : one agent cites another agent's SIGNED
 * output, the producer's consumption count rises, and the producer then presents with a consumption
 * predicate that verifies.
 *
 * Producer leg (the machine holding the producer agent's keystore + API credentials):
 * tsx output-consumption-proof.ts read --creds <agent-credentials.json>
 * tsx output-consumption-proof.ts sign --keystore <keystore.json> --out <signed.json> [--text "…"]
 * tsx output-consumption-proof.ts serve --signed <signed.json> [--port 8787]
 * tsx output-consumption-proof.ts present --keystore <keystore.json> --creds <agent-credentials.json>
 * --min-edges <N> [--rpc-url <base rpc>]
 * Consumer leg (the consumer agent's REGISTERED device, whose observer daemon runs this build):
 * tsx output-consumption-proof.ts cite --url http://<producer host>:8787/output [--wait-seconds 900]
 * tsx output-consumption-proof.ts flush
 *
 * The keystore passphrase is read from PROVIAN_KEYSTORE_PASSPHRASE (never an argument). Nothing here
 * declares work: `cite` only RECEIVES the signed output through the SDK's capture wrapper, which
 * queues the citation for this device; the citation rides the next PE the device's observer records
 * from real work (a harness turn), witnessed by that device. `flush` sends the device's batch now
 * (the same cross-process-locked send `provian pes flush` uses).
 *
 * `present` BURNS the reputation-tier floor (15 PVT at launch) from the producer's own wallet — the
 * protocol's price of a presentation. It answers a self-issued challenge naming the predicate
 * `consumption.edges gte <N>` and checks the result twice: offline against the relay's JWKS (SDK)
 * and through the relay's public POST /v1/present/verify.
 */

import * as fs from 'fs';
import * as http from 'http';
import { randomBytes } from 'crypto';
import { ProvianClient } from '../src/ProvianClient';
import { loadCredentials } from '../src/scripts/credentials';
import { loadAgentCredentialsFile } from '../src/scripts/agent-credentials-file';
import { loadKeystore, withDecryptedKey } from '../src/keystore';
import { CommonsInstitutions } from '../src/commons-institutions';
import { FsPeStore, defaultPeStoreRoot } from '../src/meter/pe-store';
import { PENDING_OUTPUT_CITATIONS_FILE } from '../src/meter/output-citations';
import {
  encodeOutputSignatureHeader,
  outputCitationIdentifier,
  OUTPUT_SIGNATURE_HEADER,
  type OutputSignature,
} from '../src/output-signature';
import { outputSignatureMatches, signOutputWithWalletKey, walletOutputSignatureRecovers } from '../src/output-signing';

const RELAY = (process.env.PROVIAN_RELAY_URL ?? 'https://api.provian.ai').replace(/\/+$/, '');
const DEFAULT_RPC = process.env.PROVIAN_BASE_RPC_URL ?? 'https://mainnet.base.org';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
}
function passphrase(): string {
  const p = process.env.PROVIAN_KEYSTORE_PASSPHRASE;
  if (!p) throw new Error('set PROVIAN_KEYSTORE_PASSPHRASE (the producer keystore passphrase)');
  return p;
}

interface SignedFile { readonly output: string; readonly signature: OutputSignature; readonly header: string }

function institutions(credsPath: string): CommonsInstitutions {
  const creds = loadAgentCredentialsFile(credsPath);
  if (!creds?.api_key || !creds.api_secret || !creds.wallet_id) throw new Error(`${credsPath} does not hold api_key / api_secret / wallet_id`);
  return new CommonsInstitutions({ relayUrl: RELAY, walletId: creds.wallet_id, apiKey: creds.api_key, apiSecret: creds.api_secret });
}

function consumptionOf(facts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(facts).filter(([k]) => k.startsWith('consumption.')));
}

async function read(): Promise<void> {
  const v = await institutions(need('creds')).readVocabulary();
  console.log(JSON.stringify(consumptionOf(v.facts), null, 2));
}

async function sign(): Promise<void> {
  const keystore = loadKeystore(need('keystore'));
  if (!keystore) throw new Error('keystore unreadable');
  const output = arg('text') ?? `Provian signed-output proof ${new Date().toISOString()} ${randomBytes(8).toString('hex')}\n`;
  const signature = await withDecryptedKey(keystore, passphrase(), (key) => signOutputWithWalletKey(key.privateKey, output));
  if (!walletOutputSignatureRecovers(signature)) throw new Error('signature does not recover to its signer');
  const file: SignedFile = { output, signature, header: encodeOutputSignatureHeader(signature) };
  fs.writeFileSync(need('out'), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o644 });
  console.log(`signed by ${signature.signer.id} (citation ${outputCitationIdentifier(signature.signer)})`);
  console.log(`hash ${signature.hash}`);
}

async function serve(): Promise<void> {
  const file = JSON.parse(fs.readFileSync(need('signed'), 'utf8')) as SignedFile;
  const port = Number(arg('port') ?? '8787');
  http.createServer((req, res) => {
    if (req.url !== '/output') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', [OUTPUT_SIGNATURE_HEADER]: file.header });
    res.end(file.output);
    console.log(`served the signed output to ${req.socket.remoteAddress}`);
  }).listen(port, () => console.log(`serving GET /output on :${port} (signer ${file.signature.signer.id})`));
}

function deviceClient(): { client: ProvianClient; deviceId: string } {
  const creds = loadCredentials();
  if (!creds) throw new Error('no device credentials on this machine (run on the consumer agent\'s registered device)');
  if (!creds.deviceId) throw new Error('device credentials carry no PROVIAN_DEVICE_ID');
  return {
    client: new ProvianClient({
      relayUrl: creds.relayUrl, deviceKey: creds.deviceKey, deviceSecret: creds.deviceSecret,
      deviceId: creds.deviceId, signingMethod: creds.signingMethod, signingKeyAlias: creds.signingKeyAlias,
    }),
    deviceId: creds.deviceId,
  };
}

async function cite(): Promise<void> {
  const { client, deviceId } = deviceClient();
  const store = new FsPeStore(deviceId, defaultPeStoreRoot());
  const before = (await store.head())?.count ?? 0;
  const res = await client.wrapFetchWithOutputCitations(fetch)(need('url'));
  const body = await res.text();
  const header = res.headers.get(OUTPUT_SIGNATURE_HEADER);
  const queue = `${store.location}/${PENDING_OUTPUT_CITATIONS_FILE}`;
  const queued = fs.existsSync(queue) ? fs.readFileSync(queue, 'utf8') : '';
  console.log(`received ${body.length} bytes, header ${header ? 'present' : 'ABSENT'}; queued for this device: ${queued.includes('"hash"') ? 'yes' : 'NO'}`);
  if (!queued.includes('"hash"')) throw new Error('the citation was not queued (no header, or the signature does not name the bytes received)');
  const waitMs = Number(arg('wait-seconds') ?? '900') * 1000;
  console.log('now do real work in this agent\'s harness (one turn); waiting for the observer to record its next PE…');
  const deadline = Date.now() + waitMs;
  for (;;) {
    const count = (await store.head())?.count ?? 0;
    if (count > before) {
      const rows = await store.readPes(before, count - before);
      const carrying = rows.find((r) => JSON.stringify((r.pe as { input_origins?: unknown }).input_origins ?? []).includes('"out:'));
      if (carrying) {
        console.log(`PE #${carrying.index} (${(carrying.pe as { action_type?: string }).action_type}) carries the out: citation; run "flush" to send it now`);
        return;
      }
    }
    if (Date.now() > deadline) throw new Error('no new PE carried the citation before the deadline (is the observer daemon running this build?)');
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function flush(): Promise<void> {
  const { client } = deviceClient();
  const report = await (await client.createMeterBatcher()).flushBeforeUse();
  console.log(JSON.stringify(report, null, 2));
}

async function present(): Promise<void> {
  const inst = institutions(need('creds'));
  const minEdges = Number(need('min-edges'));
  if (!Number.isInteger(minEdges) || minEdges < 1) throw new Error('--min-edges must be a positive integer');
  const keystore = loadKeystore(need('keystore'));
  if (!keystore) throw new Error('keystore unreadable');
  const predicates = [{ field: 'consumption.edges', op: 'gte' as const, threshold: minEdges }];
  const envelope = { audience: 'proof:signed-output-consumption', challenge: randomBytes(16).toString('hex'), predicates };
  const presented = await withDecryptedKey(keystore, passphrase(), (key) =>
    inst.respondToChallenge(envelope, { privateKeyHex: key.privateKey, rpcUrl: arg('rpc-url') ?? DEFAULT_RPC, tier: 'reputation' }));
  console.log(`presented: burn ${presented.txHash} (${presented.burnAmountAtomic} atomic PVT), tier ${presented.tier}`);
  const offline = await inst.verifyPresentation(presented.token, {
    expectedAudience: envelope.audience, expectedChallenge: envelope.challenge, expectedPredicates: predicates, acceptOnce: false,
  });
  console.log('SDK verify:', JSON.stringify(offline, null, 2));
  const relay = await fetch(`${RELAY}/v1/present/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: presented.token, audience: envelope.audience, challenge: envelope.challenge, predicates }),
  });
  const relayBody = await relay.json() as { valid?: boolean; predicates?: { field: string; op: string; threshold?: number; result: boolean }[] };
  console.log(`relay verify: ${relay.status}`, JSON.stringify(relayBody, null, 2));
  // The verdict, last, so it is the line a reader sees: a VALID presentation can still answer its
  // predicate false, so both verifiers must accept it AND the co-signed answer must be true.
  const answer = relayBody.predicates?.find((p) => p.field === 'consumption.edges' && p.op === 'gte' && p.threshold === minEdges);
  const ok = offline.valid === true && relay.status === 200 && relayBody.valid === true && answer?.result === true;
  console.log(`consumption.edges gte ${minEdges}: ${answer ? String(answer.result) : 'unanswered'} | SDK valid ${String(offline.valid)} | relay valid ${String(relayBody.valid)}`);
  console.log(ok ? 'PROOF OK: the producer presented its consumption and it verified' : 'PROOF FAILED');
  if (!ok) process.exit(1);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const table: Record<string, () => Promise<void>> = { read, sign, serve, cite, flush, present };
  const fn = cmd ? table[cmd] : undefined;
  if (!fn) throw new Error(`usage: output-consumption-proof.ts <${Object.keys(table).join('|')}> …`);
  await fn();
}

// Exported for the script's own self-check (a signed file must name its output).
export function signedFileIsConsistent(file: SignedFile): boolean {
  return outputSignatureMatches(file.signature, file.output) && walletOutputSignatureRecovers(file.signature);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
