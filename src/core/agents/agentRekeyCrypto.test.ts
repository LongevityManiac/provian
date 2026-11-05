/**
 * the phone's recovery re-key crypto.
 *
 * The load-bearing property: a PoP signed on the phone must VERIFY under the
 * relay's exact verifier (Node `crypto.createVerify('SHA256')` over an SPKI built
 * from the 128-hex uncompressed key). This test reconstructs that verifier here
 * so a drift in the phone's signing shape fails RED — the relay would 401 the
 * re-key otherwise. Every positive assertion has its RED control.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { ethers } from 'ethers';
import {
  generateAgentKeyPair,
  signRecoveryRekeyPoP,
  recoveryRekeyMessage,
  buildAgentRekeyCommand,
} from './agentRekeyCrypto';

/** The relay's SPKI construction (uncompressedHexToSpkiPem), copied to bind the
 *  test to the WIRE contract rather than to the module's own helper. */
function spkiPem(publicKeyHex: string): string {
  const cleaned = publicKeyHex.toLowerCase().replace(/^0x/, '').replace(/^04/, '');
  const pubKeyBytes = Buffer.from('04' + cleaned, 'hex');
  const header = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');
  const b64 = Buffer.concat([header, pubKeyBytes]).toString('base64');
  const wrapped = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

function relayVerify(publicKeyHex: string, message: string, sigHex: string): boolean {
  try {
    const v = crypto.createVerify('SHA256');
    v.update(message);
    return v.verify(spkiPem(publicKeyHex), Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

describe('agentRekeyCrypto', () => {
  it('generates a keypair whose address matches ethers-derived and whose pubkey is 128 hex', async () => {
    const kp = await generateAgentKeyPair();
    expect(kp.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{128}$/);
    expect(kp.address).toBe(ethers.computeAddress(`0x04${kp.publicKeyHex}`).toLowerCase());
    expect(kp.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('signs a PoP the RELAY verifier accepts; RED: a tampered message is rejected', async () => {
    const kp = await generateAgentKeyPair();
    const ts = 1_800_000_000_000;
    const message = recoveryRekeyMessage('wallet_aw_x', kp.address, ts);
    const sig = await signRecoveryRekeyPoP(kp.privateKeyHex, message);

    expect(relayVerify(kp.publicKeyHex, message, sig)).toBe(true);

    // RED control: the same signature against a DIFFERENT message (a re-key to a
    // different address / timestamp) must fail — the proof is bound to the message.
    const tampered = recoveryRekeyMessage('wallet_aw_x', kp.address, ts + 1);
    expect(relayVerify(kp.publicKeyHex, tampered, sig)).toBe(false);

    // RED control: a DIFFERENT key's signature over the right message fails.
    const other = await generateAgentKeyPair();
    const otherSig = await signRecoveryRekeyPoP(other.privateKeyHex, message);
    expect(relayVerify(kp.publicKeyHex, message, otherSig)).toBe(false);
  });

  it('recoveryRekeyMessage lowercases the address (byte-match with the relay)', () => {
    expect(recoveryRekeyMessage('w', '0xAbC0000000000000000000000000000000000000', 5))
      .toBe('recovery-rekey:w:0xabc0000000000000000000000000000000000000:5');
  });

  it('buildAgentRekeyCommand : KEYLESS interactive command + payload separately', () => {
    const { command, payload } = buildAgentRekeyCommand({
      walletId: 'wallet_aw_x', privateKeyHex: 'a'.repeat(64),
      apiKey: 'pvn_live_0123456789abcde', apiSecret: 'pvns_secret', relayUrl: 'https://api.example/',
    });
    expect(command).toContain('PROVIAN_WALLET_ID=wallet_aw_x');
    expect(command).toContain('node /tmp/provian-restore.js restore-wallet');
    expect(command).toContain('https://api.example/v1/bootstrap/agent.js'); // trailing slash trimmed
    // Interactive: NO heredoc / --from-stdin.
    expect(command).not.toContain('--from-stdin');
    expect(command).not.toContain("<<'PROVIAN_RESTORE'");
    // The payload (key + creds) rides SEPARATELY.
    expect(payload).toContain('"private_key":"' + 'a'.repeat(64) + '"');
    expect(payload).toContain('"api_key":"pvn_live_0123456789abcde"');
  });

  it('RED CONTROL: neither the key NOR the api secret may appear in the command', () => {
    const { command } = buildAgentRekeyCommand({
      walletId: 'wallet_aw_x', privateKeyHex: 'b'.repeat(64),
      apiKey: 'pvn_live_0123456789abcde', apiSecret: 'pvns_supersecret', relayUrl: 'https://api.example',
    });
    expect(command).not.toContain('b'.repeat(64));
    expect(command).not.toContain('pvns_supersecret');
    expect(command).not.toContain('private_key');
  });
});
