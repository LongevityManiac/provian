import crypto from 'crypto';

import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './proposed-genesis-policy';

export const GENESIS_SETTLEMENT_AUTHORIZATION_SCHEMA =
  'pvt-genesis-settlement-authorization/v1' as const;
export const GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE =
  'genesis_settlement_budget' as const;
export const GENESIS_SETTLEMENT_CHAIN_ID = 8453 as const;
export const GENESIS_SETTLEMENT_CAMPAIGN_ID =
  PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.ledger_namespace;
export const GENESIS_SETTLEMENT_KERNEL_ID =
  'pvt9_fixed_grant_settlement_kernel/v1' as const;
export const GENESIS_SETTLEMENT_LAUNCH_EVENT_ID =
  'pvt9-genesis-settlement-launch' as const;

const ATOMIC = /^(0|[1-9][0-9]*)$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;

export interface GenesisSettlementAuthorizationSubject {
  readonly schema_version: typeof GENESIS_SETTLEMENT_AUTHORIZATION_SCHEMA;
  readonly authorization_scope: typeof GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE;
  readonly event_id: string;
  readonly policy_version: string;
  readonly authorized_at_epoch: number;
  readonly effective_epoch: number;
  readonly cap_atomic: string;
  readonly previous_event_hash: string | null;
  readonly chain_id: typeof GENESIS_SETTLEMENT_CHAIN_ID;
  readonly campaign_id: typeof GENESIS_SETTLEMENT_CAMPAIGN_ID;
  readonly settlement_kernel_id: typeof GENESIS_SETTLEMENT_KERNEL_ID;
}

export interface GenesisSettlementAuthorizationEventFields {
  readonly event_id: string;
  readonly policy_version: string;
  readonly authorized_at_epoch: number;
  readonly effective_epoch: number;
  readonly cap_atomic: string;
  readonly previous_event_hash: string | null;
  readonly authorization_scope: typeof GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE;
  readonly chain_id: typeof GENESIS_SETTLEMENT_CHAIN_ID;
  readonly campaign_id: typeof GENESIS_SETTLEMENT_CAMPAIGN_ID;
  readonly settlement_kernel_id: typeof GENESIS_SETTLEMENT_KERNEL_ID;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('non-canonical authorization number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('non-canonical authorization value');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function createGenesisSettlementAuthorizationSubject(
  event: GenesisSettlementAuthorizationEventFields,
): GenesisSettlementAuthorizationSubject {
  const subject: GenesisSettlementAuthorizationSubject = Object.freeze({
    schema_version: GENESIS_SETTLEMENT_AUTHORIZATION_SCHEMA,
    authorization_scope: event.authorization_scope,
    event_id: event.event_id,
    policy_version: event.policy_version,
    authorized_at_epoch: event.authorized_at_epoch,
    effective_epoch: event.effective_epoch,
    cap_atomic: event.cap_atomic,
    previous_event_hash: event.previous_event_hash,
    chain_id: event.chain_id,
    campaign_id: event.campaign_id,
    settlement_kernel_id: event.settlement_kernel_id,
  });
  if (!isGenesisSettlementAuthorizationSubject(subject)) {
    throw new Error('invalid Genesis settlement authorization subject');
  }
  return subject;
}

export function canonicalGenesisSettlementAuthorizationSubject(
  subject: GenesisSettlementAuthorizationSubject,
): string {
  if (!isGenesisSettlementAuthorizationSubject(subject)) {
    throw new Error('invalid Genesis settlement authorization subject');
  }
  return canonicalJson(subject);
}

export function genesisSettlementAuthorizationSubjectSha256(
  subject: GenesisSettlementAuthorizationSubject,
): string {
  return `sha256:${crypto.createHash('sha256')
    .update(canonicalGenesisSettlementAuthorizationSubject(subject), 'utf8')
    .digest('hex')}`;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

export function isGenesisSettlementAuthorizationSubject(
  value: unknown,
): value is GenesisSettlementAuthorizationSubject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const subject = value as Record<string, unknown>;
  if (!hasExactKeys(subject, [
    'schema_version',
    'authorization_scope',
    'event_id',
    'policy_version',
    'authorized_at_epoch',
    'effective_epoch',
    'cap_atomic',
    'previous_event_hash',
    'chain_id',
    'campaign_id',
    'settlement_kernel_id',
  ])) return false;
  return subject.schema_version === GENESIS_SETTLEMENT_AUTHORIZATION_SCHEMA
    && subject.authorization_scope === GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE
    && typeof subject.event_id === 'string'
    && IDENTIFIER.test(subject.event_id)
    && typeof subject.policy_version === 'string'
    && IDENTIFIER.test(subject.policy_version)
    && Number.isSafeInteger(subject.authorized_at_epoch)
    && (subject.authorized_at_epoch as number) >= 0
    && Number.isSafeInteger(subject.effective_epoch)
    && (subject.effective_epoch as number) >= 0
    && typeof subject.cap_atomic === 'string'
    && ATOMIC.test(subject.cap_atomic)
    && BigInt(subject.cap_atomic) > 0n
    && (subject.previous_event_hash === null
      || (typeof subject.previous_event_hash === 'string'
        && SHA256.test(subject.previous_event_hash)))
    && subject.chain_id === GENESIS_SETTLEMENT_CHAIN_ID
    && subject.campaign_id === GENESIS_SETTLEMENT_CAMPAIGN_ID
    && subject.settlement_kernel_id === GENESIS_SETTLEMENT_KERNEL_ID;
}

export function parseGenesisSettlementAuthorizationManifest(
  exactManifestBytes: Buffer,
): GenesisSettlementAuthorizationSubject {
  const utf8 = exactManifestBytes.toString('utf8');
  if (!Buffer.from(utf8, 'utf8').equals(exactManifestBytes)) {
    throw new Error('Genesis settlement approval manifest is not canonical UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8);
  } catch {
    throw new Error('Genesis settlement approval manifest is malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Genesis settlement approval manifest is malformed');
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.schema_version !== 'pvt9-policy-approval-manifest/v1'
    || manifest.approval_status !== 'approvable_after_independent_review'
    || manifest.signing_permitted !== true) {
    throw new Error('Genesis settlement approval manifest is not approvable');
  }
  const subject = manifest.genesis_settlement_authorization_subject;
  if (!isGenesisSettlementAuthorizationSubject(subject)) {
    throw new Error('Genesis settlement authorization subject is invalid');
  }
  if (manifest.genesis_settlement_authorization_subject_sha256
    !== genesisSettlementAuthorizationSubjectSha256(subject)) {
    throw new Error('Genesis settlement authorization subject hash is invalid');
  }
  return subject;
}

export function assertGenesisSettlementAuthorizationMatchesEvent(
  subject: GenesisSettlementAuthorizationSubject,
  event: GenesisSettlementAuthorizationEventFields,
): void {
  const expected = createGenesisSettlementAuthorizationSubject(event);
  if (canonicalGenesisSettlementAuthorizationSubject(subject)
    !== canonicalGenesisSettlementAuthorizationSubject(expected)) {
    throw new Error('Genesis settlement signed authorization does not match policy event');
  }
}
