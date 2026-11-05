import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVerify } from 'crypto';
import { generateAgentKeyPair, rotateKey } from './wallet';
import type { RotateKeyConfig } from './wallet';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Reconstruct the SPKI PEM the relay uses to verify a 64-byte uncompressed key. */
function spkiPem(publicKeyHex: string): string {
  const der = Buffer.concat([
    Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
    Buffer.from('04' + publicKeyHex, 'hex'),
  ]);
  const b64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

function verify(publicKeyHex: string, message: string, signatureHex: string): boolean {
  const v = createVerify('SHA256');
  v.update(message);
  return v.verify(spkiPem(publicKeyHex), Buffer.from(signatureHex, 'hex'));
}

describe('rotateKey (activation re-enabled)', () => {
  const oldKeyPair = generateAgentKeyPair();
  const newKeyPair = generateAgentKeyPair();
  const config: RotateKeyConfig = {
    relayUrl: 'https://api.provian.ai',
    walletId: 'wallet_aw_test-uuid',
    oldPrivateKey: oldKeyPair.privateKey,
    newPrivateKey: newKeyPair.privateKey,
    apiKey: 'pvn_live_abcdef1234567890',
    apiSecret: `pvns_${'a'.repeat(64)}`,
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  function okResponse() {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        wallet_id: config.walletId,
        old_address: oldKeyPair.address,
        new_address: newKeyPair.address,
        api_key: 'pvn_live_' + 'b'.repeat(32),
        api_secret: `pvns_${'b'.repeat(64)}`,
        rotated_at: 1_800_000_000_000,
      }),
    };
  }

  /** rotateKey first GETs /recovery-anchor. Route the two calls by URL. */
  function routeFetch(opts: {
    anchor?: unknown | (() => never);
    rotate: unknown | (() => never);
  }) {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/recovery-anchor')) {
        if (typeof opts.anchor === 'function') return (opts.anchor as () => never)();
        return opts.anchor ?? { ok: false, status: 404, json: async () => ({ error: 'no_recovery_escrow' }) };
      }
      if (typeof opts.rotate === 'function') return (opts.rotate as () => never)();
      return opts.rotate;
    });
  }

  /** The /rotate-key POST call among the (anchor, rotate) pair. */
  function rotateCall() {
    return mockFetch.mock.calls.find(([u]) => String(u).endsWith('/rotate-key'))!;
  }

  it('POSTs a dual-PoP rotation request and returns the new credentials', async () => {
    routeFetch({ rotate: okResponse() }); // anchor → 404 (no escrow), rotate → 200
    const result = await rotateKey(config);

    const [url, init] = rotateCall();
    expect(url).toBe(`https://api.provian.ai/v1/agent/wallet/${config.walletId}/rotate-key`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${config.apiKey}:${config.apiSecret}`);
    const body = JSON.parse(init.body);
    expect(body.new_address).toBe(newKeyPair.address);
    expect(body.new_public_key).toBe(newKeyPair.publicKey);
    expect(typeof body.timestamp).toBe('number');
    // No escrow existed (anchor GET → 404) → no re-escrow material sent.
    expect(body.sealed_key_blob).toBeUndefined();
    expect(body.recovery_anchor_pubkey).toBeUndefined();

    // The proofs verify over LOWERCASED addresses with the correct keys, and are
    // cross-bound (old key signs the NEW address, new key signs the OLD address).
    const oldMsg = `rotate:${config.walletId}:${newKeyPair.address.toLowerCase()}:${body.timestamp}`;
    const newMsg = `rotate:${config.walletId}:${oldKeyPair.address.toLowerCase()}:${body.timestamp}`;
    expect(verify(oldKeyPair.publicKey, oldMsg, body.proof_of_old_key)).toBe(true);
    expect(verify(newKeyPair.publicKey, newMsg, body.proof_of_new_key)).toBe(true);
    // Cross-check: the proofs do NOT verify against the swapped key/message.
    expect(verify(newKeyPair.publicKey, oldMsg, body.proof_of_old_key)).toBe(false);
    expect(verify(oldKeyPair.publicKey, newMsg, body.proof_of_new_key)).toBe(false);

    expect(result).toEqual({
      walletId: config.walletId,
      oldAddress: oldKeyPair.address,
      newAddress: newKeyPair.address,
      apiKey: 'pvn_live_' + 'b'.repeat(32),
      apiSecret: `pvns_${'b'.repeat(64)}`,
      rotatedAt: 1_800_000_000_000,
    });
  });

  it('re-seals the new key to the existing anchor and sends it atomically', async () => {
    // Use a REAL x25519 anchor so the sealed blob is well-formed; assert the
    // rotation carries a version-0x01 sealed blob to the SAME anchor.
    const { generateAnchorKeyPair, toB64u, openWithAnchor, fromB64u } = await import('./agent-key-recovery.js');
    const anchor = generateAnchorKeyPair();
    const anchorB64u = toB64u(anchor.publicKey);
    routeFetch({
      anchor: { ok: true, status: 200, json: async () => ({ recovery_anchor_pubkey: anchorB64u }) },
      rotate: okResponse(),
    });
    await rotateKey(config);
    const body = JSON.parse(rotateCall()[1].body);
    expect(body.recovery_anchor_pubkey).toBe(anchorB64u);
    expect(typeof body.sealed_key_blob).toBe('string');
    // The blob opens with the anchor secret back to the NEW private key — proving
    // the re-escrow is recoverable (RED implicit: a wrong key would not open it).
    const opened = openWithAnchor(anchor.secretKey, fromB64u(body.sealed_key_blob));
    expect(Buffer.from(opened).toString('hex')).toBe(newKeyPair.privateKey.replace(/^0x/, ''));
  });

  it('surfaces the relay reason on a non-ok response', async () => {
    routeFetch({
      rotate: {
        ok: false,
        status: 409,
        statusText: 'Conflict',
        text: async () => JSON.stringify({
          error: 'agent_wallet_key_rotation_conflict',
          reason: 'new_address_in_use',
        }),
      },
    });
    await expect(rotateKey(config)).rejects.toMatchObject({
      message: 'new_address_in_use',
      code: 'HTTP_409',
    });
  });

  it('raises a ConnectionError when the relay (rotate POST) is unreachable', async () => {
    routeFetch({ rotate: () => { throw new Error('ECONNREFUSED'); } });
    await expect(rotateKey(config)).rejects.toMatchObject({
      message: expect.stringContaining('Failed to reach relay'),
    });
  });
  it('retries a committed rotation after response loss with the staged credentials', async () => {
    const durableRotation = { rotationId:'rotation_12345678-1234-1234-1234-123456789abc', apiKey:'pvn_live_'+'c'.repeat(32), apiSecret:'pvns_'+'d'.repeat(64) };
    let committed=false, cuts=0;
    const auth: string[]=[];
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/recovery-anchor')) return {ok:false,status:404};
      const credential = (init!.headers as Record<string,string>).Authorization;
      auth.push(credential);
      if (!committed && credential === `Bearer ${durableRotation.apiKey}:${durableRotation.apiSecret}`) return {ok:false,status:401};
      if (!committed) { committed=true;cuts++;throw new Error('response lost'); }
      return {ok:true,status:200,json:async()=>({wallet_id:config.walletId,old_address:oldKeyPair.address,new_address:newKeyPair.address,api_key:durableRotation.apiKey,api_secret:durableRotation.apiSecret,rotated_at:123})};
    });
    await expect(rotateKey({...config,durableRotation})).rejects.toThrow('response lost');
    const result=await rotateKey({...config,durableRotation});
    expect(result.apiKey).toBe(durableRotation.apiKey);expect(cuts).toBe(1);
    expect(auth).toEqual([`Bearer ${durableRotation.apiKey}:${durableRotation.apiSecret}`,`Bearer ${config.apiKey}:${config.apiSecret}`,`Bearer ${durableRotation.apiKey}:${durableRotation.apiSecret}`]);
  });

});
