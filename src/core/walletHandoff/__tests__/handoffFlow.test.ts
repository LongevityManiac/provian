/**
 * Both directions of the QR handoff end to end over an in-memory mailbox that applies the relay's
 * session rules (one join, the direction check before any key check, deletion on take and cancel,
 * not_found for a session that is gone), and a hostile relay that swaps in its own receiver key in
 * each direction (RED: the sender refuses before it seals anything).
 */
import { describe, expect, it } from 'vitest';
import { newReceiverKeyPair, receiverKeyMac, toB64Url } from '../handoffCrypto';
import {
    HandoffExpiredError,
    HandoffNotACodeError,
    cancelSession,
    isTransientRelayError,
    joinAsReceiver,
    joinAsSender,
    openWebSession,
    sendWallet,
    waitForJoin,
    waitForWallet,
    watchSession,
    type HandoffRelay,
} from '../handoffFlow';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ADDRESS = '0x58A57ed9d8d624cBD12e2C467D34787555bB1b25';
const WEB = { label: 'Chrome on macOS', platform: 'web' as const };
const PHONE = { label: 'iPhone 15 Pro', platform: 'ios' as const };

type Session = Record<string, unknown> & { mode: string; creatorToken: string; joinerToken?: string; envelope?: unknown };

/** The relay's rules in memory, with an optional tamper hook for the receiver key it hands out. */
function mailbox(tamper?: (key: { receiver_key: string; receiver_key_mac: string }) => { receiver_key: string; receiver_key_mac: string }) {
    const sessions = new Map<string, Session>();
    const calls: string[] = [];
    let n = 0;
    const relay: HandoffRelay = {
        async handoffCall<T>(action: string, body: Record<string, unknown>): Promise<T> {
            calls.push(action);
            const s = sessions.get(body.id as string);
            const out = (value: unknown) => value as T;
            if (action !== 'open' && action !== 'cancel' && !s) throw new Error('handoff_not_found');
            switch (action) {
                case 'open': {
                    const id = `session${String(++n).padStart(15, '0')}`;
                    sessions.set(id, { mode: body.mode as string, creatorDevice: body.device, creatorToken: `c${id}`, receiver_key: body.receiver_key ?? null, receiver_key_mac: body.receiver_key_mac ?? null });
                    return out({ id, token: `c${id}`, expires_at: Date.now() + 600_000 });
                }
                case 'join': {
                    if (s!.joinerToken) throw new Error('handoff_already_joined');
                    if ((s!.mode === 'send') !== (body.receiver_key !== undefined)) throw new Error('handoff_wrong_direction');
                    const s2 = s!;
                    s2.joinerToken = `j${body.id}`;
                    s2.joinerDevice = body.device;
                    if (s2.mode === 'send') { s2.receiver_key = body.receiver_key; s2.receiver_key_mac = body.receiver_key_mac; }
                    const key = s2.mode === 'receive' ? { receiver_key: s2.receiver_key as string, receiver_key_mac: s2.receiver_key_mac as string } : null;
                    const handed = key && tamper ? tamper(key) : key;
                    return out({ token: s2.joinerToken, mode: s2.mode, peer_device: s2.creatorDevice, receiver_key: handed?.receiver_key ?? null, receiver_key_mac: handed?.receiver_key_mac ?? null, expires_at: Date.now() + 600_000 });
                }
                case 'state': {
                    const creator = body.token === s!.creatorToken;
                    const key = { receiver_key: s!.receiver_key as string, receiver_key_mac: s!.receiver_key_mac as string };
                    const handed = s!.mode === 'send' && tamper && s!.receiver_key ? tamper(key) : key;
                    return out({ joined: !!s!.joinerToken, sealed: !!s!.envelope, peer_device: creator ? s!.joinerDevice ?? null : s!.creatorDevice, ...handed, expires_at: Date.now() + 600_000 });
                }
                case 'seal':
                    s!.envelope = body.envelope;
                    return out({ sealed: true });
                case 'take': {
                    if (!s!.envelope) return out({ envelope: null });
                    sessions.delete(body.id as string);
                    return out({ envelope: s!.envelope });
                }
                default:
                    sessions.delete(body.id as string);
                    return out({ cancelled: true });
            }
        },
    };
    return { relay, sessions, calls };
}

const fast = { sleep: async () => undefined };

