import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runRotateKeyFlow, defaultRotateKeyFlowDeps, type RotationJournal, type RotateKeyFlowDeps, type PendingSweep } from './rotate-key-flow';
import { encryptKeystore, decryptKeystore, loadKeystore, saveKeystore } from './keystore';
import { generateAgentKeyPair, type RotateKeyConfig, type RotateKeyResult } from './wallet';
import { deriveSolanaAddress, deriveSolanaEd25519Seed } from './chains';
import { createHash } from 'crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { writeRotationJournal, readRotationJournal } from './rotation-journal';
import { exportRetiredKeystore } from './retired-keystore';
import { atomicReplacePrivateFile } from './durable-private-file';
import type { SweepResult } from './sweep';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const SECRET = 'a'.repeat(64);
const URL = 'https://relay.example';
function fixture(swept: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-proof-')); dirs.push(dir);
  const old = generateAgentKeyPair(), next = generateAgentKeyPair();
  const walletId = 'wallet_aw_fixture';
  const oldKs = encryptKeystore({ privateKey: old.privateKey, publicKey: old.publicKey, address: old.address, walletId, passphrase: SECRET, kdfParams: {N:1024,r:8,p:1,dklen:32} });
  const keyFile = path.join(dir, 'agent-keystore.json'), journalFile = path.join(dir, 'journal.json');
  saveKeystore(oldKs, keyFile);
  let remote: RotateKeyResult | undefined;
  let cuts = 0, credentials = 'old', cleared = false;
  const calls: string[] = [];
  const sweep: SweepResult = swept ? { swept:true,token:'PVT',chain:'base',oldAddress:old.address,newAddress:next.address,amountAtomic:'1000',hash:'0xfixture' }
    : { swept:false,reason:'nothing_to_sweep',token:'PVT',chain:'base',oldAddress:old.address };
  const rotate = async (config: RotateKeyConfig): Promise<RotateKeyResult> => {
    calls.push('remote');
    // This is checked BEFORE any fixture remote identity transition.
    const staged = readRotationJournal(journalFile, SECRET);
    expect(staged?.config.newPrivateKey).toBe(config.newPrivateKey);
    expect(staged?.config.oldPrivateKey).toBe(old.privateKey);
    if (!remote) {
      cuts++;
      remote = { walletId, oldAddress:old.address, newAddress:next.address,
        apiKey:config.durableRotation!.apiKey, apiSecret:config.durableRotation!.apiSecret, rotatedAt:1 };
    }
    return remote;
  };
  const deps: RotateKeyFlowDeps & Record<string, unknown> = {
    loadIdentity: () => ({ walletId, apiKey:'pvn_live_'+'1'.repeat(32),apiSecret:'pvns_'+'1'.repeat(64),oldKeystore:oldKs,withOldKey:async fn=>fn(old.privateKey) }),
    generateNewKey: vi.fn(() => next),
    loadJournal: () => readRotationJournal(journalFile, SECRET),
    saveJournal(journal) { calls.push('journal'); writeRotationJournal(journalFile, journal, SECRET); },
    rotate,
    persistNewKey(params) { calls.push('new-key'); saveKeystore(encryptKeystore({ ...params, passphrase:SECRET,kdfParams:{N:1024,r:8,p:1,dklen:32} }), keyFile); },
    rotateCredentials() { calls.push('credentials'); credentials='new'; },
    sweepPending: async () => sweep,
    log: () => undefined,
    // Legacy orchestration boundary for the baseline failing controls: old code
    // reaches its real discard/overwrite branches, rather than a missing mock.
    rotateAndSweep: async (config: RotateKeyConfig) => { cuts++; return {walletId,oldAddress:old.address,newAddress:next.address,apiKey:'pvn_live_'+'2'.repeat(32),apiSecret:'pvns_'+'2'.repeat(64),rotatedAt:1,sweep}; },
    loadPending: () => null,
    savePending: () => undefined,
    clearPending: () => { cleared=true; },
  };
  const prove = () => {
    const journal = readRotationJournal(journalFile, SECRET)!;
    expect(journal).toBeTruthy();
    expect(decryptKeystore(journal.oldKeystore, SECRET).privateKey).toBe(old.privateKey);
    expect(journal.config.newPrivateKey).toBe(next.privateKey);
    expect(deriveSolanaAddress(journal.config.oldPrivateKey)).toBe(old.chainAddresses.solana);
    expect(decryptKeystore(loadKeystore(keyFile)!, SECRET).privateKey).toBe(next.privateKey);
    const ciphertext = fs.readFileSync(journalFile, 'utf8');
    expect(ciphertext).not.toContain(old.privateKey); expect(ciphertext).not.toContain(next.privateKey);
    expect(cleared).toBe(false); expect(credentials).toBe('new'); expect(cuts).toBe(1);
  };
  return { dir, old, next, deps, calls, prove, rotate, journalFile, get cuts() {return cuts;} };
}

