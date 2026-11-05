/**
 * the app as a WalletConnect dApp that asks a THIRD-PARTY wallet to
 * `personal_sign` the relay's "Provian proof of control" message.
 *
 * Pinned: the proposal asks for `personal_sign` only; the account parse prefers Base and
 * refuses a session with no valid EVM account (RED); the hex params are the exact UTF-8
 * message, so a real wallet's signature over them recovers against the plain message the
 * relay verifies; a non-hex wallet result is refused (RED).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';

const h = vi.hoisted(() => ({
    initArgs: [] as unknown[],
    connectArgs: [] as unknown[],
    requestArgs: [] as unknown[],
    requestResult: '0x' as unknown,
}));

vi.mock('@walletconnect/react-native-compat', () => ({}));
vi.mock('@walletconnect/sign-client', () => {
    const client = {
        connect: async (args: unknown) => {
            h.connectArgs.push(args);
            return { uri: 'wc:abc@2?relay-protocol=irn&symKey=00', approval: async () => ({}) };
        },
        request: async (args: unknown) => {
            h.requestArgs.push(args);
            return h.requestResult;
        },
        disconnect: async () => undefined,
    };
    return { default: { init: async (opts: unknown) => { h.initArgs.push(opts); return client; } } };
});

async function load() {
    vi.resetModules();
    vi.stubEnv('EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test-project');
    return import('../ExternalWalletProofClient');
}

const MESSAGE = [
    'Provian proof of control',
    'agent: agent-1',
    'address: 0x1111111111111111111111111111111111111111',
    'nonce: 0123456789abcdef0123456789abcdef',
    'issued: 2026-09-28T00:00:00.000Z',
    'expires: 2026-09-28T00:10:00.000Z',
].join('\n');

beforeEach(() => {
    h.initArgs.length = 0;
    h.connectArgs.length = 0;
    h.requestArgs.length = 0;
});

describe('accountFromSession', () => {
    it('prefers the Base account and lowercases it', async () => {
        const { accountFromSession } = await load();
        const a = '0xAbC0000000000000000000000000000000000001';
        const b = '0xdef0000000000000000000000000000000000002';
        expect(accountFromSession({
            eip155: { accounts: [`eip155:1:${b}`, `eip155:8453:${a}`], methods: [], events: [] },
        })).toEqual({ address: a.toLowerCase(), chainId: 'eip155:8453' });
    });

    it('falls back to the first valid EVM account (same EOA) and keeps its chain for routing', async () => {
        const { accountFromSession } = await load();
        const b = '0xdef0000000000000000000000000000000000002';
        expect(accountFromSession({ eip155: { accounts: [`eip155:10:${b}`], methods: [], events: [] } }))
            .toEqual({ address: b, chainId: 'eip155:10' });
    });

    it('RED: no namespace, a malformed account, or a non-EVM address yields null', async () => {
        const { accountFromSession } = await load();
        expect(accountFromSession(undefined)).toBeNull();
        expect(accountFromSession({ eip155: { accounts: ['eip155:8453:0xnot'], methods: [], events: [] } })).toBeNull();
        expect(accountFromSession({ eip155: { accounts: ['solana:1:abc'], methods: [], events: [] } })).toBeNull();
    });
});

describe('personalSignParams', () => {
    it('hex-encodes the exact UTF-8 message; a real wallet signature over it recovers against the plain message', async () => {
        const { personalSignParams } = await load();
        const wallet = ethers.Wallet.createRandom();
        const [hex, addr] = personalSignParams(MESSAGE, wallet.address.toLowerCase());
        expect(ethers.toUtf8String(hex)).toBe(MESSAGE);
        expect(addr).toBe(wallet.address.toLowerCase());
        // What a wallet does with personal_sign(hex): EIP-191 over the decoded bytes.
        const sig = await wallet.signMessage(ethers.getBytes(hex));
        // What the relay does: EIP-191 recovery over the stored message string.
        expect(ethers.verifyMessage(MESSAGE, sig)).toBe(wallet.address);
    });

    it('RED: a signature over a DIFFERENT message does not recover to the signer', async () => {
        const { personalSignParams } = await load();
        const wallet = ethers.Wallet.createRandom();
        const [hex] = personalSignParams(`${MESSAGE}\n`, wallet.address);
        const sig = await wallet.signMessage(ethers.getBytes(hex));
        expect(ethers.verifyMessage(MESSAGE, sig)).not.toBe(wallet.address);
    });
});

describe('ExternalWalletProofClient', () => {
    it('proposes personal_sign on Base ONLY, under its own storage prefix and the configured project id', async () => {
        const mod = await load();
        expect(mod.isExternalWalletConnectConfigured()).toBe(true);
        const { uri } = await mod.externalWalletProofClient.connect();
        expect(uri.startsWith('wc:')).toBe(true);
        expect(h.initArgs[0]).toMatchObject({ projectId: 'test-project', customStoragePrefix: 'provian-external-proof' });
        expect(h.connectArgs[0]).toEqual({
            optionalNamespaces: {
                eip155: { methods: ['personal_sign'], chains: ['eip155:8453'], events: ['accountsChanged', 'chainChanged'] },
            },
        });
    });

    it('routes the request on the approved account chain and returns a hex signature', async () => {
        const mod = await load();
        h.requestResult = `0x${'ab'.repeat(65)}`;
        const account = { address: '0x1111111111111111111111111111111111111111', chainId: 'eip155:8453' };
        const sig = await mod.externalWalletProofClient.requestPersonalSign(
            { topic: 't1' } as never, account, MESSAGE,
        );
        expect(sig).toBe(h.requestResult);
        expect(h.requestArgs[0]).toMatchObject({
            topic: 't1',
            chainId: 'eip155:8453',
            request: { method: 'personal_sign', params: [ethers.hexlify(ethers.toUtf8Bytes(MESSAGE)), account.address] },
        });
    });

    it('RED: a wallet result that is not a hex signature is refused', async () => {
        const mod = await load();
        h.requestResult = 'approved';
        await expect(mod.externalWalletProofClient.requestPersonalSign(
            { topic: 't1' } as never,
            { address: '0x1111111111111111111111111111111111111111', chainId: 'eip155:8453' },
            MESSAGE,
        )).rejects.toThrow('walletconnect_bad_signature');
    });

    it('wallet deep links carry the encoded pairing URI', async () => {
        const { EXTERNAL_WALLET_APPS } = await load();
        const uri = 'wc:abc@2?relay-protocol=irn&symKey=00';
        for (const app of EXTERNAL_WALLET_APPS) {
            expect(app.connect(uri)).toContain(`wc?uri=${encodeURIComponent(uri)}`);
        }
    });
});
