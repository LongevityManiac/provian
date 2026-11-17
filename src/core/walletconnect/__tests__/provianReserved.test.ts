import { vi } from 'vitest';
vi.mock('../../protocol/runtime', async () => (await import('../../protocol/__test-helpers__/runtime')).protocolRuntimeFixture);
/**
 * the WalletConnect Provian-reserved-message guard, on its own.
 *
 * The door + backstop wiring (and the RED controls showing each reserved vector was SIGNED by
 * the pre-guard service) live in WalletConnectService.test.ts; this suite pins the classifier
 * and binds its inputs to the sources of truth (the relay's recovery domain, the
 * deployment record, the canonical PVT9 config).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    RECOVERY_DOMAIN,
    RECOVERY_TYPES,
    RECOVERY_PURPOSE,
} from '../../../../provian-backend/src/routes/recovery-eip712';
import {
    assertNotProvianReserved,
    checkProvianReserved,
    provianReservedAddresses,
    ProvianReservedMessageError,
} from '../provianReserved';
import { RELAY_RECOVERY_DOMAIN, RELAY_RECOVERY_TYPES, RELAY_RECOVERY_PURPOSE } from '../../relay/recoveryDomain';
import { TOKEN_ADDRESSES } from '../../chains/evm/config';
import { ALLOWED_VECTORS, RESERVED_VECTORS, WALLET, innocuousTypedData } from './provianReservedVectors';

const ROOT = resolve(__dirname, '../../../..');

describe('provianReserved — reserved vectors are refused', () => {
    it('has a non-empty reserved population', () => {
        expect(RESERVED_VECTORS.length).toBeGreaterThanOrEqual(25);
    });

    for (const vector of RESERVED_VECTORS) {
        it(`refuses: ${vector.name}`, () => {
            const verdict = checkProvianReserved(vector.method, vector.params);
            expect(verdict.reserved).toBe(true);
            expect(() => assertNotProvianReserved(vector.method, vector.params)).toThrow(ProvianReservedMessageError);
        });
    }

    it('refuses typed data under EVERY reserved verifyingContract with an innocuous name', () => {
        const addresses = provianReservedAddresses();
        expect(addresses.length).toBeGreaterThanOrEqual(15);
        for (const address of addresses) {
            const verdict = checkProvianReserved('eth_signTypedData_v4', [WALLET, JSON.stringify(innocuousTypedData(address))]);
            expect(verdict).toMatchObject({ reserved: true, reason: 'provian_verifying_contract' });
        }
    });

    it('refuses a verifyingContract that is not a plain address (ICAP) — unknown = block', () => {
        const verdict = checkProvianReserved('eth_signTypedData_v4', [WALLET, JSON.stringify(innocuousTypedData('XE7338O073KYGTWWZN0F2WZ0R8PX5ZPPZS'))]);
        expect(verdict).toMatchObject({ reserved: true, reason: 'unclassifiable_verifying_contract' });
    });

    it('fails closed on an unclassified method and on non-string personal_sign params', () => {
        expect(checkProvianReserved('eth_sign', [WALLET, `0x${'ab'.repeat(32)}`])).toMatchObject({ reserved: true, reason: 'unclassified_method' });
        expect(checkProvianReserved('personal_sign', [{ text: 'hi' }, WALLET])).toMatchObject({ reserved: true, reason: 'unclassifiable_params' });
        expect(checkProvianReserved('personal_sign', 'not-an-array')).toMatchObject({ reserved: true, reason: 'unclassifiable_params' });
    });

    it('reports the specific reason per format family', () => {
        const byName = new Map(RESERVED_VECTORS.map((v) => [v.name, checkProvianReserved(v.method, v.params)]));
        expect(byName.get('recovery typed data (v4, JSON string)')).toMatchObject({ reason: 'provian_typed_data_domain' });
        expect(byName.get('link_agent consent (reordered keys + whitespace)')).toMatchObject({ reason: 'provian_link_consent_json' });
        expect(byName.get('share update consent')).toMatchObject({ reason: 'provian_link_consent_json' });
        expect(byName.get('hire escrow salt message')).toMatchObject({ reason: 'provian_hire_salt' });
        expect(byName.get('typed data: RelayRecovery struct under an innocuous domain, no verifyingContract')).toMatchObject({ reason: 'provian_typed_data_type' });
        expect(byName.get('link_agent consent with an extra single-use nonce field')).toMatchObject({ reason: 'provian_link_consent_json' });
        expect(byName.get('typed data: RegisterHumanWallet struct under an innocuous domain')).toMatchObject({ reason: 'provian_typed_data_type' });
        expect(byName.get('Recourse membership departure signing hash')).toMatchObject({ reason: 'raw_32_byte_message' });
        expect(byName.get('Recourse standing membership consent signing hash')).toMatchObject({ reason: 'raw_32_byte_message' });
        expect(byName.get('bare 32-byte value delivered as text')).toMatchObject({ reason: 'raw_32_byte_message' });
    });
});

describe('provianReserved — a bare 32-byte personal_sign is a Recourse consent signature', () => {
    it('signing the departure hash with EIP-191 yields exactly the signature the pool recovers', async () => {
        const { Wallet, getBytes, verifyMessage, hashMessage } = await import('ethers');
        const { authenticatedDepartureSigningHash } = await import('../../recourse/membership-authorization');
        const signer = new Wallet(`0x${'11'.repeat(32)}`);
        const hash = authenticatedDepartureSigningHash(
            { chainId: '8453', pointer: `0x${'9'.repeat(40)}`, kernel: `0x${'1'.repeat(40)}`, pool: `0x${'2'.repeat(40)}` },
            { binding: `0x${'b'.repeat(64)}`, account: signer.address.toLowerCase(), nonce: '3', joined: false,
                revision: '1', ruleHash: `0x${'e'.repeat(64)}`, expiresAt: '1790000000' },
        );
        expect(getBytes(hash)).toHaveLength(32);
        // What the WalletConnect personal_sign path does with a 0x-hex message: sign its raw bytes.
        const signature = await signer.signMessage(getBytes(hash));
        expect(verifyMessage(getBytes(hash), signature)).toBe(signer.address);
        expect(hashMessage(getBytes(hash))).not.toBe(hash);
        // …so the request that would produce it is refused.
        expect(checkProvianReserved('personal_sign', [hash, signer.address])).toMatchObject({ reserved: true, reason: 'raw_32_byte_message' });
    });

    it('refuses exactly 32 signed bytes and nothing shorter or longer', () => {
        for (const size of [1, 20, 31, 33, 64, 65]) {
            expect(checkProvianReserved('personal_sign', [`0x${'ab'.repeat(size)}`, WALLET])).toEqual({ reserved: false });
            expect(checkProvianReserved('personal_sign', ['m'.repeat(size), WALLET])).toEqual({ reserved: false });
        }
        expect(checkProvianReserved('personal_sign', [`0x${'ab'.repeat(32)}`, WALLET])).toMatchObject({ reserved: true, reason: 'raw_32_byte_message' });
        expect(checkProvianReserved('personal_sign', ['m'.repeat(32), WALLET])).toMatchObject({ reserved: true, reason: 'raw_32_byte_message' });
    });
});

describe('provianReserved — ordinary requests still flow (positive controls)', () => {
    it('has a non-empty allowed population', () => {
        expect(ALLOWED_VECTORS.length).toBeGreaterThanOrEqual(5);
    });
    for (const vector of ALLOWED_VECTORS) {
        it(`allows: ${vector.name}`, () => {
            expect(checkProvianReserved(vector.method, vector.params)).toEqual({ reserved: false });
            expect(() => assertNotProvianReserved(vector.method, vector.params)).not.toThrow();
        });
    }
    it('eth_sendTransaction is a transaction signature, not a message — out of scope', () => {
        const tx = { to: '0x1111111111111111111111111111111111111111', data: `0x${Buffer.from('provian').toString('hex')}` };
        expect(checkProvianReserved('eth_sendTransaction', [tx])).toEqual({ reserved: false });
    });
});

describe('provianReserved — inputs bound to their sources of truth', () => {
    it('the app recovery domain is byte-identical to the relay pinned domain', () => {
        expect(RELAY_RECOVERY_DOMAIN).toEqual(RECOVERY_DOMAIN);
        expect(RELAY_RECOVERY_TYPES).toEqual(RECOVERY_TYPES);
        expect(RELAY_RECOVERY_PURPOSE).toBe(RECOVERY_PURPOSE);
    });

    it('reserves every current protocol component named by the verified pointer', async () => {
        const { verifiedProtocolSnapshot } = await import('../../protocol/runtime');
        const current = Object.values(verifiedProtocolSnapshot().addresses).filter(address => !/^0x0{40}$/i.test(address));
        const reserved = new Set(provianReservedAddresses());
        for (const address of current) expect(reserved.has(address.toLowerCase())).toBe(true);
    });

    it('reserves every retired PVT token on the canonical forbidden list', () => {
        const canonical = JSON.parse(readFileSync(resolve(ROOT, 'config/pvt9-base.json'), 'utf8')) as {
            validation: { forbidden_pvt_addresses: string[] };
        };
        const forbidden = canonical.validation.forbidden_pvt_addresses;
        expect(forbidden.length).toBeGreaterThan(0);
        const reserved = new Set(provianReservedAddresses());
        for (const address of forbidden) expect(reserved.has(address.toLowerCase())).toBe(true);
    });

    it('never reserves a third-party token the app lists (a USDC permit must still sign)', () => {
        const reserved = new Set(provianReservedAddresses());
        const tokens = Object.values(TOKEN_ADDRESSES).flatMap((t) => Object.values(t));
        expect(tokens.length).toBeGreaterThan(0);
        for (const token of tokens) expect(reserved.has(token.toLowerCase())).toBe(false);
    });
});
