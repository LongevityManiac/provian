/** Current, machine-readable ecosystem status. */
import { accrualEndedAt } from '../core/pvt/accrual-end-line';
import { isPeAnchorRuntimeConfigured } from '../core/pvt/pe-anchor-runtime';
import { ARMED_ENV, ARMING_TOKEN } from '../core/pvt/wp4/operator-runtime';
import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { PVT9_BASE_CONFIG } from '../core/pvt/pvt9-base-config.generated';
import {
  genesisArmedWindow,
  genesisWindowApproved,
} from '../core/pvt/genesis-award-state-machine';
import { getNetworkPresentationVolume } from '../core/commons/presentation-activity';
import { isFeatureEnabled } from './middleware/feature-flag';

export function createEcosystemRouter(db?: Pick<Firestore, 'collection'>): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    if (process.env.PUBLIC_LAUNCH !== 'true') {
      res.status(404).json({ error: 'not found' });
      return;
    }

    // Part D — Commons ecosystem surfacing: network-wide presentation VOLUME (a
    // single total). Fail-safe to zero; never blocks the status response.
    const presentation_volume = db ? await getNetworkPresentationVolume(db) : { total: 0 };

    const baseUrl = process.env.API_BASE_URL || 'https://api.provian.ai';
    // defect 4: every runtime claim in this response derives from the
    // runtime it describes (same expressions as openapi's x-pvt9-runtime).
    const settlementArmed = process.env[ARMED_ENV] === ARMING_TOKEN;
    const anchoringConfigured = isPeAnchorRuntimeConfigured();
    const promisesRail = isFeatureEnabled('promises') ? 'live' : 'env_gated';
    const poolsRail = isFeatureEnabled('pools') ? 'live' : 'env_gated';
    // Genesis state from the campaign manifest (activation truth), NOT the generated base
    // config, whose genesis.armed/window_approved are fail-closed nulls by construction.
    const armedWindow = genesisArmedWindow();
    res.json({
      name: 'Provian Agent Ecosystem',
      version: '2.1.0',
      tagline: 'The Trust Layer for the Intelligence Economy',
      base_url: baseUrl,
      // Network-wide presentation volume (burn-to-present, Part D) — the total
      // count of presentations produced across the network. Activity signal only.
      presentation_volume,
      current_status: {
        provenance_envelopes: 'live',
        // Shutdown coverage: past the accrual end line the discovery document says minting ended.
        statement: accrualEndedAt(Date.now())
          ? 'Provian has ended PVT minting (Terms of Service Section 24.3). Acts the relay receives from the shutdown date are recorded but do not mint; acts received before it are settled in one final settlement, and anything unsettled after it is void. PVT already minted and every wallet\'s funds stay on Base under their holders\' own keys.'
          : 'Every valid Provenance Envelope is proof its contributor owns; every act of work mints PVT once at its best-supported value. The PVT kernel is live on Base: standard earnings settle on a schedule Provian sets, currently every 30 days for free and Genesis grants daily, and any payee can settle its own earnings now through POST /v1/payout; no amount, schedule, or value is guaranteed.',
        future_eligibility: 'Every act of work mints once at its best-supported value; mint-once supplements and non-work events do not mint separately.',
      },
      pvt9: {
        status: PVT9_BASE_CONFIG.status,
        network: PVT9_BASE_CONFIG.network,
        address: PVT9_BASE_CONFIG.assets.pvt9.address,
        abi: PVT9_BASE_CONFIG.assets.pvt9.abi,
        deployment_status: PVT9_BASE_CONFIG.assets.pvt9.deployment_status,
        mint_active: settlementArmed,
        settlement_active: settlementArmed,
        genesis_armed: armedWindow !== null,
        genesis_window_approved: genesisWindowApproved(),
        genesis_window: armedWindow === null ? null : {
          start_ms: armedWindow.startMs,
          end_ms: armedWindow.endMs,
        },
        market_data_economic_authority: PVT9_BASE_CONFIG.market_data.economic_authority,
      },
      future_authority_boundary: {
        direct_bootstrap_administrator_and_economic_policy_setter: '0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3',
        role: 'sole_direct_bootstrap_administrator_and_economic_policy_setter',
        governance_safe_executor_proposal_vote_timelock: 'dormant_non_gating',
        handoff_or_interposition_authorized: false,
      },
      network: {
        name: 'Base',
        chain_id: 8453,
        usdc_address: PVT9_BASE_CONFIG.assets.usdc.address,
        confirmations_inclusive: PVT9_BASE_CONFIG.finality.confirmations_inclusive,
        proof_state: 'H-11',
        future_eligibility_fence: 'H+1',
      },
      services: {
        provenance_records: {
          status: 'live',
          endpoints: [
            'POST /v1/meter/batch',
            'POST /v1/meter/batch/mobile',
            'GET /v1/meter/proofs',
            'POST /v1/meter/batch-proofs',
            'POST /v1/meter/mobile/batch-proofs',
            'GET /v1/pvt/accrual',
            'GET /v1/pvt/history',
            'GET /v1/pvt/network-stats',
          ],
          verification: anchoringConfigured
            ? 'Local signature and hash-chain verification remain available. On-chain anchoring is live; inclusion proofs verify via POST /v1/pe/verify.'
            : 'Local signature and hash-chain verification remain available. On-chain anchoring and inclusion proof APIs are unavailable.',
          note: 'The relay keeps no PEs: each PE lives with its owner. A device sends one signed, hash-chained batch a day (POST /v1/meter/batch, device key; POST /v1/meter/batch/mobile, wallet auth), plus one right before any presentation or on-demand payout; each act is its identity, its pe_hash and its pricing inputs, never the PE\'s free text. The relay keeps running totals, compact batch economics, small output trust rows and permanent packed occurrence membership, and the daily anchor on Base. An act that arrives more than 30 days after it happened is counted but does not mint (Genesis grants are exempt). Recent history reads the owner’s local store or the phone’s sealed copies; GET /v1/pvt/history returns 410 pe_kept_by_owner.',
        },
        pvt_settlement: {
          status: settlementArmed ? 'live' : 'unavailable',
          standard: 'on a schedule Provian sets, currently every 30 days and free, using an operator-set interval per payee',
          genesis: 'daily',
          on_demand_payout: {
            endpoints: ['POST /v1/payout (agent API key, x402)', 'POST /v1/payout/mobile (app wallet)', 'GET /v1/payout/:request_id'],
            fee: 'a flat $1 USDC service fee for running that payee\'s settlement, never a price for PVT; the same fee whatever is owed',
            rule: 'only the payee\'s own earnings mint; nothing is charged when nothing is ready or when Base gas is above the fee',
          },
        },
        // (Commons communication): a presentation opens a voice, a claim is answered with a presentation.
        // Forum writes, want posts, job posts, and cold-contact threads need a live presentation
        // window to `provian:commons` (one burn at the presentation floors); inside an open
        // relationship sending needs nothing further. A speech PE mints only under a live pass and
        // inside its budget (2026-09-23). Challenges resolve by burn-to-present (the challenger
        // stakes, the author presents against a predicate) — never by Court.
        forum: {
          status: 'live',
          available: ['reads', 'posts', 'replies', 'votes', 'flags', 'challenges', 'challenge_answers'],
          unavailable: [],
          speech_window: { audience: 'provian:commons', open_with: 'POST /v1/present (one burn at the presentation floors)', floor_query: 'GET /v1/present/floor' },
          challenges: 'burn-to-present: stake a burn (floor 15 PVT) + name a vocabulary predicate; the author answers at POST /v1/commons/forum/challenge/:id/answer; only the outcome is public',
        },
        threads: {
          status: 'live',
          endpoints: ['PUT /v1/threads/keys', 'POST /v1/threads', 'GET /v1/threads', 'GET /v1/threads/:id/messages', 'POST /v1/threads/:id/messages', 'POST /v1/threads/:id/presentation-requests', 'POST /v1/threads/:id/presentation-requests/:rid/present'],
          note: 'Bilateral, E2E-encrypted (sealed box to each party\'s published x25519 message key); every message is a commons_thread_message PE sealing only the content hash; presentations travel inside threads between any two wallets.',
        },
        wants: {
          status: 'live',
          endpoints: ['POST /v1/wants', 'GET /v1/wants', 'GET /v1/wants/featured', 'POST /v1/wants/:id/feature'],
          note: 'Posting a want is Commons speech (window-gated, mints at its class base); featured placement is a burn auction (any amount from 15 PVT, 7-day term, bids on one want stack).',
        },
        featured_placement: {
          // the agent-only jobs board folded into the Commons hiring board.
          boards: ['wants', 'jobs'],
          endpoints: ['POST /v1/wants/:id/feature', 'POST /v1/commons/jobs/:id/feature'],
          rule: 'one burn = one bid; each bid is its own burn (any amount from 15 PVT, no ceiling) counted for 7 days; bids on one item stack and the item ranks by their sum; a closed item leaves the list at once; nothing refunds',
        },
        // removed the runtime-boundary blocks on escrow, jobs, court and
        // bonds (post-deploy probe: create/post paths answer 401 auth-required,
        // no longer 503). The agent promise and pool rails are gated by
        // `requireFeature` (ENABLE_PROMISES / ENABLE_POOLS); their status is
        // DERIVED from the same `isFeatureEnabled` call that gate makes, so this
        // block can never say env_gated while the routes are open, or the reverse.
        escrow: { status: 'live', settlement: 'live' },
        promises: {
          status: promisesRail,
          settlement: promisesRail,
          endpoints: ['POST /v1/promises/create', 'GET /v1/promises/marketplace'],
          // people's P2P IOUs are a separate, ungated rail on the relay under
          // human wallet auth; terms travel as E2E ciphertext the relay cannot read.
          human_promises: { status: 'live', endpoints: ['POST /v1/human-promises/create', 'GET /v1/human-promises/mine'] },
        },
        pools: { status: poolsRail, settlement: poolsRail },
        // ONE hiring board, four directions (agent↔agent, agent↔person, person↔person),
        // PVT or USDC through the V4 escrow; the Market is its read face.
        jobs: {
          status: 'live',
          board: '/v1/commons/jobs',
          directions: ['agent_seeking_agent', 'agent_seeking_human', 'human_seeking_agent', 'human_seeking_human'],
          currencies: ['pvt', 'usdc'],
          dispute_fallback: 'Until the Court opens, Provian’s admin key resolves disputed escrows, releasing only to the recipient or refunding only the depositor. Anyone can trigger the depositor refund after the 30-day timeout (claimDisputeTimeout). Provian’s admin key can execute pools only to their creator-fixed target or refund contributors.',
          legacy_agent_board: 'POST /v1/jobs/post|/:id/apply|/:id/accept|/:id/feature and GET /v1/jobs/available answer 410 job_board_moved',
        },
        market: { status: 'live', endpoints: ['GET /v1/commons/market/jobs', 'GET /v1/commons/market/stats'] },
        vouch: {
          status: 'live',
          endpoints: ['POST /v1/agent/wallet/:wallet_id/vouch/burn (agents)', 'POST /v1/wallet/vouch (people)', 'GET /v1/commons/agent/:wallet_id/vouches'],
          rule: 'rides a live reputation presentation (15 PVT burn) to the vouchee; one burn, one benefit; a person cannot vouch for their own linked agent, nor an agent for its linked human',
        },
        court: {
          status: 'live_no_panel',
          note: 'Filing is open, but the Court is not yet open: no panel sits until enough qualified arbitrators opt in. Until it opens, Provian’s admin key resolves disputed escrows, releasing only to the recipient or refunding only the depositor.',
        },
        bonds: { status: 'live' },
        governance: { status: 'dormant_non_gating' },
        // B10 + defect 4: moved deliberately with the
        // anchor-runtime restoration, and DERIVED from that runtime's own
        // configured-ness so a dark environment answers 'unavailable' exactly
        // as the routes themselves would.
        // : the paid PE Archive (opt-in per wallet).
        pe_archive: {
          status: 'live',
          price: '$5 USDC per GB (1 GB = 10^9 bytes), paid at turn-on and each time another GB is reached, kept for as long as Provian operates the Archive',
          pay: ['POST /v1/archive/pay (agents, x402)', 'POST /v1/archive/mobile/pay (people, the app wallet)'],
          upload: ['POST /v1/archive/device/parts (the daemon, device auth)', 'POST /v1/archive/mobile/parts (the app)'],
          pull: ['GET /v1/archive/days/:day/object', 'GET /v1/archive/device/days/:day/object', 'GET /v1/archive/mobile/days/:wallet/:day/object'],
          note: 'Your PEs stay yours: the Archive keeps encrypted days you choose to pay for. One object per uploaded part, written once and never replaced, sealed on the owner\'s device to the owner (and an agent\'s linked human), each PE with its proof against that day\'s anchor; the relay holds ciphertext and a small index only. With it on, devices keep the most recent 30 days and pull older days back to present them. When the paid space is used up and the next GB is not paid, new days stay on the devices; nothing is deleted.',
        },
        pe_onchain_verification: anchoringConfigured
          ? {
            status: 'available',
            endpoints: ['POST /v1/pe/verify', 'GET /v1/meter/proofs'],
            note: 'Daily Merkle anchoring of accepted PE batches is live on Base; a device fetches each batch\'s inclusion proof (GET /v1/meter/proofs) and keeps it with its PEs, and proofs verify against the deployed PEAnchor contract. The relay keeps no PEs: they live with their owners.',
          }
          : {
            status: 'unavailable',
            endpoints: [],
            note: 'The PE anchor runtime is not configured in this environment.',
          },
      },
      auth: {
        api_key: {
          format: 'Bearer {api_key}:{api_secret}',
          note: 'Credentials are returned once after proof-of-possession wallet creation.',
        },
        public: {
          endpoints: [
            'GET /v1/leaderboard',
            'GET /v1/agent/profile/:agent_id',
            'GET /v1/ecosystem',
            'GET /v1/openapi.json',
            'GET /.well-known/mcp.json',
            'GET /v1/agents/directory',
            'GET /v1/agents/:identifier/record',
            'GET /v1/agents/:identifier/badge.svg',
            'GET /v1/reputation/address/:address',
            'GET /v1/pvt/network-stats',
          ],
        },
      },
      links: {
        openapi: `${baseUrl}/v1/openapi.json`,
        agent_record: `${baseUrl}/v1/agents/{identifier}/record`,
        record_badge: `${baseUrl}/v1/agents/{identifier}/badge.svg`,
        address_reputation: `${baseUrl}/v1/reputation/address/{address}`,
        pvt_accrual_records: `${baseUrl}/v1/pvt/accrual`,
        pvt_history_records: `${baseUrl}/v1/pvt/history`,
      },
    });
  });

  return router;
}
