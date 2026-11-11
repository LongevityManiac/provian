import { createHash, randomBytes } from 'crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { PrivateMembershipEpisode } from './private-membership-calendar';

export const PRIVATE_MEMBERSHIP_JOURNAL = 'recourse_private_membership_journal_v1';
export interface MembershipJournalPosition {
  readonly chainId: '8453'; readonly kernel: string; readonly pool: string;
  readonly block: number; readonly blockHash: string; readonly logIndex: number; readonly timestamp: number;
}
export interface MembershipJournalEntry {
  readonly id: string; readonly ownerIdentity: string; readonly previousId: string | null;
  readonly salt: string; readonly kind: 'admission' | 'closure' | 'debit' | 'issuance';
  readonly beforeEpisodeHash: string; readonly episode: PrivateMembershipEpisode;
  readonly position: MembershipJournalPosition; readonly evidenceId: string;
}
export interface MembershipJournalAccount {
  readonly ownerIdentity: string; readonly episode: PrivateMembershipEpisode; readonly journalHead?: string;
}
const HASH = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/;
const fail = (reason: string): never => { throw Error(`recourse_membership_journal_${reason}`); };
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`).join(',')}}`;
  const s = JSON.stringify(value); return s === undefined ? fail('encoding') : s;
}
export const membershipJournalHash = (value: unknown): string => `0x${createHash('sha256').update(stable(value)).digest('hex')}`;
export function beforeMembershipPosition(a: Pick<MembershipJournalPosition, 'block' | 'logIndex'>,
  b: Pick<MembershipJournalPosition, 'block' | 'logIndex'>): boolean {
  return a.block < b.block || (a.block === b.block && a.logIndex < b.logIndex);
}
function validatePosition(p: MembershipJournalPosition): void {
  if (p.chainId !== '8453' || !ADDRESS.test(p.kernel) || !ADDRESS.test(p.pool) || !HASH.test(p.blockHash)
    || ![p.block, p.logIndex, p.timestamp].every(n => Number.isSafeInteger(n) && n >= 0)) fail('position');
}
export function checkMembershipJournalEntry(value: MembershipJournalEntry): void {
  const { id, ...body } = value;
  if (!HASH.test(id) || id !== membershipJournalHash(body) || !HASH.test(value.ownerIdentity) || !HASH.test(value.salt)
    || !HASH.test(value.beforeEpisodeHash) || !HASH.test(value.evidenceId)
    || (value.previousId !== null && !HASH.test(value.previousId))
    || !['admission', 'closure', 'debit', 'issuance'].includes(value.kind) || !value.episode) fail('entry');
  validatePosition(value.position);
}

/** Called inside the already authenticated receipt/transition transaction,
 * before any writes. The returned write must accompany the account head update.
 * No caller-provided journal head, salt or history is accepted from an API. */
export async function prepareMembershipJournalAppend(db: Firestore, tx: Transaction, input: {
  readonly ownerIdentity: string; readonly account: MembershipJournalAccount | null; readonly episode: PrivateMembershipEpisode;
  readonly position: MembershipJournalPosition; readonly kind: MembershipJournalEntry['kind']; readonly evidenceId: string;
}): Promise<{ readonly head: string; write(): void }> {
  const detached = JSON.parse(stable(input)) as typeof input;
  if (!HASH.test(detached.ownerIdentity) || !HASH.test(detached.evidenceId)) return fail('identity');
  validatePosition(detached.position);
  let previous: MembershipJournalEntry | null = null;
  if (detached.account) {
    const account = detached.account;
    if (account.ownerIdentity !== detached.ownerIdentity || !account.journalHead || !HASH.test(account.journalHead)) return fail('missing_head');
    const row = await tx.get(db.collection(PRIVATE_MEMBERSHIP_JOURNAL).doc(account.journalHead));
    if (!row.exists) return fail('missing_entry');
    previous = row.data() as MembershipJournalEntry; checkMembershipJournalEntry(previous);
    if (previous.id !== account.journalHead || previous.ownerIdentity !== detached.ownerIdentity
      || membershipJournalHash(previous.episode) !== membershipJournalHash(account.episode)) return fail('head_mismatch');
    if (!beforeMembershipPosition(previous.position, detached.position) || previous.position.timestamp > detached.position.timestamp
      || (previous.position.block === detached.position.block && previous.position.blockHash !== detached.position.blockHash)) return fail('order');
    if (previous.position.kernel !== detached.position.kernel || previous.position.pool !== detached.position.pool) return fail('succession_required');
  } else if (detached.kind !== 'admission') return fail('missing_admission');
  const body = { ownerIdentity: detached.ownerIdentity, previousId: previous?.id ?? null,
    salt: `0x${randomBytes(32).toString('hex')}`, kind: detached.kind,
    beforeEpisodeHash: membershipJournalHash(detached.account?.episode ?? null), episode: detached.episode,
    position: detached.position, evidenceId: detached.evidenceId };
  const entry: MembershipJournalEntry = { id: membershipJournalHash(body), ...body };
  checkMembershipJournalEntry(entry);
  return { head: entry.id, write: () => tx.create(db.collection(PRIVATE_MEMBERSHIP_JOURNAL).doc(entry.id), entry) };
}

/** Immutable, gap-detecting private history. Only the current account's head is
 * accepted. A row omitted or modified in storage cannot silently move a payment
 * across the loss boundary. Salts and journal IDs never leave the relay. */
export async function readMembershipJournal(db: Firestore, account: MembershipJournalAccount): Promise<readonly MembershipJournalEntry[]> {
  if (!HASH.test(account.ownerIdentity) || !account.journalHead || !HASH.test(account.journalHead)) return fail('missing_head');
  const result: MembershipJournalEntry[] = [], seen = new Set<string>();
  let id: string | null = account.journalHead;
  while (id !== null) {
    if (seen.has(id)) return fail('cycle'); seen.add(id);
    const row = await db.collection(PRIVATE_MEMBERSHIP_JOURNAL).doc(id).get();
    if (!row.exists) return fail('missing_entry');
    const entry = row.data() as MembershipJournalEntry; checkMembershipJournalEntry(entry);
    if (entry.id !== id || entry.ownerIdentity !== account.ownerIdentity) return fail('owner');
    const next = result[result.length - 1];
    if (next && (membershipJournalHash(entry.episode) !== next.beforeEpisodeHash
      || !beforeMembershipPosition(entry.position, next.position) || entry.position.timestamp > next.position.timestamp
      || (entry.position.block === next.position.block && entry.position.blockHash !== next.position.blockHash)
      || entry.position.kernel !== next.position.kernel || entry.position.pool !== next.position.pool)) return fail('chain');
    result.push(entry); id = entry.previousId;
  }
  if (result.length === 0 || membershipJournalHash(result[0].episode) !== membershipJournalHash(account.episode)
    || result[result.length - 1].beforeEpisodeHash !== membershipJournalHash(null) || result[result.length - 1].kind !== 'admission') return fail('chain');
  return result.reverse();
}
