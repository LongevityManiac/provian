import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
import {sealRelayPrivateRequest} from './relay-private-request';
/**
 * The sovereign lane, narrowed by.
 *
 * "An agent declaring its own work has no path to a PE, minting or record-only."
 * The agent's own EIP-191 signature over a work occurrence proves WHO is
 * speaking, never that the work happened, so `POST /v1/pe/submit-sovereign`
 * records only an occurrence carrying an ADMITTED `hardware_witness` a report
 * a non-actor key (a TPM / enclave / confidential-VM / GPU root) signed over
 * this exact body. The removed pieces:
 * - the x402 reputation PE (`buildSovereignPECanonicalMessage` / `signSovereignPE`):
 * Provian's chain watcher witnesses an x402 settlement; the relay refuses a
 * self-reported one;
 * - `submitSovereignWork` with an optional witness: without one the relay
 * refuses; the one-call helper below REQUIRES the hardware-witness producer
 * and refuses locally, before any key use or network call, when it is absent
 * or produces nothing. No free-text description or metadata is sent.
 *
 * New-type intake : the action type may be a compute_or_work-family type, or a
 * never-seen type the relay records for review (record_only, queued under
 * `sovereign_hardware_witness`) until a matrix row for it is signed.
 *
 * The canonical signed message MUST be reconstructed byte-identically by the
 * relay (`provian-backend/src/routes/sovereign-pe.ts
 * buildSovereignWorkCanonicalMessage`): a fixed-order, scalar-only newline
 * string with the address lowercased. Change both in lockstep and bump the tag.
 */

import { randomBytes } from 'crypto';
import { attachHardwareWitness, HARDWARE_WITNESS_FIELD, type HardwareWitnessProvider } from './hardware-witness';
import { signEip191Message } from './link-signing';
import { normalizeInputOrigins, type InputOrigin } from './input-origins';
import { normalizeOutputDigests } from './output-digests';
import { ProvianError } from './errors';

/** Versioned canonical-message tag for the sovereign work binding. */
export const SOVEREIGN_WORK_CANONICAL_TAG = 'provian_sovereign_work_v1';

/** The security-critical, signed fields of a sovereign compute/work PE submission. */
export interface SovereignWorkFields {
  /**
   * The action type: a compute_or_work-family type (e.g. 'agent_work_product_code'), or any
   * never-seen type, which the relay records for review with no mint (new-type intake, the operator
   * 2026-10-22) and which earns only once a matrix row for it is signed. A named type outside the
   * compute_or_work family is refused (403 `named_type_witnessed_elsewhere`).
   */
  action_type: string;
  /** The agent's own sovereign EOA address (must equal the recovered signer). */
  agent_address: string;
  /** Unique id for this work occurrence — binds the signature to this specific work. */
  occurrence_id: string;
  /** Single-use replay nonce: 0x + 64 hex chars. */
  nonce: string;
  /** Unix ms timestamp; the relay enforces a freshness window. */
  iat: number;
}

/**
 * Build the exact UTF-8 string the agent signs for a work binding (reconstructed
 * byte-identically by the relay). Fixed field order + scalar-only + lowercased address.
 */
export function buildSovereignWorkCanonicalMessage(fields: SovereignWorkFields): string {
  return [
    SOVEREIGN_WORK_CANONICAL_TAG,
    `action_type=${fields.action_type}`,
    `agent_address=${fields.agent_address.toLowerCase()}`,
    `iat=${fields.iat}`,
    `nonce=${fields.nonce.toLowerCase()}`,
    `occurrence_id=${fields.occurrence_id}`,
  ].join('\n');
}

