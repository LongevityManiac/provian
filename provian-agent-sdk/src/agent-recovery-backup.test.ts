import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { concat, sha256 } from 'ethers';
import { exportAgentRecoveryBackup, importAgentRecoveryBackup } from './agent-recovery-backup';
import { encryptKeystore, saveKeystore } from './keystore';
import { generateAgentKeyPair } from './wallet';
import { withAgentHashRecoveryRecord, withAgentRecoveryMaterial } from './break-recovery-store';
import { recoverySigningRoot } from './recourse-hash-authorization';
import { tryAcquireFileLock } from './meter/file-lock';
const syncFault=vi.hoisted(()=>({fail:false,mutateNonce:false,paths:new Map<number,string>()}));
vi.mock('node:fs',async actual=>{const mod=await actual<typeof import('node:fs')>();return{...mod,readFileSync:(...args:Parameters<typeof mod.readFileSync>)=>{const value=mod.readFileSync(...args);const file=typeof args[0]==='number'?syncFault.paths.get(args[0]):String(args[0]);if(syncFault.mutateNonce&&file?.includes('/evm-nonces/')&&file.endsWith('/head')){syncFault.mutateNonce=false;mod.writeFileSync(file,'2',{mode:0o600});}return value;},openSync:(...args:Parameters<typeof mod.openSync>)=>{const fd=mod.openSync(...args);syncFault.paths.set(fd,String(args[0]));return fd;},closeSync:(fd:number)=>{syncFault.paths.delete(fd);mod.closeSync(fd);},fsyncSync:(fd:number)=>{const file=syncFault.paths.get(fd);if(syncFault.fail&&file?.includes('.provian-recovery-')&&file.endsWith('/break-recoveries')&&mod.readdirSync(file).length){syncFault.fail=false;throw Error('nested directory barrier failed');}mod.fsyncSync(fd);}};});
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`, a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const localPassphrase = 'a1'.repeat(32), backupPassphrase = 'separate off-device test passphrase';
let parent: string, directory: string, destination: string, restored: string;
const input = () => ({ directory, destination, localPassphrase, backupPassphrase });
beforeEach(() => {
  syncFault.fail=false;syncFault.mutateNonce=false;syncFault.paths.clear();
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-recovery-backup-')); directory = path.join(parent, 'source');
  destination = path.join(parent, 'backup.json'); restored = path.join(parent, 'restored'); fs.mkdirSync(directory, { mode: 0o700 });
  saveKeystore(encryptKeystore({ ...generateAgentKeyPair(), walletId: 'wallet_aw_backup', passphrase: localPassphrase,
    recoverySecret: '11'.repeat(32), kdfParams: { N: 1024, r: 8, p: 1, dklen: 32 } }), path.join(directory, 'agent-keystore.json'));
});
afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));
const write = (name: string, value: string) => { fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(directory, name), value, { mode: 0o600 }); };
test('roundtrip retains independent hash generations, active account, credentials and exact pending gas bytes under a separate secret', async () => {
  const locator = { identity: h(1), commitment: h(2), context: a(2) };
  const next = await withAgentHashRecoveryRecord({ directory, passphrase: localPassphrase, ...locator, create: true }, async (record, persist) => {
    record.destination = a(3); record.restoredTransaction = h(4); record.replacement = { nonce: 1, sourceAddress: a(1) };
    record.credentials = { requestId: h(5), apiKey: `pvn_live_${'ab'.repeat(16)}`, apiSecret: `pvns_${'cd'.repeat(32)}`, generation: 1 }; persist();
    const seed = Buffer.from(record.nextRecoverySigningSeed.slice(2), 'hex');
    try { return { secret: record.nextRecoverySecret, commitment: sha256(concat([record.nextRecoverySecret, await recoverySigningRoot(seed)])) }; }
    finally { seed.fill(0); }
  });
  write('pending-sweep.json', 'legacy pending rotation');write('legacy-sweep-complete.json','legacy completed rotation');
  write('active-hash-wallet.json', JSON.stringify({ ...locator, address: a(3), transactionHash: h(4) }));
  write('agent-credentials.json', JSON.stringify({ wallet_id: 'wallet_aw_backup', address: a(3), api_key: `pvn_live_${'ab'.repeat(16)}`, api_secret: `pvns_${'cd'.repeat(32)}` }));
  write(`evm-nonces/8453_${a(1)}/v1.json`, JSON.stringify({ rawSignedTransaction: 'pending exact gas transaction' }));
  write(`evm-nonces/8453_${a(1)}/head`, '1'); write(`hash-deliveries/${h(6).slice(2)}.json`, 'retained encrypted delivery bytes');
  await exportAgentRecoveryBackup(input()); const ciphertext = fs.readFileSync(destination, 'utf8');
  for (const secret of [localPassphrase, next.secret, 'pending exact gas transaction', 'pvns_', 'active-hash-wallet']) expect(ciphertext).not.toContain(secret);
  expect(await importAgentRecoveryBackup({ source: destination, directory: restored, backupPassphrase })).toEqual({ directory: restored, walletId: 'wallet_aw_backup' });
  expect(fs.readFileSync(path.join(restored, 'agent-keystore.secret'), 'utf8')).toBe(localPassphrase);
  for (const name of ['agent-keystore.json', 'active-hash-wallet.json', 'agent-credentials.json', 'pending-sweep.json', 'legacy-sweep-complete.json', `evm-nonces/8453_${a(1)}/v1.json`, `hash-deliveries/${h(6).slice(2)}.json`]) {
    expect(fs.readFileSync(path.join(restored, name))).toEqual(fs.readFileSync(path.join(directory, name))); expect(fs.statSync(path.join(restored, name)).mode & 0o777).toBe(0o600);
  }
  expect(await withAgentRecoveryMaterial({ directory: restored, passphrase: localPassphrase, identity: locator.identity, commitment: next.commitment }, async secret => `0x${Buffer.from(secret).toString('hex')}`)).toBe(next.secret);
});
test('wrong passphrases, changed ciphertext and existing wallets never install or overwrite state', async () => {
  await expect(exportAgentRecoveryBackup({ ...input(), localPassphrase: 'wrong local passphrase' })).rejects.toThrow(); expect(fs.existsSync(destination)).toBe(false);
  await exportAgentRecoveryBackup(input());
  await expect(importAgentRecoveryBackup({ source: destination, directory: restored, backupPassphrase: 'wrong backup passphrase' })).rejects.toThrow(); expect(fs.existsSync(restored)).toBe(false);
  const original = fs.readFileSync(destination, 'utf8'), envelope = JSON.parse(original); envelope.ciphertext = (envelope.ciphertext.startsWith('00') ? '01' : '00') + envelope.ciphertext.slice(2); fs.writeFileSync(destination, JSON.stringify(envelope), { mode: 0o600 });
  await expect(importAgentRecoveryBackup({ source: destination, directory: restored, backupPassphrase })).rejects.toThrow(); expect(fs.existsSync(restored)).toBe(false);
  fs.writeFileSync(destination, original, { mode: 0o600 }); fs.mkdirSync(restored, { mode: 0o700 }); fs.writeFileSync(path.join(restored, 'keep'), 'existing wallet');
  await expect(importAgentRecoveryBackup({ source: destination, directory: restored, backupPassphrase })).rejects.toThrow('destination_exists'); expect(fs.readFileSync(path.join(restored, 'keep'), 'utf8')).toBe('existing wallet');
});
test('export refuses active wallet transitions and symlinked private records', async () => {
  const release = tryAcquireFileLock(path.join(directory, 'rotation.lock'), { timeoutMs: 0, staleMs: 0, syncOnly: false })!;
  try { await expect(exportAgentRecoveryBackup(input())).rejects.toThrow('transition_in_progress'); } finally { release(); }
  write('recoveries/retained.json', 'saved'); const target = path.join(directory, 'recoveries/retained.json'); fs.unlinkSync(target); fs.symlinkSync(path.join(directory, 'agent-keystore.json'), target);
  await expect(exportAgentRecoveryBackup(input())).rejects.toThrow('symlink'); expect(fs.existsSync(destination)).toBe(false);
});
test('authenticated path traversal and forged curve headers are refused before creating a destination', async () => {
  await exportAgentRecoveryBackup(input()); const original = fs.readFileSync(destination, 'utf8');
  for (const variant of ['path', 'header', 'missing-hash-key']) {
    const envelope = JSON.parse(original), key = scryptSync(backupPassphrase, Buffer.from(envelope.salt, 'hex'), 32), aad = Buffer.from('provian.agent-recovery-backup/v1');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex')); decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'hex')), decipher.final()]).toString('utf8'));
      if (variant === 'path') payload.files['../escaped'] = Buffer.from('escape').toString('base64');
      else if(variant==='missing-hash-key')payload.files['active-hash-wallet.json']=Buffer.from(JSON.stringify({identity:h(1),commitment:h(2),context:a(2),address:a(3),transactionHash:h(4)})).toString('base64');
      else { const keystore = JSON.parse(Buffer.from(payload.files['agent-keystore.json'], 'base64').toString('utf8')); keystore.address = a(99); payload.files['agent-keystore.json'] = Buffer.from(JSON.stringify(keystore)).toString('base64'); }
      payload.files=Object.fromEntries(Object.entries(payload.files).sort(([a],[b])=>a.localeCompare(b)));
      const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex')); cipher.setAAD(aad);
      envelope.ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]).toString('hex'); envelope.tag = cipher.getAuthTag().toString('hex'); fs.writeFileSync(destination, JSON.stringify(envelope), { mode: 0o600 });
      await expect(importAgentRecoveryBackup({ source: destination, directory: restored, backupPassphrase })).rejects.toThrow(); expect(fs.existsSync(restored)).toBe(false); expect(fs.existsSync(path.join(parent, 'escaped'))).toBe(false);
    } finally { key.fill(0); }
  }
});

test('nested directory durability failure leaves the restored directory unpublished',async()=>{
 await withAgentHashRecoveryRecord({directory,passphrase:localPassphrase,identity:h(1),commitment:h(2),context:a(2),create:true},async()=>{});
 await exportAgentRecoveryBackup(input());syncFault.fail=true;
 await expect(importAgentRecoveryBackup({source:destination,directory:restored,backupPassphrase})).rejects.toThrow('nested directory barrier failed');
 expect(fs.existsSync(restored)).toBe(false);expect(fs.readdirSync(parent).some(name=>name.startsWith('.provian-recovery-'))).toBe(false);
 expect(await importAgentRecoveryBackup({source:destination,directory:restored,backupPassphrase})).toEqual({directory:restored,walletId:'wallet_aw_backup'});
});

test('an active hash locator needs its decryptable matching key record before export succeeds',async()=>{
 write('active-hash-wallet.json',JSON.stringify({identity:h(1),commitment:h(2),context:a(2),address:a(3),transactionHash:h(4)}));
 await expect(exportAgentRecoveryBackup(input())).rejects.toThrow('active_wallet_invalid');expect(fs.existsSync(destination)).toBe(false);
 await withAgentHashRecoveryRecord({directory,passphrase:localPassphrase,identity:h(1),commitment:h(2),context:a(2),create:true},async(record,persist)=>{record.destination=a(3);record.restoredTransaction=h(4);persist();});
 await exportAgentRecoveryBackup(input());const saved=fs.readFileSync(destination,'utf8');
 const record=path.join(directory,'break-recoveries',`${h(1).slice(2)}-${h(2).slice(2)}-${a(2).slice(2)}.json`),cipher=JSON.parse(fs.readFileSync(record,'utf8'));cipher.tag='00'.repeat(16);fs.writeFileSync(record,JSON.stringify(cipher),{mode:0o600});
 await expect(exportAgentRecoveryBackup(input())).rejects.toThrow();expect(fs.readFileSync(destination,'utf8')).toBe(saved);
});

test('a concurrent committed nonce change prevents exporting a mixed snapshot and preserves the preceding backup',async()=>{
 write(`evm-nonces/8453_${a(1)}/head`,'1');await exportAgentRecoveryBackup(input());const previous=fs.readFileSync(destination,'utf8');syncFault.mutateNonce=true;
 await expect(exportAgentRecoveryBackup(input())).rejects.toThrow('state_changed');expect(fs.readFileSync(destination,'utf8')).toBe(previous);
 await exportAgentRecoveryBackup(input());await importAgentRecoveryBackup({source:destination,directory:restored,backupPassphrase});
 expect(fs.readFileSync(path.join(restored,`evm-nonces/8453_${a(1)}/head`),'utf8')).toBe('2');
});
