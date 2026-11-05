/**
 * The app proves its OWN Solana address (SLIP-0010 m/44'/501'/0'/0' of the BIP-39 seed) to the
 * relay: signs exactly the relay's proof message with that key, refuses anything else unsigned,
 * never prompts (signs only inside a live session), and records a non-sensitive flag so it is done
 * once per wallet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { mnemonicToSeedSync } from '@scure/bip39';
import { slip10DeriveEd25519Seed } from './slip10';
import { buildSolanaProofMessage, SOLANA_PROOF_MESSAGE_HEADER } from './solanaProofMessage';
import {
    ensureSolanaAddressProvenWith,
    resetSolanaProofStateForTests,
    solanaProofFlagKey,
    type SolanaProofAppDeps,
} from './solanaAddressProof';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const EVM = '0xAbCd000000000000000000000000000000000001';
const NONCE = '0123456789abcdef0123456789abcdef';
const ISSUED = Date.UTC(2026, 9, 4, 12, 0, 0);
const NOW = ISSUED + 1_000;

function walletSeed(): Uint8Array {
    return slip10DeriveEd25519Seed(mnemonicToSeedSync(MNEMONIC), "m/44'/501'/0'/0'");
}
const SOL = bs58.encode(ed25519.getPublicKey(walletSeed()));

function canonical(address: string = SOL, subjectLine = 'person: user_7'): string {
    return buildSolanaProofMessage({
        subjectLine, address, nonce: NONCE,
        issuedIso: new Date(ISSUED).toISOString(), expiresIso: new Date(ISSUED + 600_000).toISOString(),
    });
}

interface Harness {
    deps: SolanaProofAppDeps;
    store: Map<string, string>;
    seeds: Uint8Array[];
    verifyBodies: Array<{ address: string; challengeId: string; signature: string; origin: 'native' }>;
    spies: { list: ReturnType<typeof vi.fn>; challenge: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn>; solanaSeed: ReturnType<typeof vi.fn> };
}

function harness(opts: {
    message?: string;
    session?: boolean;
    proven?: string[] | null;
    verify?: (body: { address: string }) => { ok: true; provenAddress: string; alreadyProven: boolean } | { ok: false; status: number; error: string };
    seed?: () => Uint8Array;
} = {}): Harness {
    const store = new Map<string, string>();
    const seeds: Uint8Array[] = [];
    const verifyBodies: Harness['verifyBodies'] = [];
    const list = vi.fn(async () => (opts.proven === undefined ? [] : opts.proven));
    const challenge = vi.fn(async (_address: string) => ({
        ok: true as const,
        challenge: { challengeId: '7d2b1a8e-1111-4c4c-8a8a-0123456789ab', message: opts.message ?? canonical(), nonce: NONCE, issuedAt: ISSUED, expiresAt: ISSUED + 600_000 },
    }));
    const verify = vi.fn(async (body: { address: string; challengeId: string; signature: string; origin: 'native' }) => {
        verifyBodies.push(body);
        return opts.verify ? opts.verify(body) : { ok: true as const, provenAddress: body.address, alreadyProven: false };
    });
    const solanaSeed = vi.fn(async () => {
        const s = (opts.seed ?? walletSeed)();
        seeds.push(s);
        return s;
    });
    const deps: SolanaProofAppDeps = {
        kv: {
            async getItem(k) { return store.get(k) ?? null; },
            async setItem(k, v) { store.set(k, v); },
        },
        walletAddress: async () => EVM,
        solanaAddress: async () => SOL,
        sessionValid: async () => opts.session ?? true,
        solanaSeed,
        relay: { ready: async () => true, list, challenge, verify },
        now: () => NOW,
    };
    return { deps, store, seeds, verifyBodies, spies: { list, challenge, verify, solanaSeed } };
}

beforeEach(() => resetSolanaProofStateForTests());

describe('ensureSolanaAddressProven — the wallet\'s own Solana key', () => {
    it('signs EXACTLY the relay message with the m/44\'/501\'/0\'/0\' key; the signature verifies; the flag is set', async () => {
        const h = harness();
        await expect(ensureSolanaAddressProvenWith(h.deps)).resolves.toBe('proven');
        expect(h.spies.challenge).toHaveBeenCalledWith(SOL);
        expect(h.verifyBodies).toHaveLength(1);
        const body = h.verifyBodies[0];
        expect(body).toMatchObject({ address: SOL, origin: 'native', challengeId: '7d2b1a8e-1111-4c4c-8a8a-0123456789ab' });
        const sig = bs58.decode(body.signature);
        expect(ed25519.verify(sig, new TextEncoder().encode(canonical()), bs58.decode(SOL))).toBe(true);
        // RED control on the assertion: it does not verify a different message.
        expect(ed25519.verify(sig, new TextEncoder().encode(canonical(SOL, 'person: user_8')), bs58.decode(SOL))).toBe(false);
        // The key never outlives the function: the seed handed out is wiped.
        expect(h.seeds).toHaveLength(1);
        expect(h.seeds[0].every((b) => b === 0)).toBe(true);
        // Only the PUBLIC Solana address is stored, keyed by the EVM wallet address.
        expect([...h.store.entries()]).toEqual([[solanaProofFlagKey(EVM), SOL]]);
    });

    it('idempotent: once flagged, a later call touches neither the relay nor the key', async () => {
        const h = harness();
        await ensureSolanaAddressProvenWith(h.deps);
        h.spies.list.mockClear();
        await expect(ensureSolanaAddressProvenWith(h.deps)).resolves.toBe('already_proven');
        expect(h.spies.list).not.toHaveBeenCalled();
        expect(h.spies.solanaSeed).toHaveBeenCalledTimes(1);
    });

    it('a binding the relay already holds (reinstall / another device) is recorded without signing', async () => {
        const h = harness({ proven: [SOL] });
        await expect(ensureSolanaAddressProvenWith(h.deps)).resolves.toBe('already_proven');
        expect(h.spies.solanaSeed).not.toHaveBeenCalled();
        expect(h.spies.challenge).not.toHaveBeenCalled();
        expect(h.store.get(solanaProofFlagKey(EVM))).toBe(SOL);
    });

    it('NEVER prompts: with no live session it defers without touching the key, and later ticks skip the network', async () => {
        const h = harness({ session: false });
        await expect(ensureSolanaAddressProvenWith(h.deps)).resolves.toBe('deferred_no_session');
        await expect(ensureSolanaAddressProvenWith(h.deps)).resolves.toBe('deferred_no_session');
        expect(h.spies.solanaSeed).not.toHaveBeenCalled();
        expect(h.spies.challenge).not.toHaveBeenCalled();
        expect(h.spies.list).toHaveBeenCalledTimes(1);
        expect(h.store.size).toBe(0);
    });

    const REFUSED: Array<[string, string]> = [
        ['another address', canonical('DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2')],
        ['an agent subject line', canonical(SOL, 'agent: agent-1')],
        ['the EVM proof header (wrong first line)', canonical().replace(SOLANA_PROOF_MESSAGE_HEADER, 'Provian proof of control')],
        ['an extra line', `${canonical()}\nnote: hi`],
        ['an arbitrary string', 'Approve transfer of everything'],
    ];
    for (const [name, message] of REFUSED) {
        it(`REFUSES without signing: ${name}`, async () => {
            const h = harness({ message });
            await expect(ensureSolanaAddressProvenWith(h.deps)).resolves.toBe('refused_message');
            expect(h.spies.solanaSeed).not.toHaveBeenCalled();
            expect(h.spies.verify).not.toHaveBeenCalled();
            expect(h.store.size).toBe(0);
        });
    }

    it('a key that does not derive the address is never used to submit', async () => {
        const h = harness({ seed: () => new Uint8Array(32).fill(7) });
        await expect(ensureSolanaAddressProvenWith(h.deps)).resolves.toBe('key_mismatch');
        expect(h.spies.verify).not.toHaveBeenCalled();
        expect(h.seeds[0].every((b) => b === 0)).toBe(true);
    });

    it('a failed verify leaves no flag, and the next trigger retries', async () => {
        let fail = true;
        const h = harness({ verify: (b) => (fail ? { ok: false, status: 503, error: 'head_slot_unavailable' } : { ok: true, provenAddress: b.address, alreadyProven: false }) });
        await expect(ensureSolanaAddressProvenWith(h.deps)).resolves.toBe('failed');
        expect(h.store.size).toBe(0);
        fail = false;
        await expect(ensureSolanaAddressProvenWith(h.deps)).resolves.toBe('proven');
        expect(h.spies.verify).toHaveBeenCalledTimes(2);
    });

    it('a same-owner 409 is benign (flagged); another owner\'s 409 is not', async () => {
        const same = harness({ verify: () => ({ ok: false, status: 409, error: 'already_proven' }) });
        await expect(ensureSolanaAddressProvenWith(same.deps)).resolves.toBe('already_proven');
        expect(same.store.get(solanaProofFlagKey(EVM))).toBe(SOL);
        resetSolanaProofStateForTests();
        const other = harness({ verify: () => ({ ok: false, status: 409, error: 'address_bound_to_other_owner' }) });
        await expect(ensureSolanaAddressProvenWith(other.deps)).resolves.toBe('refused_by_relay');
        expect(other.store.size).toBe(0);
    });

    it('never throws: a throwing dependency resolves as failed', async () => {
        const h = harness();
        h.deps.relay.list = async () => { throw new Error('boom'); };
        await expect(ensureSolanaAddressProvenWith(h.deps)).resolves.toBe('failed');
    });

    it('no wallet → nothing happens', async () => {
        const h = harness();
        h.deps.walletAddress = async () => null;
        await expect(ensureSolanaAddressProvenWith(h.deps)).resolves.toBe('no_wallet');
        expect(h.spies.list).not.toHaveBeenCalled();
    });

    it('concurrent triggers share one run (one signature)', async () => {
        const h = harness();
        const [a, b] = await Promise.all([ensureSolanaAddressProvenWith(h.deps), ensureSolanaAddressProvenWith(h.deps)]);
        expect(a).toBe('proven');
        expect(b).toBe('proven');
        expect(h.spies.verify).toHaveBeenCalledTimes(1);
    });
});
