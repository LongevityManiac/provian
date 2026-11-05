const mockSend = jest.fn();
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })) }));
process.env.RESEND_API_KEY = 'test_re_dummy_key';
import { sendAgentInvite, sendBeneficiaryInvite, sendConnectCommand, escapeHtml } from './email';
import { EMAIL_LOCALES, emailLanguage } from './core/email/language';

describe('all user-facing emails in the app locales', () => {
  beforeEach(() => mockSend.mockReset().mockResolvedValue({ error: null }));
  it('has exact app locale/key/placeholder parity and actual translations', () => {
    expect(Object.keys(EMAIL_LOCALES).sort()).toEqual(['en','es','fr','hi','id','ja','ko','pt','sw','tl','vi','zh'].sort());
    for (const [language, copy] of Object.entries(EMAIL_LOCALES)) {
      expect(Object.keys(copy).sort()).toEqual(Object.keys(EMAIL_LOCALES.en).sort());
      for (const key of Object.keys(copy) as (keyof typeof copy)[]) {
        expect(copy[key].match(/\{\{\w+\}\}/g) ?? []).toEqual(EMAIL_LOCALES.en[key].match(/\{\{\w+\}\}/g) ?? []);
        expect(copy[key].length).toBeGreaterThan(0);
        if (language !== 'en') expect(copy[key]).not.toBe(EMAIL_LOCALES.en[key]);
      }
    }
    // Negative control: a locale/key omission cannot pass the parity assertion.
    const broken = { ...EMAIL_LOCALES.es }; delete (broken as Partial<typeof broken>).setupSubject;
    expect(Object.keys(broken).sort()).not.toEqual(Object.keys(EMAIL_LOCALES.en).sort());
  });
  it('agent setup email: on a computer whose agent keeps no session records, the agent records its launcher itself (; the emailed line records none)', () => {
    expect(EMAIL_LOCALES.en.agentAfter).toMatch(/keeps no session records on that computer, it runs "\$HOME\/\.provian\/bin\/provian" process-lane record once from its own harness there; from then on each command it runs there is witnessed and creates one PE\./);
    for (const copy of Object.values(EMAIL_LOCALES)) {
      // Each locale keeps the tool-calling sentence and gains the process-lane sentence: three or more sentences.
      expect(copy.agentAfter.split(/[.。।]/u).filter((part) => part.trim().length > 0).length).toBeGreaterThanOrEqual(4);
      expect(copy.agentAfter).toContain('PE');
      // The command is a literal the agent runs: never translated.
      expect(copy.agentAfter).toContain('"$HOME/.provian/bin/provian" process-lane record');
    }
  });
  it.each([undefined, null, 'xx', 'fr-CA', '__proto__', {}, 123])('unsupported %p renders English', value => {
    expect(emailLanguage(value)).toBe('en');
  });
  it.each(Object.keys(EMAIL_LOCALES))('renders all five variants in %s, without translating credentials or links', async language => {
    const command = 'curl https://example.com/setup?token=SECRET&device=abc';
    const windows = 'irm https://example.com/setup.ps1?token=SECRET';
    const values = EMAIL_LOCALES[emailLanguage(language)];
    for (const [kind, requester] of [['device','app'],['agent_device','app'],['agent_device','agent']] as const) {
      await sendConnectCommand('person@example.com', kind, command, Date.now() + 3600000, '<script>bad</script>', 'Office', windows, requester, language);
      const payload = mockSend.mock.calls.at(-1)![0];
      expect(payload.subject).toBe(values.setupSubject);
      expect(payload.html).toContain(`lang="${language}"`);
      expect(payload.text).toContain(command);
      expect(payload.text).toContain(values.batchCadence);
      expect(payload.text).toContain(values.settlementCadence);
      expect(payload.html).toContain(escapeHtml(values.batchCadence));
      expect(payload.html).toContain(escapeHtml(values.settlementCadence));
      expect(payload.html).toContain(command.replace(/&/g, '&amp;'));
      expect(payload.html).not.toContain('<script>bad</script>');
      expect(payload.text).toContain(requester === 'agent' ? values.requestedAgent : values.requestedApp);
      if (kind === 'agent_device') expect(payload.text).toContain(windows);
    }
    for (const beneficiary of [false,true]) {
      if (beneficiary) await sendBeneficiaryInvite('person@example.com','Agent <script>','invite123','wallet_aw_123',0,123,'UNSUB_TOKEN','<b>note</b>',language);
      else await sendAgentInvite('person@example.com','Agent <script>','invite123','UNSUB_TOKEN','wallet_aw_123',language);
      const payload = mockSend.mock.calls.at(-1)![0];
      expect(payload.subject).toContain('Agent script');
      expect(payload.html).toContain(`lang="${language}"`);
      expect(payload.html).toContain('invite=invite123&amp;agent_wallet=wallet_aw_123');
      expect(payload.text).toContain('invite=invite123&agent_wallet=wallet_aw_123');
      expect(payload.text).toContain(values.batchCadence);
      expect(payload.text).toContain(values.settlementCadence);
      expect(payload.html).toContain(escapeHtml(values.batchCadence));
      expect(payload.html).toContain(escapeHtml(values.settlementCadence));
      expect(payload.html).toContain(values.unsubscribe);
      expect(payload.headers['List-Unsubscribe']).toContain('token=UNSUB_TOKEN');
      expect(payload.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(payload.html).not.toContain('<script>');
      expect(payload.html).toContain(escapeHtml('Agent <script>'));
    }
  });
});