describe('rotation asset retention and restart proofs', () => {
  it.each([false,true])('keeps both keys with zero-PVT/nonzero-USDC or swept-PVT/nonzero-ETH (swept=%s)', async swept => {
    const f = fixture(swept);
    // Fixture ledger includes every supported key family. No RPC or real funds.
    const assets = {PVT:swept ? 1000n : 0n, USDC:12n, ETH:3n, DAI:1n, SOL:4n, SPL_USDC:5n};
    await runRotateKeyFlow({relayUrl:URL}, f.deps);
    f.prove();
    expect(f.calls.indexOf('journal')).toBeLessThan(f.calls.indexOf('remote'));
    await runRotateKeyFlow({relayUrl:URL}, {...f.deps});
    f.prove();
    const recovered=decryptKeystore(readRotationJournal(f.journalFile,SECRET)!.oldKeystore,SECRET);
    for (const [asset,balance] of Object.entries(assets)) {
      if (balance===0n) continue;
      // Fresh fixture ownership challenges, never transactions or broadcasts.
      // Retained keys must still SIGN for the original asset owner on both chains.
      const challenge=createHash('sha256').update(`fixture:${asset}:${balance}`).digest();
      if (asset==='SOL' || asset==='SPL_USDC') {
        const seed=deriveSolanaEd25519Seed(recovered.privateKey);
        expect(ed25519.verify(ed25519.sign(challenge,seed),challenge,ed25519.getPublicKey(deriveSolanaEd25519Seed(f.old.privateKey)))).toBe(true);
      } else {
        const signature=secp256k1.sign(challenge,recovered.privateKey);
        expect(secp256k1.verify(signature.toCompactRawBytes(),challenge,Buffer.from(`04${f.old.publicKey}`,'hex'))).toBe(true);
      }
    }
  });
  it.each(['before-cut','after-cut','new-key','credentials','journal-result','journal-installed','sweep'])('restarts after crash/write failure at %s without a second rotation', async boundary => {
    const f = fixture(false);
    const deps = {...f.deps};
    if (boundary === 'before-cut') deps.rotate = async () => {throw new Error('crash');};
    if (boundary === 'after-cut') deps.rotate = async config => {await f.rotate(config);throw new Error('crash');};
    if (boundary === 'new-key') { const install=deps.persistNewKey; deps.persistNewKey=p=>{install(p);throw new Error('crash');}; }
    if (boundary === 'credentials') { const install=deps.rotateCredentials; deps.rotateCredentials=p=>{install(p);throw new Error('crash');}; }
    if (boundary.startsWith('journal-')) { const save=deps.saveJournal; deps.saveJournal=j=>{if (boundary==='journal-result' ? !!j.result : j.installed) throw new Error('crash'); save(j);}; }
    if (boundary==='sweep') deps.sweepPending=async()=>{throw new Error('crash');};
    // Baseline control for the precise original crash window.
    if (boundary==='new-key') deps.rotateCredentials=()=>{throw new Error('crash');};
    await expect(runRotateKeyFlow({relayUrl:URL},deps)).rejects.toThrow('crash');
    const staged = readRotationJournal(f.journalFile, SECRET);
    expect(staged?.config.oldPrivateKey).toBe(f.old.privateKey);
    expect(staged?.config.newPrivateKey).toBe(f.next.privateKey);
    await runRotateKeyFlow({relayUrl:URL},{...f.deps});
    f.prove(); expect(f.deps.generateNewKey).toHaveBeenCalledTimes(1);
  });
  it('a journal write failure prevents the first remote cut', async () => {
    const f=fixture(false); f.deps.saveJournal=()=>{throw new Error('disk full');};
    await expect(runRotateKeyFlow({relayUrl:URL},f.deps)).rejects.toThrow('disk full');
    expect(f.cuts).toBe(0);
  });
  it('corruption fails closed instead of rotating again', async () => {
    const f=fixture(false); await runRotateKeyFlow({relayUrl:URL},f.deps);
    fs.writeFileSync(f.journalFile,'{}');
    await expect(runRotateKeyFlow({relayUrl:URL},f.deps)).rejects.toThrow(); expect(f.cuts).toBe(1);
  });
});

