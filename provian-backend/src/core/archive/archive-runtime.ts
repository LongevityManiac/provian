/**
 * — the PE Archive's production wiring. The bucket is `PE_ARCHIVE_BUCKET` (default
 * `provian-ai-pe-archive`, Archive storage class as its default — the operator creates it; this
 * code creates nothing in GCP). Charges use the shared USDC charge runtime (the payout's chain reads,
 * and before the launch flip its gas key and nonce lease). From the flip (`PUBLIC_LAUNCH=true`, read
 * per request) Coinbase's CDP facilitator settles every new Archive charge with the CDP Secret API
 * key the onramp already uses. The anchor is the deployed PEAnchor read
 * contract (provider only, no key).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { canonicalPeAnchorReadContract } from '../presentation/anchor-contract';
import { createUsdcChargeRuntime } from '../payments/usdc-charge-runtime';
import { createCdpFacilitator, type CdpFacilitator } from '../payments/cdp-facilitator';
import { ARCHIVE_BUCKET_ENV, ARCHIVE_DEFAULT_BUCKET } from './archive-terms';
import { createGcsArchiveObjectStore } from './archive-objects';
import type { ArchiveDeps, ArchiveSettlement } from './archive-service';
import {PRIVATE_RETENTION_STATE_COLLECTION,PRIVATE_RETENTION_STATE_DOC} from '../provenance/private-retention';

/** The flip's own switch (`routes/middleware/pre-launch-surface-gate.ts` reads the same variable). */
export const ARCHIVE_CDP_SWITCH_ENV = 'PUBLIC_LAUNCH';
export const CDP_KEY_ID_ENV = 'COINBASE_CDP_API_KEY_ID';
export const CDP_PRIVATE_KEY_ENV = 'COINBASE_CDP_API_PRIVATE_KEY';

/** CDP's facilitator over the onramp's Secret API key; null when either half is absent. */
export function cdpFacilitatorFromEnv(env: NodeJS.ProcessEnv): CdpFacilitator | null {
  const keyId = env[CDP_KEY_ID_ENV]?.trim();
  const secret = env[CDP_PRIVATE_KEY_ENV]?.trim();
  if (!keyId || !secret) return null;
  return createCdpFacilitator({ creds: { keyId, secret } });
}

/**
 * Who settles a new Archive charge. Read per request: nothing settles through CDP — and so nothing
 * can list the Archive in Coinbase's public Bazaar — before the flip opens the site.
 */
export function archiveSettlementFromEnv(env: NodeJS.ProcessEnv): ArchiveSettlement {
  return {
    mode: () => (env[ARCHIVE_CDP_SWITCH_ENV] === 'true' ? 'cdp_facilitator' : 'relay_gas_key'),
    cdp: cdpFacilitatorFromEnv(env),
  };
}

const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

export function archiveBucketName(env: NodeJS.ProcessEnv): string | null {
  const name = (env[ARCHIVE_BUCKET_ENV] ?? ARCHIVE_DEFAULT_BUCKET).trim();
  return BUCKET_NAME.test(name) ? name : null;
}

export function createArchiveDeps(params: {
  readonly db: Firestore;
  readonly env: NodeJS.ProcessEnv;
  readonly readEthPrice: () => Promise<{ usd: number; as_of_ms: number } | null>;
}): ArchiveDeps | null {
  const bucket = archiveBucketName(params.env);
  if (bucket === null) return null;
  return {
    db: params.db,
    objects: createGcsArchiveObjectStore(bucket,undefined,async()=>{
      const state=await params.db.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).get();
      return state.data()?.opaque_ids_ready===true;
    }),
    anchor: canonicalPeAnchorReadContract(),
    charge: createUsdcChargeRuntime({ db: params.db, env: params.env, readEthPrice: params.readEthPrice, leasePrefix: 'archive' }),
    settlement: archiveSettlementFromEnv(params.env),
    now: () => Date.now(),
  };
}
