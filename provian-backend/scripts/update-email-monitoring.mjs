#!/usr/bin/env node
// Read-only plan by default. --execute patches ONLY documentation, channels and
// OPENED delivery for the two keeper policies; the mint policy gets copy only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const project = 'provian-ai';
const config = JSON.parse(readFileSync(new URL('../../config/pvt9-base.json', import.meta.url)));
const kernel = config.assets.pvt9.address;
const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function api(path, body, mask) {
  const response = await fetch(`https://monitoring.googleapis.com/v3/${path}${mask ? `?updateMask=${mask}` : ''}`, {
    method: body ? 'PATCH' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Monitoring HTTP ${response.status}`);
  return response.json();
}
const channelList = await api(`projects/${project}/notificationChannels`);
const channel = channelList.notificationChannels.filter(c => c.type === 'email' && c.enabled !== false
  && c.verificationStatus === 'VERIFIED' && c.labels?.email_address === 'optimist@provian.ai'
  && c.displayName.includes('primary on-call'));
if (channel.length !== 1) throw new Error('Exactly one verified primary on-call channel is required');
const policies = (await api(`projects/${project}/alertPolicies`)).alertPolicies;
const keeperProcedure = `Current production PVT9 kernel on Base: ${kernel} (successor; Fixed epoch caps from epoch 1 under).\n\nInspect ops.provian.ai/chain: epoch lag, cap clock, administrative hold, operator gas and RPC agreement. Inspect the keeper response/logs for stopReason and refusal; resolve that cause first. The epoch clock is timed: never try to open an epoch before its boundary, change dates/caps, or bypass holds.\n\nRe-run the existing idempotent keeper through Cloud Scheduler:\n\n gcloud scheduler jobs run provian-pvt9-epoch-keeper --project=provian-ai --location=us-central1\n\nIt calls POST /v1/internal/scheduler/pvt9-epoch-keeper with Scheduler authentication, evaluates the current chain clock and gates, and opens only due epochs. Read the returned outcome, lag, capClock and stillOwed plus Base receipts to confirm recovery. No manual mint or abandoned-kernel command. The normal cadence is every 20 minutes.`;
const specs = [
  { match: p => p.displayName.startsWith('PVT9 epoch keeper') && p.displayName.includes('ERROR line'), keeper: true,
    text: `The PVT9 epoch keeper logged ERROR: epoch lag, cap clock, REFUSED or FAILED.\n\n${keeperProcedure}` },
  { match: p => p.displayName.startsWith('PVT9 epoch keeper') && p.displayName.includes('NOT RUNNING'), keeper: true,
    text: `The PVT9 epoch keeper has no successful run for one hour. Check Scheduler enablement, OIDC authentication, Cloud Run availability and keeper logs.\n\n${keeperProcedure}` },
  { match: p => p.displayName.includes('PVT mint failure'), keeper: false,
    text: `The relay logged an ERROR tagged [PVT Mint]. Current production PVT9 kernel on Base: ${kernel}. This prefix can also originate in held-act beneficiary recovery or durable claim validation; it is not a PVTv8 mintFromPEs or anchorBatch failure.\n\nInspect the exact log, ops.provian.ai/pvt and /pes, pending/held metered acts and beneficiary bindings, system_status/monetary_activation, reconciliation report binding, operator gas/RPC health and PVT9 settlement-cycle receipts. Preserve sealed values and mint-once claim identities; never rewrite a sealed PE or mint backlog manually.\n\nStandard work settles through /v1/internal/settlement/pvt9-run (daily Scheduler with an operator-set interval per payee, currently 30 days); Genesis has its daily /v1/internal/settlement/pvt9-genesis-run. The dedicated settlement-stopped alert covers a stopped PVT9 run. Resolve the reported cause and use the existing gated operator/Scheduler procedure; the kernel enforces mint-once and the live Fixed epoch caps.` },
];
for (const spec of specs) {
  const matches = policies.filter(spec.match);
  if (matches.length !== 1) throw new Error('Expected exactly one policy per template');
  const p = matches[0];
  const patch = { name: p.name, documentation: { content: spec.text, mimeType: 'text/markdown' } };
  let mask = 'documentation';
  if (spec.keeper) {
    patch.notificationChannels = [channel[0].name];
    patch.alertStrategy = { ...p.alertStrategy, notificationPrompts: ['OPENED'] };
    mask += ',notificationChannels,alertStrategy';
  }
  if (process.argv.includes('--execute')) {
    await api(p.name, patch, mask);
    const live = await api(p.name);
    if (live.documentation?.content !== spec.text || (spec.keeper &&
      (JSON.stringify(live.notificationChannels) !== JSON.stringify(patch.notificationChannels)
      || JSON.stringify(live.alertStrategy.notificationPrompts) !== '["OPENED"]'))) throw new Error('Readback mismatch');
    console.log(`Updated and verified: ${p.displayName}`);
  } else console.log(JSON.stringify({ policy: p.displayName, updateMask: mask, patch }, null, 2));
}
