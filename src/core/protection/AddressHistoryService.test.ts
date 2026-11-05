import { describe, it, expect } from 'vitest';
import AddressHistoryService from './AddressHistoryService';

// Address-poisoning lookalike detection: an attacker crafts a vanity address
// sharing the same visible prefix + suffix as an address this wallet already
// knows (the exact substring formatAddressForDisplay/formatAddress show as
// "0x1234...abcd"), then dust-transfers from it so it appears in activity.
// findLookalikeMatch must catch that pattern - and must NOT flag an address
// that is genuinely unrelated, or the address itself re-typed/pasted again.
describe('AddressHistoryService.findLookalikeMatch', () => {
    const KNOWN = `0x1234${'0'.repeat(32)}abcd`;
    const LOOKALIKE = `0x1234${'9'.repeat(32)}abcd`; // same prefix + suffix, different middle
    const UNRELATED = `0x9999${'0'.repeat(32)}ffff`; // shares neither

    it('flags a lookalike sharing prefix+suffix with a known contact, and returns its name', async () => {
        await AddressHistoryService.saveContact(KNOWN, 'Alice Exchange');

        const match = await AddressHistoryService.findLookalikeMatch(LOOKALIKE);

        expect(match).not.toBeNull();
        expect(match?.address).toBe(KNOWN.toLowerCase());
        expect(match?.name).toBe('Alice Exchange');
    });

    it('flags a lookalike sharing prefix+suffix with a plain send-history address (no saved name)', async () => {
        const known = `0x5555${'1'.repeat(32)}eeee`;
        const lookalike = `0x5555${'2'.repeat(32)}eeee`;
        await AddressHistoryService.recordSend(known, 10);

        const match = await AddressHistoryService.findLookalikeMatch(lookalike);

        expect(match).not.toBeNull();
        expect(match?.address).toBe(known.toLowerCase());
        expect(match?.name).toBeUndefined();
    });

    // Negative control: a genuinely unrelated address (no shared prefix or
    // suffix) must never be flagged. Guards against a vacuous/always-match
    // implementation that would make every send look like a poisoning risk.
    it('does not flag an address that shares neither prefix nor suffix', async () => {
        await AddressHistoryService.saveContact(KNOWN, 'Bob');

        const match = await AddressHistoryService.findLookalikeMatch(UNRELATED);

        expect(match).toBeNull();
    });

    // Negative control: the known address itself (or a re-cased copy of it)
    // is not a "lookalike" - it IS the trusted address. Guards against a
    // broken exact-match exclusion that would flag every repeat send.
    it('does not flag the known address itself, including a different case', async () => {
        await AddressHistoryService.saveContact(KNOWN, 'Carol');

        expect(await AddressHistoryService.findLookalikeMatch(KNOWN)).toBeNull();
        expect(await AddressHistoryService.findLookalikeMatch(KNOWN.toUpperCase())).toBeNull();
    });
});
