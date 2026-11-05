/**
 * Unit tests for sendConnectCommand (the "email me the setup command" body).
 *
 * The endpoint that mints the token lives inline in server.ts, which has no
 * per-endpoint test harness; these tests cover the email composition that the
 * endpoint relies on: the right command goes in verbatim, device vs agent copy
 * differs, the command is HTML-escaped in the rendered block, and send failures
 * surface as a falsy return.
 *
 * Command fixtures are built by the REAL setup-command builders (single
 * source): pre-flip the @provian packages are unpublished (npm E404), so the
 * emailed line must be the hosted curl flow — never `npx @provian/...`. The
 * no-npx guard's negative control renders a deliberately npx-shaped fixture
 * and shows the guard firing.
 */

const mockSend = jest.fn();
const mockList = jest.fn();
const mockGet = jest.fn();

jest.mock('resend', () => ({
    Resend: jest.fn().mockImplementation(() => ({
        emails: { send: mockSend, list: mockList, get: mockGet },
    })),
}));

// These tests exercise the send() path, which (correctly) no-ops without a
// configured key. Provide a dummy key so the (mocked) Resend client is used.
process.env.RESEND_API_KEY = 'test_re_dummy_key';

import { sendConnectCommand, sendAgentInvite, sendBeneficiaryInvite, sendWithReceipt } from './email';
import { buildDeviceRegisterCommand } from './core/setup-command';

const ONE_HOUR = 60 * 60 * 1000;
const KEY_32_HEX = 'f'.repeat(32);

/** The pre-flip guard: a sent body must never hand out an npm-install line. */
const npxFree = (s: string): boolean => !/npx @provian\//.test(s);

/** Count non-overlapping occurrences of `needle` in `haystack`. */
const countOccurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

