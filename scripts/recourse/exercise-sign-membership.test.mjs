import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { exerciseMembershipChallenge, verifyExerciseMembershipSignature } from './exercise-membership.mjs';
import { signExerciseMembership } from './exercise-sign-membership.mjs';
test('agent exports only an isolated approve-once signature and refuses live-chain challenges before key access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'exercise-membership-sign-')), key = new Wallet('0x' + '11'.repeat(32));
  const input = join(directory, 'challenge.json'), output = join(directory, 'signature.json'), marker = join(directory, 'key-access');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(directory, 'keystore.js'), `import{writeFileSync}from'node:fs';export function loadKeystore(){writeFileSync(${JSON.stringify(marker)},'test');return{}};export function decryptKeystore(){return{privateKey:${JSON.stringify(key.privateKey)}}}`);
  writeFileSync(join(directory, 'local-keystore-secret.js'), 'export function readLocalKeystoreSecret(){return "TEST ONLY"}');
  const challenge = exerciseMembershipChallenge({ chainId: '31337', pointer: '0x' + '22'.repeat(20), kernel: '0x' + '33'.repeat(20), pool: '0x' + '44'.repeat(20) },
    'setStandingConsent', {consent:{binding:'0x'+'55'.repeat(32),account:key.address.toLowerCase(),nonce:'0',joined:true,
      revision:'1',ruleHash:'0x'+'66'.repeat(32),expiresAt:'1900000000'},fixedChargePayer:true,
      burnLimit:'100000000000000000000',reserveLimit:'100000000000000000000',earningsBpsLimit:100,
      exitCommitment:'0x'+'77'.repeat(32),exitSalt:'0x'+'88'.repeat(32),admissionMonth:'1',rejoinPayments:[]});
  try {
    writeFileSync(input, JSON.stringify({ ...challenge, domain: { ...challenge.domain, chainId: '8453' } }));
    await expect(signExerciseMembership(input, output, directory)).rejects.toThrow('wrong_chain'); expect(existsSync(marker)).toBe(false);
    writeFileSync(input, JSON.stringify(challenge));
    expect(await signExerciseMembership(input, output, directory)).toEqual({ address: key.address.toLowerCase(), chainId: 31337, method: 'setStandingConsent' });
    const text = readFileSync(output, 'utf8'), result = JSON.parse(text);
    expect(text).not.toContain(key.privateKey); expect(verifyExerciseMembershipSignature(result.challenge, result.ownerSignature)).toBe(result.ownerSignature);
    await expect(signExerciseMembership(input, output, directory)).rejects.toThrow('EEXIST');
    const linked = join(directory, 'linked-signer.mjs'), cliOutput = join(directory, 'cli-signature.json');
    symlinkSync(fileURLToPath(new URL('./exercise-sign-membership.mjs', import.meta.url)), linked);
    execFileSync(process.execPath, [linked, input, cliOutput, directory], { stdio: 'pipe' });
    const cli = JSON.parse(readFileSync(cliOutput, 'utf8'));
    expect(verifyExerciseMembershipSignature(cli.challenge, cli.ownerSignature)).toBe(cli.ownerSignature);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
