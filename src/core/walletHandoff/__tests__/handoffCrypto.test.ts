/**
 * The QR handoff's crypto: a seed sealed by the sender opens only on the receiver that holds the
 * private key AND the code's secret; a key the relay swaps in is caught before anything is sealed;
 * tampering anywhere is refused; both screens compute the same match code.
 */
import { describe, expect, it } from 'vitest';
import {
    decodeHandoffQr,
    encodeHandoffQr,
    handoffMatchCode,
    newHandoffSecret,
    newReceiverKeyPair,
    openHandoff,
    receiverKeyMac,
    sealHandoff,
    toB64Url,
    verifyReceiverKey,
} from '../handoffCrypto';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ID = 'AbCdEfGhIjKlMnOpQrStUv';

function handoff() {
    const secret = newHandoffSecret();
    const receiver = newReceiverKeyPair();
    const mac = receiverKeyMac(secret, ID, receiver.publicKey);
    return { secret, receiver, mac, keyB64: toB64Url(receiver.publicKey) };
}

describe('QR handoff crypto', () => {
    it('the code round-trips, and other QR codes are not mistaken for one', () => {
        const secret = newHandoffSecret();
        const text = encodeHandoffQr({ id: ID, secret });
        const decoded = decodeHandoffQr(text);
        expect(decoded?.id).toBe(ID);
        expect(Array.from(decoded!.secret)).toEqual(Array.from(secret));
        for (const other of ['', 'https://provian.ai', 'wc:abc@2?relay-protocol=irn', `PROVIAN-HANDOFF:2:${ID}:${toB64Url(secret)}`, `PROVIAN-HANDOFF:1:short:${toB64Url(secret)}`, `PROVIAN-HANDOFF:1:${ID}:AAAA`]) {
            expect(decodeHandoffQr(other)).toBeNull();
        }
    });

    it('the receiver opens what the sender sealed, and both show the same code', () => {
        const h = handoff();
        const key = verifyReceiverKey(h.secret, ID, h.keyB64, h.mac);
        const envelope = sealHandoff({ secret: h.secret, id: ID, receiverPublicKey: key, mnemonic: MNEMONIC, walletAddress: ADDRESS });
        expect(JSON.stringify(envelope)).not.toContain('abandon');
        expect(openHandoff({ secret: h.secret, id: ID, receiver: h.receiver, envelope })).toEqual({ mnemonic: MNEMONIC, walletAddress: ADDRESS.toLowerCase() });
        expect(handoffMatchCode(h.secret, ID, key)).toBe(handoffMatchCode(h.secret, ID, h.receiver.publicKey));
        expect(handoffMatchCode(h.secret, ID, key)).toMatch(/^\d{3} \d{3}$/);
    });

    it('RED: a receiver key the relay swapped in is refused before anything is sealed', () => {
        const h = handoff();
        const relayKey = newReceiverKeyPair();
        // The relay does not know the code's secret, so it can only reuse the real MAC or invent one.
        expect(() => verifyReceiverKey(h.secret, ID, toB64Url(relayKey.publicKey), h.mac)).toThrow('handoff_receiver_key_mismatch');
        expect(() => verifyReceiverKey(h.secret, ID, toB64Url(relayKey.publicKey), receiverKeyMac(newHandoffSecret(), ID, relayKey.publicKey))).toThrow('handoff_receiver_key_mismatch');
        // The same MAC for another session is refused too.
        expect(() => verifyReceiverKey(h.secret, 'ZZZZZZZZZZZZZZZZZZZZZZ', h.keyB64, h.mac)).toThrow('handoff_receiver_key_mismatch');
    });

    it('RED: the relay (no private key, no secret), a wrong secret, another session or a tampered envelope cannot open it', () => {
        const h = handoff();
        const envelope = sealHandoff({ secret: h.secret, id: ID, receiverPublicKey: h.receiver.publicKey, mnemonic: MNEMONIC, walletAddress: ADDRESS });
        const stranger = newReceiverKeyPair();
        expect(() => openHandoff({ secret: h.secret, id: ID, receiver: stranger, envelope })).toThrow('handoff_open_failed');
        expect(() => openHandoff({ secret: newHandoffSecret(), id: ID, receiver: h.receiver, envelope })).toThrow('handoff_open_failed');
        expect(() => openHandoff({ secret: h.secret, id: 'ZZZZZZZZZZZZZZZZZZZZZZ', receiver: h.receiver, envelope })).toThrow('handoff_open_failed');
        const flipped = envelope.ct.slice(0, -2) + (envelope.ct.endsWith('A') ? 'BA' : 'AA');
        expect(() => openHandoff({ secret: h.secret, id: ID, receiver: h.receiver, envelope: { ...envelope, ct: flipped } })).toThrow();
        expect(() => openHandoff({ secret: h.secret, id: ID, receiver: h.receiver, envelope: { ...envelope, v: 2 as 1 } })).toThrow('handoff_envelope_invalid');
    });

    it('every seal is fresh: the same seed sealed twice gives different ciphertext', () => {
        const h = handoff();
        const a = sealHandoff({ secret: h.secret, id: ID, receiverPublicKey: h.receiver.publicKey, mnemonic: MNEMONIC, walletAddress: ADDRESS });
        const b = sealHandoff({ secret: h.secret, id: ID, receiverPublicKey: h.receiver.publicKey, mnemonic: MNEMONIC, walletAddress: ADDRESS });
        expect(a.epk).not.toBe(b.epk);
        expect(a.ct).not.toBe(b.ct);
    });
});