describe('sendConnectCommand', () => {
    beforeEach(() => {
        mockSend.mockReset();
        mockSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    });

    it('embeds the device command verbatim (exactly once per body) and uses the fixed subject', async () => {
        const cmd = buildDeviceRegisterCommand({ token: 'a'.repeat(64), idempotencyKey: KEY_32_HEX });
        const ok = await sendConnectCommand('user@example.com', 'device', cmd, Date.now() + ONE_HOUR);

        expect(ok).toBe(true);
        const args = mockSend.mock.calls[0][0];
        expect(args.subject).toBe('Your Provian setup command');
        expect(args.to).toEqual(['user@example.com']);
        // The curl line contains no &/</> so the HTML-escaped block keeps it
        // byte-identical — the paste-able line survives in BOTH bodies, once.
        expect(countOccurrences(args.text, cmd)).toBe(1);
        expect(countOccurrences(args.html, cmd)).toBe(1);
        // Pre-flip guard: nothing in the sent bodies points at unpublished npm.
        expect(npxFree(args.text)).toBe(true);
        expect(npxFree(args.html)).toBe(true);
        // Device framing, not agent framing.
        expect(args.text).toContain('Git commits and desktop AI chats');
        expect(args.text).toContain('Human computers capture no agent tool calls');
        // Step 3: the credentials the response prints are shown once — say so.
        expect(args.text).toContain('PROVIAN_DEVICE_KEY');
        expect(args.text).toContain('shown once');
    });

    it('[negative control] the npx-free guard FIRES when an npx-shaped command is rendered', async () => {
        // sendConnectCommand embeds whatever it is given verbatim, so rendering
        // the old defective fixture must make the guard report the violation —
        // proving npxFree() is not vacuously green above.
        const oldShape = 'npx @provian/agent-sdk register-device --token abc123';
        await sendConnectCommand('u@e.com', 'device', oldShape, Date.now() + ONE_HOUR);
        const args = mockSend.mock.calls[0][0];
        expect(npxFree(args.text)).toBe(false);
        expect(npxFree(args.html)).toBe(false);
    });

    it('HTML-escapes the command in the rendered block but keeps the plaintext raw', async () => {
        const cmd = 'echo "<a>&b"';
        await sendConnectCommand('u@e.com', 'device', cmd, Date.now() + ONE_HOUR);

        const args = mockSend.mock.calls[0][0];
        expect(args.html).toContain('&lt;a&gt;&amp;b');
        expect(args.html).not.toContain('<a>&b');
        expect(args.text).toContain(cmd);
    });

    it('states an expiry of about 60 minutes for a one-hour token', async () => {
        await sendConnectCommand('u@e.com', 'device', 'cmd', Date.now() + ONE_HOUR);
        const args = mockSend.mock.calls[0][0];
        expect(args.text).toMatch(/expires in about (5[5-9]|60) minutes/);
    });

    it('returns false when Resend reports an error', async () => {
        mockSend.mockResolvedValue({ data: null, error: { message: 'bad address' } });
        const ok = await sendConnectCommand('u@e.com', 'device', 'cmd', Date.now() + ONE_HOUR);
        expect(ok).toBe(false);
    });

    it('returns false when the send call throws', async () => {
        mockSend.mockRejectedValue(new Error('network down'));
        const ok = await sendConnectCommand('u@e.com', 'device', 'cmd', Date.now() + ONE_HOUR);
        expect(ok).toBe(false);
    });

    // -----------------------------------------------------------------------
    // BUILD SPEC item 7: kind='agent_device' (agent-owned device registration)
    // -----------------------------------------------------------------------
    describe("kind='agent_device' (agent-owned device registration)", () => {
        // The agent_device token is consumed by the SAME live endpoint as the
        // human device token (device-register-auth routes by stored type), so
        // the emailed command is the same hosted register curl line.
        const AGENT_DEVICE_TOKEN = 'deadbeef'.repeat(8);
        const AGENT_DEVICE_CMD = buildDeviceRegisterCommand({
            token: AGENT_DEVICE_TOKEN,
            idempotencyKey: KEY_32_HEX,
        });

        it('embeds the register curl line (token + live endpoint) verbatim in BOTH text and html', async () => {
            const ok = await sendConnectCommand('bob@example.com', 'agent_device', AGENT_DEVICE_CMD, Date.now() + ONE_HOUR);
            expect(ok).toBe(true);
            const args = mockSend.mock.calls[0][0];
            expect(args.text).toContain('/v1/devices/register');
            expect(args.text).toContain(`Bearer ${AGENT_DEVICE_TOKEN}`);
            // Whole command embedded verbatim (no HTML-special chars to escape).
            expect(args.text).toContain(AGENT_DEVICE_CMD);
            expect(args.html).toContain(AGENT_DEVICE_CMD);
            expect(npxFree(args.text)).toBe(true);
            expect(npxFree(args.html)).toBe(true);
        });

        it('uses agent-device framing distinct from device and agent copy', async () => {
            await sendConnectCommand('bob@example.com', 'agent_device', AGENT_DEVICE_CMD, Date.now() + ONE_HOUR);
            const args = mockSend.mock.calls[0][0];
            // Agent-device specific: it registers the machine to the agent's wallet and proof chain.
            expect(args.text).toContain('Provenance Envelopes the agent owns');
            expect(args.text).toContain('The setup link authorizes device registration only');
            // the install starts the observer; nothing to save.
            expect(args.text).toContain('starts the Provian observer');
            expect(args.text).not.toContain('PROVIAN_DEVICE_KEY');
            // Mint-once language (CLAUDE.md hard requirement): work mints; bookkeeping does not mint separately.
            expect(args.text).toContain('Every act of work mints PVT once at its best-supported value');
            // Must NOT reuse the human-device or the agent-connect framing.
            expect(args.text).not.toContain('the computer you want to connect');
            expect(args.text).not.toContain('where your agent runs');
        });

        it('renders an optional personal message (HTML-escaped) in both bodies', async () => {
            await sendConnectCommand(
                'bob@example.com',
                'agent_device',
                AGENT_DEVICE_CMD,
                Date.now() + ONE_HOUR,
                'set up the <CI> box & go',
            );
            const args = mockSend.mock.calls[0][0];
            // Plaintext keeps the raw message; HTML escapes it.
            expect(args.text).toContain('set up the <CI> box & go');
            expect(args.html).toContain('set up the &lt;CI&gt; box &amp; go');
            expect(args.html).not.toContain('<CI>');
        });

        it('names who asked: the app by default, the agent when the agent API requested it (RED: the app wording never reaches an agent-requested email)', async () => {
            await sendConnectCommand('bob@example.com', 'agent_device', AGENT_DEVICE_CMD, Date.now() + ONE_HOUR);
            const fromApp = mockSend.mock.calls[0][0];
            expect(fromApp.text).toContain('You requested this command from the Provian app');
            expect(fromApp.text).toContain('request a fresh one from the app');
            mockSend.mockClear();
            await sendConnectCommand('bob@example.com', 'agent_device', AGENT_DEVICE_CMD, Date.now() + ONE_HOUR, undefined, undefined, undefined, 'agent');
            const fromAgent = mockSend.mock.calls[0][0];
            for (const body of [fromAgent.text, fromAgent.html]) {
                expect(body).toContain('Your agent requested this command for you');
                expect(body).toContain('ask your agent for a fresh one');
                expect(body).not.toContain('from the Provian app');
                expect(body).not.toContain('from the app');
            }
        });

        it('omits the personal-message block when none is supplied', async () => {
            await sendConnectCommand('bob@example.com', 'agent_device', AGENT_DEVICE_CMD, Date.now() + ONE_HOUR);
            const args = mockSend.mock.calls[0][0];
            // No stray empty quotes block in the plaintext body.
            expect(args.text).not.toMatch(/""\n/);
        });
    });
});

