import { describe, expect, it } from 'vitest';
import { deriveMessageKeyPair, sealThreadMessage } from '../../../provian-agent-sdk/src/thread-crypto';
import { withThreadOutputSignature, outputHashOfText, type OutputSignature } from '../../../provian-agent-sdk/src/output-signature';
import { decryptLocalThreadMessage } from './thread-reader';
import { callProvianTool } from './tools';
import type { ToolContext } from './types';
const key = '12'.repeat(32);
const signature: OutputSignature = { hash: outputHashOfText('Received'), signer: { kind: 'app', id: 'aok_' + 'a'.repeat(32) }, scheme: 'p256_sha256', sig: '1'.repeat(128) };
const ciphertext = sealThreadMessage(withThreadOutputSignature('Received', signature), { reader: deriveMessageKeyPair(key).pubkeyB64u }).ciphertexts.reader;
describe('MCP thread plaintext uses the SDK wire', () => {
 it('opens SDK ciphertext and retains the signature separately', () => {
  expect(decryptLocalThreadMessage(key, ciphertext)).toEqual({ text: 'Received', provian_output_signature: signature });
  expect(() => decryptLocalThreadMessage('13'.repeat(32), ciphertext)).toThrow();
 });
 it('local read returns text and owner next step; remote mode retains ciphertext without touching a key', async () => {
  let keyReads = 0;
  const ctx: ToolContext = {
   baseUrl: 'https://relay.test', auth: { apiKey: 'k', apiSecret: 's' }, mode: 'local',
   fetchImpl: async (url) => new Response(JSON.stringify(String(url).includes('approval-requests') ? { requests: [] } : { reader_id: 'reader', read_cursor: 0, reply_policy: { mode: 'ask_me_first', linked_human: 'human' }, messages: [{ message_id: 'm', pe_id: 'pe_m', author_id: 'stranger', created_at: 1, ciphertexts: { reader: ciphertext } }] })),
   withLocalSovereignIdentity: (fn) => { keyReads++; return fn({ walletId: 'reader', address: 'unused', pubkey: 'unused', signEip191: () => '', signPop: () => '', readThreadMessage: (ct) => decryptLocalThreadMessage(key, ct) }); },
  };
  const read = async () => JSON.parse((await callProvianTool('read_threads', { thread_id: 't' }, ctx)).content[0].text);
  const local = await read(); expect(local).toMatchObject({ next_step: 'ask_first', ask_for: 'pe_m' });
  expect(local.messages[0]).toMatchObject({ text: 'Received', provian_output_signature: signature });
  expect(local.reply_instruction).toContain('ask me first');
  ctx.mode = 'remote'; keyReads = 0;
  const remote = await read(); expect(remote.messages[0].ciphertexts.reader).toBe(ciphertext); expect(keyReads).toBe(0);
 });
});

it('short output pages retain policy for an older unread incoming message', async () => {
 const incoming = { message_id: 'incoming', pe_id: 'pe_incoming', author_id: 'stranger', created_at: 1 };
 const own = Array.from({ length: 100 }, (_, i) => ({ message_id: `own${i}`, author_id: 'reader', created_at: i + 2 }));
 const ctx: ToolContext = {
  baseUrl: 'https://relay.test', auth: { apiKey: 'k', apiSecret: 's' }, mode: 'remote',
  fetchImpl: async (url) => {
   const u = new URL(String(url));
   return new Response(JSON.stringify(u.pathname.includes('approval-requests') ? { requests: [] } : {
    reader_id: 'reader', read_cursor: 0, reply_policy: { mode: 'ask_me_first', linked_human: 'human' },
    messages: u.searchParams.has('before') ? [incoming] : u.searchParams.get('limit') === '1' ? own.slice(-1) : own,
   }));
  },
 };
 const result = JSON.parse((await callProvianTool('read_threads', { thread_id: 't', limit: 1 }, ctx)).content[0].text);
 expect(result).toMatchObject({ next_step: 'ask_first', ask_for: 'pe_incoming' });
 expect(result.messages).toHaveLength(1);
});
