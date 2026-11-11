import { deriveBoundRecoveryCredential } from './recourse-address-credential';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBytes, sha256, toUtf8Bytes } from 'ethers';
import { readAgentBreakEntitlement, recoverAgentBreak } from './break-recovery-store';
import { encryptKeystore, saveKeystore } from './keystore';
import { generateAgentKeyPair } from './wallet';
import { privateRecourseIntent, type RecoursePrivateAuthorization } from './private-access-data';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import { recoverFreeBreak } from './free-break-recovery';
import { recoveryCommitment, recoverySigningRoot } from './recourse-hash-authorization';

vi.mock('./break-recovery', async original => ({ ...await original<typeof import('./break-recovery')>(),
  readBreakRecoveryContext: async () => `0x${'22'.repeat(20)}` }));
vi.mock('./guarded-fetch', () => ({ guardedFetcher: (fetch: typeof globalThis.fetch) => fetch }));
vi.mock('./free-break-recovery', () => ({ recoverFreeBreak: vi.fn() }));
vi.mock('./recourse-binding-chain', () => ({ readAddressRecoveryBinding: async () => `0x${'93'.repeat(32)}` }));
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
test('backup discovery sends a verifiable private POST and refuses substituted identities and unsafe origins', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-break-discovery-')); directories.push(directory);
  const walletId = 'wallet_aw_private_discovery', passphrase = 'TEST ONLY backup secret';
  const identity = `0x${'93'.repeat(32)}`;
  saveKeystore(encryptKeystore({ ...generateAgentKeyPair(), walletId, passphrase, recoverySecret: '33'.repeat(32),
    recoverySigningSeed: '44'.repeat(32), kdfParams: { N: 1024, r: 8, p: 1, dklen: 32 } }), join(directory, 'agent-keystore.json'));
  let substitute = false;
  const fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    expect(String(url)).toBe(`https://relay.example/v1/recourse/break-entitlements/0x${'22'.repeat(20)}/${identity}`);
    expect(options?.method).toBe('POST');
    const body = JSON.parse(String(options?.body)) as { authorization: RecoursePrivateAuthorization; request: unknown };
    expect(body.request).toBeNull(); expect(body.authorization.identity).toBe(identity);
    const { slh_dsa_sha2_128s } = await import('@noble/post-quantum/slh-dsa.js');
    expect(slh_dsa_sha2_128s.verify(getBytes(body.authorization.signature),
      getBytes(privateRecourseIntent(body.authorization, `break-entitlements/0x${'22'.repeat(20)}/${identity}`)),
      getBytes(body.authorization.publicKey))).toBe(true);
    return new Response(JSON.stringify({ identity: substitute ? `0x${'55'.repeat(32)}` : identity,
      amount: '100', commitment: body.authorization.commitment, proof: [] }));
  });
  const input = { directory, passphrase, network: {} as OwnerChainNetwork, relayUrl: 'https://relay.example', fetch };
  expect(await readAgentBreakEntitlement(input)).toMatchObject({ identity, amount: '100' });
  substitute = true;
  await expect(readAgentBreakEntitlement(input)).rejects.toThrow('context_changed');
  fetch.mockClear();
  for (const relayUrl of ['http://relay.example', 'https://user:password@relay.example', 'https://relay.example?secret=x']) {
    await expect(readAgentBreakEntitlement({ ...input, relayUrl })).rejects.toThrow('relay_invalid');
  }
  expect(fetch).not.toHaveBeenCalled();
}, 20000);
test.each(['55', '66'])('chain-ahead snapshot %s still authenticates with the relay-registered predecessor', async newer => {
  const directory = mkdtempSync(join(tmpdir(), 'private-break-discovery-')); directories.push(directory);
  const walletId = 'wallet_aw_private_discovery', passphrase = 'TEST ONLY backup secret';
  const identity = `0x${'93'.repeat(32)}`;
  saveKeystore(encryptKeystore({ ...generateAgentKeyPair(), walletId, passphrase, recoverySecret: '33'.repeat(32),
    recoverySigningSeed: '44'.repeat(32), kdfParams: { N: 1024, r: 8, p: 1, dklen: 32 } }), join(directory, 'agent-keystore.json'));
  const root = new Uint8Array(64); root.fill(0x33, 0, 32); root.fill(0x44, 32);
  const derived = deriveBoundRecoveryCredential(root, identity, '0');
  const registered = recoveryCommitment(derived.recoverySecret, await recoverySigningRoot(derived.signingSeed));
  const entitlement = { identity, amount: '100', commitment: `0x${newer.repeat(32)}`, proof: [] };
  const fetch = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body));
    expect(options?.method).toBe('POST');
    // The newer valid chain entitlement has not completed the relay cut.
    // A relay still at the registered predecessor would reject it as API auth.
    if (body.authorization.commitment !== registered) return new Response('{}', { status: 404 });
    expect(body.request.commitment).toBe(entitlement.commitment);
    return new Response('{}');
  });
  vi.mocked(recoverFreeBreak).mockImplementationOnce(async input => {
    await input.transport.request('break-deployments', entitlement);
    throw Error('test_stops_before_chain_work');
  });
  await expect(recoverAgentBreak({ directory, passphrase, entitlement, network: {} as OwnerChainNetwork,
    relayUrl: 'https://relay.example', fetch })).rejects.toThrow('test_stops_before_chain_work');
  expect(fetch).toHaveBeenCalledTimes(1);
}, 20000);