// ---------------------------------------------------------------------------
// F53/F56 — invite templates must HTML-escape attacker-controlled agent name +
// personal message (they were left raw while sendConnectCommand escaped). These
// templates deliver from a DKIM-signed Provian address, so raw HTML is a
// high-quality phishing primitive for any agent API-key holder.
// ---------------------------------------------------------------------------
describe('invite templates HTML-escape attacker-controlled fields (F53/F56)', () => {
    beforeEach(() => {
        mockSend.mockReset();
        mockSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    });

    const EVIL_NAME = '<a href="https://evil.example/steal">Coinbase Support</a>';
    const EVIL_MSG = '<img src="https://evil.example/t.gif"><a href="https://evil.example/phish">Claim 500 PVT</a>';

    it('sendBeneficiaryInvite escapes agentName and personalMessage in the HTML body', async () => {
        const ok = await sendBeneficiaryInvite('victim@example.com', EVIL_NAME, 'inv_1', 'aw1', 0, 10, 'unsub_tok', EVIL_MSG);
        expect(ok).toBe(true);
        const args = mockSend.mock.calls[0][0];
        // Escaped markers present …
        expect(args.html).toContain('&lt;a href=&quot;https://evil.example/steal&quot;&gt;');
        expect(args.html).toContain('&lt;img src=&quot;https://evil.example/t.gif&quot;&gt;');
        // … and the RAW attacker tags are gone (no clickable link / tracking pixel).
        expect(args.html).not.toContain('<a href="https://evil.example/steal">');
        expect(args.html).not.toContain('<img src="https://evil.example/t.gif">');
        // Subject carries no markup either.
        expect(args.subject).not.toContain('<');
        expect(args.subject).not.toContain('>');
    });

    it('sendAgentInvite escapes agentName in the HTML body and neutralizes the subject', async () => {
        const ok = await sendAgentInvite('victim@example.com', EVIL_NAME, 'inv_2', 'unsub_tok', 'aw1');
        expect(ok).toBe(true);
        const args = mockSend.mock.calls[0][0];
        expect(args.html).toContain('&lt;a href=&quot;https://evil.example/steal&quot;&gt;');
        expect(args.html).not.toContain('<a href="https://evil.example/steal">');
        expect(args.subject).not.toContain('<');
        expect(args.subject).not.toContain('>');
    });

    // Guard-integrity control: a BENIGN name still renders (escaping is not a
    // blanket strip that breaks normal display names).
    it('a benign display name renders unchanged', async () => {
        await sendAgentInvite('victim@example.com', 'Atlas', 'inv_3', 'unsub_tok', 'aw1');
        const args = mockSend.mock.calls[0][0];
        expect(args.html).toContain('Atlas wants to link with you.');
        expect(args.subject).toBe('Atlas wants to connect on Provian');
    });
});

describe('provider acceptance and reconciliation', () => {
    it('distinguishes rejection, network ambiguity and accepted receipt', async () => {
        mockSend.mockResolvedValueOnce({ error: { statusCode: 429, name: 'rate_limit_exceeded', message: 'retry' }, data: null });
        expect(await sendWithReceipt('a@example.com','subject','html','text')).toEqual({ status: 'rejected' });
        mockSend.mockRejectedValueOnce(new Error('network timeout'));
        expect(await sendWithReceipt('a@example.com','subject','html','text')).toEqual({ status: 'uncertain' });
        mockSend.mockResolvedValueOnce({ data: { id: 'accepted-id' }, error: null });
        expect(await sendWithReceipt('a@example.com','subject','html','text',{},'stable-key')).toEqual({ status: 'accepted', id: 'accepted-id' });
        expect(mockSend.mock.calls.at(-1)[0].tags).toEqual([{ name: 'delivery_key', value: 'stable-key' }]);
    });
;
});