describe('QR handoff, both directions', () => {
    it('browser first: the web app sends to the phone, and both show the same code', async () => {
        const { relay, sessions } = mailbox();
        const web = await openWebSession(relay, 'send', WEB);
        const phone = await joinAsReceiver(relay, web.qrText, PHONE);
        expect(phone.peer.device).toEqual(WEB);
        const peer = await waitForJoin(relay, web.session, fast);
        expect(peer.device).toEqual(PHONE);
        expect(peer.matchCode).toBe(phone.peer.matchCode);
        await sendWallet(relay, web.session, peer, MNEMONIC, ADDRESS);
        expect(await waitForWallet(relay, phone.session, fast)).toEqual({ mnemonic: MNEMONIC, walletAddress: ADDRESS.toLowerCase() });
        expect(sessions.size).toBe(0);
    });

    it('phone first: the phone sends to the web app', async () => {
        const { relay, sessions } = mailbox();
        const web = await openWebSession(relay, 'receive', WEB);
        const phone = await joinAsSender(relay, web.qrText, PHONE);
        expect(phone.peer.device).toEqual(WEB);
        const peer = await waitForJoin(relay, web.session, fast);
        expect(peer.device).toEqual(PHONE);
        expect(peer.matchCode).toBe(phone.peer.matchCode);
        await sendWallet(relay, phone.session, phone.peer, MNEMONIC, ADDRESS);
        expect(await waitForWallet(relay, web.session, fast)).toEqual({ mnemonic: MNEMONIC, walletAddress: ADDRESS.toLowerCase() });
        expect(sessions.size).toBe(0);
    });

    it('RED: a relay that swaps in its own key is refused by the sender in each direction, before anything is sealed', async () => {
        const swap = () => {
            const evil = newReceiverKeyPair();
            return { receiver_key: toB64Url(evil.publicKey), receiver_key_mac: receiverKeyMac(new Uint8Array(32), '', evil.publicKey) };
        };
        const a = mailbox(swap);
        const webSend = await openWebSession(a.relay, 'send', WEB);
        await joinAsReceiver(a.relay, webSend.qrText, PHONE);
        await expect(waitForJoin(a.relay, webSend.session, fast)).rejects.toThrow('handoff_receiver_key_mismatch');

        const b = mailbox(swap);
        const webReceive = await openWebSession(b.relay, 'receive', WEB);
        await expect(joinAsSender(b.relay, webReceive.qrText, PHONE)).rejects.toThrow('handoff_receiver_key_mismatch');
        for (const s of b.sessions.values()) expect(s.envelope).toBeUndefined();
    });

    it('RED: a code from another app is not a handoff, and a wrong-direction scan is refused without using up the session', async () => {
        const { relay } = mailbox();
        await expect(joinAsReceiver(relay, 'https://example.com', PHONE)).rejects.toBeInstanceOf(HandoffNotACodeError);
        const web = await openWebSession(relay, 'receive', WEB);
        // "From your computer" scanned a code the web app shows for receiving.
        await expect(joinAsReceiver(relay, web.qrText, PHONE)).rejects.toThrow('handoff_wrong_direction');
        await expect(joinAsSender(relay, web.qrText, PHONE)).resolves.toBeTruthy();
        // "Add a computer" scanned a code the web app shows for sending.
        const send = await openWebSession(relay, 'send', WEB);
        await expect(joinAsSender(relay, send.qrText, PHONE)).rejects.toThrow('handoff_wrong_direction');
        await expect(joinAsReceiver(relay, send.qrText, PHONE)).resolves.toBeTruthy();
    });

    it('a dropped connection or a busy relay while polling is retried; a named refusal is final (RED)', async () => {
        const { relay } = mailbox();
        const web = await openWebSession(relay, 'send', WEB);
        const phone = await joinAsReceiver(relay, web.qrText, PHONE);
        const peer = await waitForJoin(relay, web.session, fast);
        await sendWallet(relay, web.session, peer, MNEMONIC, ADDRESS);
        const failures = [new TypeError('Network request failed'), new Error('temporarily_unavailable'), new Error('rate_limited'), new Error('handoff_take_failed_502')];
        const flaky: HandoffRelay = { handoffCall: async <T,>(action: Parameters<HandoffRelay['handoffCall']>[0], body: Record<string, unknown>) => {
            const next = failures.shift();
            if (next) throw next;
            return relay.handoffCall<T>(action, body);
        } };
        expect((await waitForWallet(flaky, phone.session, fast)).mnemonic).toBe(MNEMONIC);
        for (const code of ['handoff_token_invalid', 'handoff_not_receiver', 'receiver_key_invalid', 'device_invalid']) expect(isTransientRelayError(new Error(code))).toBe(false);
        expect(isTransientRelayError(new HandoffExpiredError())).toBe(false);
        const refusing: HandoffRelay = { handoffCall: async () => { throw new Error('handoff_token_invalid'); } };
        await expect(waitForWallet(refusing, phone.session, fast)).rejects.toThrow('handoff_token_invalid');
    });

    it('the side still deciding learns when the other side left (RED: an open session is not reported as gone)', async () => {
        const { relay } = mailbox();
        const web = await openWebSession(relay, 'send', WEB);
        const phone = await joinAsReceiver(relay, web.qrText, PHONE);
        const signal = { aborted: false };
        let polls = 0;
        const watched = watchSession(relay, web.session, { signal, sleep: async () => { polls++; if (polls === 3) await cancelSession(relay, phone.session); } });
        await expect(watched).rejects.toBeInstanceOf(HandoffExpiredError);
        expect(polls).toBe(3);
        const other = await openWebSession(relay, 'send', WEB);
        const stop = { aborted: false };
        let rounds = 0;
        await expect(watchSession(relay, other.session, { signal: stop, sleep: async () => { if (++rounds === 4) stop.aborted = true; } })).rejects.toThrow('handoff_cancelled');
    });

    it('a join the phone refuses after the relay accepted it (a swapped key) ends the session', async () => {
        const swap = () => {
            const evil = newReceiverKeyPair();
            return { receiver_key: toB64Url(evil.publicKey), receiver_key_mac: receiverKeyMac(new Uint8Array(32), '', evil.publicKey) };
        };
        const { relay, sessions, calls } = mailbox(swap);
        const web = await openWebSession(relay, 'receive', WEB);
        await expect(joinAsSender(relay, web.qrText, PHONE)).rejects.toThrow('handoff_receiver_key_mismatch');
        expect(calls).toContain('cancel');
        expect(sessions.size).toBe(0);
        await expect(waitForWallet(relay, web.session, fast)).rejects.toBeInstanceOf(HandoffExpiredError);
    });
});
