import { beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { generateKeyPairSigner, getBase58Decoder, signBytes, type KeyPairSigner } from '@solana/kit';
import { registerSeller, registrationMessage, RegistrationError, profileSchema, type SellerProfile, canonicalJson } from './sellers.js';
import { MemoryStore } from './store.js';

const verifyEvm = (address: `0x${string}`, message: string, signature: `0x${string}`) => verifyMessage({ address, message, signature });

const profile: SellerProfile = profileSchema.parse({
  display_name: 'Weather API',
  description: 'Forecasts by the minute',
  resource_urls: ['https://api.example.com/weather'],
  pvt_prices: [{ resource: '/weather', amount_atomic: '2000000000000000000' }],
});

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
});

async function evmBody(overrides: Partial<{ nonce: string; issued: number; profile: SellerProfile; signWith: `0x${string}`; address: string }> = {}) {
  const key = overrides.signWith ?? generatePrivateKey();
  const account = privateKeyToAccount(key);
  const address = overrides.address ?? account.address;
  const nonce = overrides.nonce ?? 'nonce-abcdef12';
  const issued = overrides.issued ?? Date.now();
  const signedProfile = overrides.profile ?? profile;
  const signature = await account.signMessage({ message: registrationMessage('base', address, signedProfile, nonce, issued) });
  return { chain: 'base' as const, address, profile, nonce, issued_at_ms: issued, signature };
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof RegistrationError && e.code === code);
}

describe('seller registration — identity by wallet signature', () => {
  it('EVM: a seller signing the canonical message registers; PVT prices stay PVT amounts', async () => {
    const body = await evmBody();
    const s = await registerSeller(body, { store, verifyEvm, now: () => Date.now() });
    expect(s.seller_id).toBe(`base:${body.address.toLowerCase()}`);
    expect(s.pvt_prices).toEqual([{ resource: '/weather', amount_atomic: '2000000000000000000' }]);
    expect(s.status).toBe('active');
  });

  it('RED: a signature from a different key is refused', async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const body = await evmBody({ address: other.address });
    await expectCode(registerSeller(body, { store, verifyEvm, now: () => Date.now() }), 'invalid_signature');
    expect(store.sellers.size).toBe(0);
  });

  it('RED: a profile other than the one signed is refused (the profile hash is in the message)', async () => {
    const body = await evmBody({ profile: { ...profile, display_name: 'Something else' } });
    await expectCode(registerSeller(body, { store, verifyEvm, now: () => Date.now() }), 'invalid_signature');
  });

  it('RED: outside ±5 minutes is refused', async () => {
    const body = await evmBody({ issued: Date.now() - 6 * 60_000 });
    await expectCode(registerSeller(body, { store, verifyEvm, now: () => Date.now() }), 'registration_expired');
  });

  it('RED: a nonce is single-use', async () => {
    const key = generatePrivateKey();
    const body = await evmBody({ signWith: key });
    await registerSeller(body, { store, verifyEvm, now: () => Date.now() });
    await expectCode(registerSeller(body, { store, verifyEvm, now: () => Date.now() }), 'nonce_reused');
  });

  it('RED: non-https resource URLs and unknown fields are refused', async () => {
    const body = await evmBody();
    await expectCode(
      registerSeller({ ...body, profile: { ...profile, resource_urls: ['http://insecure.example.com'] } }, { store, verifyEvm, now: () => Date.now() }),
      'invalid_registration',
    );
    await expectCode(registerSeller({ ...body, extra_field: 1 }, { store, verifyEvm, now: () => Date.now() }), 'invalid_registration');
  });

  it('re-registration updates the profile but cannot lift a suspension', async () => {
    const key = generatePrivateKey();
    const s = await registerSeller(await evmBody({ signWith: key }), { store, verifyEvm, now: () => Date.now() });
    await store.suspendSeller(s.seller_id);
    const again = await registerSeller(await evmBody({ signWith: key, nonce: 'nonce-second-1' }), { store, verifyEvm, now: () => Date.now() });
    expect(again.status).toBe('suspended');
  });

  describe('Solana (ed25519)', () => {
    let kp: KeyPairSigner;
    beforeEach(async () => {
      kp = await generateKeyPairSigner();
    });
    async function solBody(p: SellerProfile, signer: KeyPairSigner = kp) {
      const issued = Date.now();
      const msg = registrationMessage('solana', kp.address, p, 'sol-nonce-1', issued);
      const sig = await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(msg));
      return { chain: 'solana' as const, address: kp.address, profile: p, nonce: 'sol-nonce-1', issued_at_ms: issued, signature: getBase58Decoder().decode(sig) };
    }
    const solProfile = profileSchema.parse({ display_name: 'Sol seller' });

    it('registers with an ed25519 signature over the same canonical message', async () => {
      const s = await registerSeller(await solBody(solProfile), { store, verifyEvm: null, now: () => Date.now() });
      expect(s.seller_id).toBe(`solana:${kp.address}`);
    });

    it('RED: a signature by another key is refused', async () => {
      const other = await generateKeyPairSigner();
      await expectCode(registerSeller(await solBody(solProfile, other), { store, verifyEvm: null, now: () => Date.now() }), 'invalid_signature');
    });

    it('RED: PVT prices on Solana are refused (PVT lives on Base)', async () => {
      const p = profileSchema.parse({ display_name: 'x', pvt_prices: [{ resource: '/a', amount_atomic: '1' }] });
      await expectCode(registerSeller(await solBody(p), { store, verifyEvm: null, now: () => Date.now() }), 'pvt_prices_base_only');
    });
  });

  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});