it('production filesystem deps preserve encrypted archives and recover a failed credential install', async () => {
  const f=fixture(false);
  fs.writeFileSync(path.join(f.dir,'agent-keystore.secret'),SECRET,{mode:0o600});
  atomicReplacePrivateFile(path.join(f.dir,'agent-credentials.json'),JSON.stringify({wallet_id:'wallet_aw_fixture',address:f.old.address,api_key:'pvn_live_'+'1'.repeat(32),api_secret:'pvns_'+'1'.repeat(64)}));
  const deps=defaultRotateKeyFlowDeps(f.dir);
  deps.generateNewKey=()=>f.next;
  let cuts=0;
  deps.rotate=async config=>{cuts++;return {walletId:config.walletId,oldAddress:f.old.address,newAddress:f.next.address,apiKey:config.durableRotation!.apiKey,apiSecret:config.durableRotation!.apiSecret,rotatedAt:1};};
  deps.sweepPending=async()=>({swept:false,reason:'nothing_to_sweep',token:'PVT',chain:'base',oldAddress:f.old.address}); deps.log=()=>undefined;
  await expect(runRotateKeyFlow({relayUrl:URL},{...deps,rotateCredentials(){throw new Error('write failure');}})).rejects.toThrow('write failure');
  await runRotateKeyFlow({relayUrl:URL},deps);
  expect(cuts).toBe(1);
  expect(fs.readdirSync(path.join(f.dir,'rotations'))).toHaveLength(1);
  const journal=deps.loadJournal()!;
  expect(decryptKeystore(journal.oldKeystore,SECRET).privateKey).toBe(f.old.privateKey);
  expect(decryptKeystore(loadKeystore(path.join(f.dir,'agent-keystore.json'))!,SECRET).privateKey).toBe(f.next.privateKey);
  expect(JSON.parse(fs.readFileSync(path.join(f.dir,'agent-credentials.json'),'utf8')).api_key).toBe(journal.result!.apiKey);
  expect(fs.statSync(path.join(f.dir,'rotation-journal.json')).mode & 0o777).toBe(0o600);
  const exportPath = path.join(os.tmpdir(), `${path.basename(f.dir)}-retired.json`);
  try {
    exportRetiredKeystore(exportPath, journal.config.durableRotation.rotationId, f.dir);
    const recovered = decryptKeystore(loadKeystore(exportPath)!, SECRET);
    expect(recovered.privateKey).toBe(f.old.privateKey);
    expect(deriveSolanaAddress(recovered.privateKey)).toBe(f.old.chainAddresses.solana);
  } finally { fs.rmSync(exportPath,{force:true}); }
  expect(() => exportRetiredKeystore(path.join(f.dir,'agent-keystore.json'),undefined,f.dir)).toThrow('outside');
});

it('retired export refuses a symlink parent into the live wallet and existing files', async () => {
  const f=fixture(false);fs.writeFileSync(path.join(f.dir,'agent-keystore.secret'),SECRET,{mode:0o600});
  await runRotateKeyFlow({relayUrl:URL},f.deps);
  const journal=readRotationJournal(f.journalFile,SECRET)!;
  writeRotationJournal(path.join(f.dir,'rotation-journal.json'),journal,SECRET);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'rotation-export-'));dirs.push(outside);
  fs.symlinkSync(f.dir,path.join(outside,'alias'));
  expect(()=>exportRetiredKeystore(path.join(outside,'alias','agent-keystore.secret'),undefined,f.dir)).toThrow('outside');
  expect(fs.readFileSync(path.join(f.dir,'agent-keystore.secret'),'utf8')).toBe(SECRET);
  const dest=path.join(outside,'keep');fs.writeFileSync(dest,'preserve');
  expect(()=>exportRetiredKeystore(dest,undefined,f.dir)).toThrow();expect(fs.readFileSync(dest,'utf8')).toBe('preserve');
});
it('legacy sweep completion retains its key and permits a later explicit rotation', async () => {
  const f=fixture(false);let pending: PendingSweep | null={walletId:'wallet_aw_fixture',oldAddress:f.old.address,newAddress:f.next.address};
  const deps={...f.deps,loadLegacyPending:()=>pending,completeLegacyPending:()=>{pending=null;}};
  const first=await runRotateKeyFlow({relayUrl:URL},deps);expect(first.resumed).toBe(true);expect(f.cuts).toBe(0);
  expect(pending).toBe(null);
  await runRotateKeyFlow({relayUrl:URL,newRotation:true},deps);f.prove();
});