/** A fresh single-use replay nonce (0x + 64 hex chars). */
export function newSovereignNonce(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

/** Inputs for a hardware-witnessed sovereign work submission. */
export interface SubmitHardwareWitnessedWorkParams {
  /**
   * The action type: a compute_or_work-family type (e.g. 'agent_work_product_code'), or any
   * never-seen type, which the relay records for review with no mint (new-type intake, the operator
   * 2026-10-22) and which earns only once a matrix row for it is signed. A named type outside the
   * compute_or_work family is refused (403 `named_type_witnessed_elsewhere`).
   */
  actionType: string;
  /**
   * Unique id for this work occurrence (8–200 chars, [A-Za-z0-9_.:@/=+-]) —
   * e.g. an output/content hash. One occurrence mints once per agent.
   */
  occurrenceId: string;
  /**
   * REQUIRED: the hardware-witness producer (TPM quote, Confidential Space token,
   * Nitro document, …) that signs over this exact body with a NON-actor key. The
   * relay admits the occurrence only when the report verifies to its scheme's
   * pinned public root (`hardware_rooted`); otherwise it refuses.
   */
  hardwareWitness: HardwareWitnessProvider;
  /** External input origins the work consumed (unsigned; zero mint effect). */
  inputOrigins?: InputOrigin[] | null;
  /** What the work produced (forwarded raw; the relay normalizes). */
  outputDigests?: unknown;
}

/**
 * The families the relay answers a recorded sovereign submission with (`routes/sovereign-pe.ts`):
 * `compute_or_work` for a type of the known work family, `new_type_intake` for a type the intake rule
 * admitted (recorded for review; earns only once a row for it is signed). Bound to the relay source
 * by `sovereign-pe.test.ts`.
 */
export const SOVEREIGN_SUBMIT_FAMILIES = ['compute_or_work', 'new_type_intake'] as const;
export type SovereignSubmitFamily = (typeof SOVEREIGN_SUBMIT_FAMILIES)[number];

function isSovereignSubmitFamily(value: unknown): value is SovereignSubmitFamily {
  return typeof value === 'string' && (SOVEREIGN_SUBMIT_FAMILIES as readonly string[]).includes(value);
}

/** Relay response for a sovereign submission. */
export interface SovereignSubmitResult {
  pe_id: string;
  recorded: boolean;
  /** The family the relay recorded the occurrence under — as the relay answered it, never assumed. */
  family: SovereignSubmitFamily;
}

/**
 * Sign and submit a HARDWARE-WITNESSED work occurrence in one call. Refuses
 * locally (`HARDWARE_WITNESS_REQUIRED`) when no producer is given or it
 * produces nothing — the relay would refuse the body as the agent's own claim.
 * Throws on a non-201 relay answer (the relay's `code` is surfaced).
 */
export async function submitHardwareWitnessedWork(
  relayUrl: string,
  wallet: { privateKeyHex: string; address: string },
  params: SubmitHardwareWitnessedWorkParams,
  fetchFn: typeof fetch = fetch,
): Promise<SovereignSubmitResult> {
  fetchFn = guardedFetcher(fetchFn);
  if (typeof params.hardwareWitness !== 'function') {
    throw new ProvianError(
      'A sovereign submission needs a hardware witness: the agent\'s own signature is its own claim, which is '
      + 'not a PE. Work on a registered machine is recorded by the observer daemon.',
      'HARDWARE_WITNESS_REQUIRED',
    );
  }
  const fields: SovereignWorkFields = {
    action_type: params.actionType,
    agent_address: wallet.address,
    occurrence_id: params.occurrenceId,
    nonce: newSovereignNonce(),
    iat: Date.now(),
  };
  const signature = signEip191Message(wallet.privateKeyHex, buildSovereignWorkCanonicalMessage(fields));
  const payload: Record<string, unknown> = {
    ...fields,
    signature,
    ...(normalizeInputOrigins(params.inputOrigins) !== null
      ? { input_origins: normalizeInputOrigins(params.inputOrigins) }
      : {}),
    ...(normalizeOutputDigests(params.outputDigests) !== null
      ? { output_digests: normalizeOutputDigests(params.outputDigests) }
      : {}),
  };
  // §2.9: the hardware-witness slot, bound to this exact payload.
  const witnessed = await attachHardwareWitness(payload, params.hardwareWitness);
  if (witnessed[HARDWARE_WITNESS_FIELD] === undefined || witnessed[HARDWARE_WITNESS_FIELD] === null) {
    throw new ProvianError(
      'The hardware-witness producer returned no report, so this submission would be only the agent\'s own claim, '
      + 'which is not a PE.',
      'HARDWARE_WITNESS_REQUIRED',
    );
  }
  const response = await fetchFn(`${relayUrl.replace(/\/$/, '')}/v1/pe/submit-sovereign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await sealRelayPrivateRequest(relayUrl,'/v1/pe/submit-sovereign',witnessed,wallet.privateKeyHex,fetchFn)),
  });
  const body = (await response.json().catch(() => null)) as
    | (Omit<Partial<SovereignSubmitResult>, 'family'> & { family?: unknown; error?: string; code?: string })
    | null;
  if (response.status !== 201 || !body || typeof body.pe_id !== 'string') {
    const detail = body?.code ?? body?.error ?? `http_${response.status}`;
    throw new Error(`hardware-witnessed work submission failed: ${detail}`);
  }
  // Unknown = block: a family this SDK does not know (or none) is never reported as a guess.
  if (!isSovereignSubmitFamily(body.family)) {
    throw new ProvianError(
      `The relay recorded ${body.pe_id} but answered a family this SDK does not know `
      + `(${JSON.stringify(body.family ?? null)}); expected one of ${SOVEREIGN_SUBMIT_FAMILIES.join(', ')}.`,
      'SOVEREIGN_FAMILY_UNKNOWN',
    );
  }
  return { pe_id: body.pe_id, recorded: body.recorded === true, family: body.family };
}
