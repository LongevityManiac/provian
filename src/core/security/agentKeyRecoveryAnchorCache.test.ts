/**
 * openWithAnchor derives the anchor's public key once per secret (findings: a mailbox backlog
 * opens thousands of boxes with one secret). The same secret opens as before; a secret changed in
 * place is derived afresh (RED: with a stale public key the box would not open).
 */
import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { openWithAnchor, sealToAnchor } from './agentKeyRecovery';

describe('anchor public key cache', () => {
    it('opens repeatedly with one secret, and a secret rewritten in place opens its own boxes, never the old ones', () => {
        const a = x25519.utils.randomPrivateKey();
        const b = x25519.utils.randomPrivateKey();
        const secret = a.slice();
        const boxA = sealToAnchor(x25519.getPublicKey(a), new TextEncoder().encode('to a'));
        const boxB = sealToAnchor(x25519.getPublicKey(b), new TextEncoder().encode('to b'));
        for (let i = 0; i < 3; i++) expect(new TextDecoder().decode(openWithAnchor(secret, boxA))).toBe('to a');
        expect(() => openWithAnchor(secret, boxB)).toThrow();
        // The same array now holds b: the cached public key of a must not be used.
        secret.set(b);
        expect(new TextDecoder().decode(openWithAnchor(secret, boxB))).toBe('to b');
        expect(() => openWithAnchor(secret, boxA)).toThrow();
    });
});
