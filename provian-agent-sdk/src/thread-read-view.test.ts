import { describe, expect, it, vi } from 'vitest';
import { CommonsInstitutions } from './commons-institutions';
import { deriveMessageKeyPair, sealThreadMessage } from './thread-crypto';
import { withThreadOutputSignature, outputHashOfText, type OutputSignature } from './output-signature';
const KEY = '12'.repeat(32), WALLET = 'wallet_aw_reader';
const signature: OutputSignature = { hash: outputHashOfText('Received'), signer: { kind: 'app', id: 'aok_' + 'a'.repeat(32) }, scheme: 'p256_sha256', sig: '1'.repeat(128) };
const ciphertexts = sealThreadMessage(withThreadOutputSignature('Received', signature), { [WALLET]: deriveMessageKeyPair(KEY).pubkeyB64u }).ciphertexts;
const message = { message_id: 'm', pe_id: 'pe_m', author_id: 'stranger', created_at: 1500, ciphertexts };
function setup() {
 const bank = new CommonsInstitutions({ relayUrl: 'https://relay.test', walletId: WALLET, apiKey: 'test', apiSecret: 'test' });
 vi.spyOn(bank, 'getThreadMessages').mockResolvedValue({ thread: { thread_id: 't', read_cursors: { [WALLET]: 1000 } }, reply_policy: { mode: 'ask_me_first', linked_human: 'human' }, messages: [message] });
 vi.spyOn(bank, 'listApprovalRequests').mockResolvedValue([]);
 vi.spyOn(bank, 'unreadThreads').mockResolvedValue({ threads: [{ thread_id: 't' }], reply_policy: { mode: 'ask_me_first', linked_human: 'human' } });
 return bank;
}
describe('one-thread and unread policy and plaintext parity', () => {
 it('retains policy, next step, PE id and separate signature on both readers', async () => {
  const bank = setup();
  const page = await bank.readThreadMessages('t', KEY);
  const unread = await bank.readUnreadThreadMessages(KEY, { markRead: false });
  expect(page.reply_policy).toEqual(unread.reply_policy);
  expect(page).toMatchObject({ next_step: 'ask_first', ask_for: 'pe_m', reply_instruction: expect.stringContaining('ask me first') });
  for (const view of [(page.messages as Array<Record<string, unknown>>)[0], unread.threads[0].messages[0]]) {
   expect(view).toMatchObject({ text: 'Received', pe_id: 'pe_m', provian_output_signature: signature });
   expect(view.text).not.toContain('Provian-Output-Signature');
  }
 });
 it('approval failure waits; approved and rejected states retain their exact instructions', async () => {
  const bank = setup(); vi.mocked(bank.listApprovalRequests).mockRejectedValueOnce(new Error('503'));
  expect(await bank.readThreadMessages('t', KEY)).toMatchObject({ next_step: 'waiting_for_approval' });
  for (const decision of ['approved', 'rejected'] as const) {
   vi.mocked(bank.listApprovalRequests).mockResolvedValue([{ request_id: 'r', action_description_sha256: 'a'.repeat(64), satisfied_by_pe_id: 'pe_approval', subject_pe_id: 'pe_m', status: 'satisfied', decision, expires_at_ms: Date.now() + 10000 }]);
   expect(await bank.readThreadMessages('t', KEY)).toMatchObject({ next_step: decision === 'approved' ? 'approved_reply_now' : 'do_not_reply' });
  }
 });
 it('wrong key yields no plaintext or signature; unsigned and malformed trailers are not misrepresented', () => {
  const bank = setup();
  expect(bank.decryptThreadMessageViews([message], '13'.repeat(32))[0]).toEqual({ text: null, provian_output_signature: null });
  for (const text of ['unsigned', 'Received\n\nProvian-Output-Signature: invalid']) {
   const ct = sealThreadMessage(text, { [WALLET]: deriveMessageKeyPair(KEY).pubkeyB64u }).ciphertexts;
   expect(bank.decryptThreadMessageViews([{ ciphertexts: ct }], KEY)[0]).toEqual({ text, provian_output_signature: null });
  }
 });
});

it('a history page cannot reuse an old approval for a newer unread message', async () => {
 const bank = setup();
 vi.mocked(bank.getThreadMessages).mockImplementation(async (_id, opts) => ({ thread: { read_cursors: { [WALLET]: 0 } }, reply_policy: { mode: 'ask_me_first', linked_human: 'human' }, messages: [{ ...message, pe_id: opts?.before ? 'pe_old' : 'pe_new', created_at: opts?.before ? 10 : 20 }] }));
 vi.mocked(bank.listApprovalRequests).mockResolvedValue([{ request_id: 'r', action_description_sha256: 'a'.repeat(64), satisfied_by_pe_id: 'pe_approval', subject_pe_id: 'pe_old', status: 'satisfied', decision: 'approved', expires_at_ms: Date.now() + 10000 }]);
 const historical = await bank.readThreadMessages('t', KEY, { before: 15 });
 expect(historical).toMatchObject({ next_step: 'ask_first', ask_for: 'pe_new' });
 expect((historical.messages as Array<Record<string, unknown>>)[0].pe_id).toBe('pe_old');
});

it('a limited output page still uses the entire unread policy context', async () => {
 const bank = setup();
 const own = Array.from({ length: 100 }, (_, i) => ({ ...message, message_id: `own${i}`, author_id: WALLET, created_at: 2000 + i }));
 vi.mocked(bank.getThreadMessages).mockImplementation(async (_id, opts) => ({ thread: { read_cursors: { [WALLET]: 1000 } }, reply_policy: { mode: 'ask_me_first', linked_human: 'human' }, messages: opts?.before ? [message] : opts?.limit === 1 ? own.slice(-1) : own }));
 const page = await bank.readThreadMessages('t', KEY, { limit: 1 });
 expect(page).toMatchObject({ next_step: 'ask_first', ask_for: 'pe_m' });
 expect(page.messages).toHaveLength(1);
 expect(bank.getThreadMessages).toHaveBeenLastCalledWith('t', { limit: 100, before: 2000, beforeId: 'own0' });
});
