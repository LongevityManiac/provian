/**
 * RELAY-OBSERVATION WITNESS — fact-base fixes item 4 (, carrying the 2026-09-12
 * counting rule).
 *
 * The rule: an origin counts toward independence when a key that is NOT the actor's vouched for it —
 * the owner's signature, a body-bound registered device, OR a relay-witnessed observation (the
 * GitHub App webhook, a chain watcher / on-chain verification). Before this module the
 * relay-composed lanes (forge webhooks, chain watchers, the chain-verified transfer record) built
 * their origins but handed the pricing path NO witness (`submissionWitness: null`), so every one of
 * them sealed `witnessed:false` and added zero.
 *
 * THE BOUNDARY THAT HOLDS. The relay witnesses ONLY the origins it DERIVED ITSELF from the verified
 * event — the repository and parent commit a verified webhook names, the counterparty address and
 * the settlement a verified chain log carries. It NEVER witnesses actor-authored content that rides
 * inside or alongside that event: origins a device reported and the webhook later unioned in, a
 * resource URL from a self-report, anything in a body. So the emitter passes the EXACT origins it
 * derived (`derivedOrigins`), and this module keys them against the PE's normalized, hashed
 * `input_origins`; only an origin present in BOTH is witnessed. A `pe:` origin is never
 * relay-derived (a consumption edge is resolved from the relay's own index, not an external event).
 * NOT A RELAY OBSERVATION: a GitLab or Bitbucket delivery. Those are verified
 * against a per-install secret Provian hands to the USER, so what they name is the secret holder's
 * word, not an observation independent of the actor; they pass nothing here.
 *
 * The witnessed origins then face the UNCHANGED owner-resolution, identity-set, and closed-loop
 * tests (`origin-pricing-inputs.ts`), so a same-party or ring origin still adds zero.
 *
 * Sovereign submits and relay/action self-reports are the actor's own word: they never pass an
 * observation and stay unwitnessed. Nothing here touches the signed matrix or monetary template.
 */

import { normalizeInputOrigins, type InputOrigin } from '../provenance/input-origins';
import type { SealedWitness } from './origin-independence';

/** What a relay-composed emitter hands `generatePE`: its verified observation + what it derived. */
export interface RelayObservation {
  /** The relay's own verifier, e.g. `forge_webhook:github_app` / `chain_watcher:eip155:8453`. */
  readonly witness: SealedWitness;
  /** EXACTLY the origins the relay derived from the verified event (a subset of `input_origins`). */
  readonly derivedOrigins: readonly InputOrigin[];
}

/** The accrual-side form: the witness + the keys of the origins it vouches for. Stored in the replay. */
export interface RelayWitnessedOrigins {
  readonly witness: SealedWitness;
  /** `origin_identifier|hash` of each relay-derived origin present on the sealed PE. */
  readonly originKeys: readonly string[];
}

export const RELAY_WITNESS_FORGE_WEBHOOK = 'forge_webhook';
export const RELAY_WITNESS_CHAIN_WATCHER = 'chain_watcher';

/** The one key shape both sides compute. */
export function originKey(origin: { readonly origin_identifier: string; readonly hash: string }): string {
  return `${origin.origin_identifier}|${origin.hash}`;
}

/** Build the relay's own witness identity (never a device, never an actor key). */
export function relayObservationWitness(
  kind: typeof RELAY_WITNESS_FORGE_WEBHOOK | typeof RELAY_WITNESS_CHAIN_WATCHER,
  verifier: string,
): SealedWitness {
  return { identity: `relay:${kind}:${verifier}`, tier: null };
}

function isPeIdentifier(id: string): boolean {
  return id.startsWith('pe:');
}

/**
 * Resolve an emitter's observation against the PE's normalized `input_origins`. Returns null (the
 * byte-identical-to-before path) when there is no observation, no usable witness, or no derived
 * origin actually sealed on the PE. Pure and deterministic.
 */
export function relayWitnessedOriginsFor(
  observation: RelayObservation | null | undefined,
  sealedInputOrigins: readonly InputOrigin[] | null,
): RelayWitnessedOrigins | null {
  if (!observation || !sealedInputOrigins || sealedInputOrigins.length === 0) return null;
  const identity = observation.witness?.identity;
  if (typeof identity !== 'string' || !identity.startsWith('relay:')) return null;
  const derived = normalizeInputOrigins(observation.derivedOrigins) ?? [];
  const sealedKeys = new Set(sealedInputOrigins.map(originKey));
  const keys = [...new Set(
    derived
      .filter((o) => !isPeIdentifier(o.origin_identifier))
      .map(originKey)
      .filter((k) => sealedKeys.has(k)),
  )].sort();
  if (keys.length === 0) return null;
  return { witness: { identity, tier: null }, originKeys: keys };
}
