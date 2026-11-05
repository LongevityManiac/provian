/**
 * Build-a-PE via the SDK (Trust Layer §2.11). End-to-end on the TEST PATH: read the
 * actor's own vocabulary,
 * ask the linked human to approve a described action, and (presenter side) respond
 * to a challenge with a burn-backed token.
 *
 *   RELAY_URL=… WALLET_ID=wallet_aw_… AGENT_API_KEY=pvn_live_… AGENT_API_SECRET=pvns_… \
 *   AGENT_PRIVATE_KEY=<hex> RPC_URL=<base rpc> npx tsx via-sdk.ts
 *
 * Step 1 only checks this machine is registered (the observer daemon records its
 * work — there is no call that records an agent's own claim). Steps 2–4
 * use the agent API key.
 *
 * All identities used here are platform:'test' and are purged before settlement.
 */
import { CommonsInstitutions, humanApprovalOrigin, loadCredentials } from '@provian/agent-sdk';

const relayUrl = process.env.RELAY_URL ?? 'https://api.provian.ai';
const walletId = process.env.WALLET_ID ?? '';
const apiKey = process.env.AGENT_API_KEY ?? '';
const apiSecret = process.env.AGENT_API_SECRET ?? '';

async function main(): Promise<void> {
  if (!walletId || !apiKey || !apiSecret) throw new Error('WALLET_ID, AGENT_API_KEY, AGENT_API_SECRET are required');
  const bank = new CommonsInstitutions({ relayUrl, walletId, apiKey, apiSecret });

  // 1) There is no call that records your own work as a PE — an actor's
  //    own claim about its work is never a PE. On a registered machine the
  //    observer daemon (`npx @provian/agent-sdk start`) records what it observes,
  //    body-bound to the device; the post-commit hook, the forge, counterparties
  //    and the chain are the other witnesses. A work-product PE carries
  //    output_digests and cites what it consumed as `pe:` input origins.
  if (!loadCredentials()) {
    console.log('[observer] register this machine first: npx @provian/agent-sdk register-device');
  }

  // 2) Read the actor's own live reputation vocabulary.
  const vocab = await bank.readVocabulary();
  console.log(`[vocabulary] ${Object.keys(vocab.facts).length} facts; standing.adverse_events=${vocab.facts['standing.adverse_events']}`);

  // 3) Ask the linked human to approve a described action; then cite the approval PE.
  try {
    const req = await bank.requestHumanApproval({ actionDescription: 'Example: publish the release notes' });
    console.log(`[request_human_approval] request_id=${req.request_id} anchor=${req.action_description_sha256}`);
    const satisfied = (await bank.listApprovalRequests('satisfied')).find((r) => r.request_id === req.request_id);
    if (satisfied?.satisfied_by_pe_id) {
      const origin = humanApprovalOrigin(satisfied.satisfied_by_pe_id);
      console.log('[cite approval] next PE input_origins:', JSON.stringify(origin));
    } else {
      console.log('[request_human_approval] pending — the human approves in the app, then poll listApprovalRequests("satisfied")');
    }
  } catch (e) {
    console.log('[request_human_approval] skipped (needs a linked human):', (e as Error).message);
  }

  // 4) Presenter: respond to a requester's challenge in ONE call (verify the challenge → burn → present → token).
  const challenge = process.env.CHALLENGE_PAYLOAD;
  const pk = process.env.AGENT_PRIVATE_KEY;
  const rpc = process.env.RPC_URL;
  if (challenge && pk && rpc) {
    const out = await bank.respondToChallenge(challenge, { privateKeyHex: pk, rpcUrl: rpc });
    console.log(`[respondToChallenge] tier=${out.tier} burned=${out.burnAmountAtomic} token=${out.token.slice(0, 24)}…`);
  } else {
    console.log('[respondToChallenge] set CHALLENGE_PAYLOAD + AGENT_PRIVATE_KEY + RPC_URL to produce a real token');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
