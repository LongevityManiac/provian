import { describe, expect, it } from 'vitest';
import { CommonsInstitutions } from './commons-institutions';
import { runInviteDevice } from './scripts/invite-device-flow';
import { parseArgs } from './scripts/invite-device';
describe('agent email language forwarding', () => {
  it('forwards all three SDK invitation languages and the device CLI flag', async () => {
    const bodies: Record<string, unknown>[] = []; const paths: string[] = [];
    const fetchImpl = (async (input: string, init: RequestInit) => {
      paths.push(input); bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ sent: true, expires_at: 123 }), { status: 200 });
    }) as typeof fetch;
    const client = new CommonsInstitutions({ relayUrl: 'https://relay.test', walletId: 'wallet_aw_123', apiKey: 'key', apiSecret: 'secret', fetch: fetchImpl });
    await client.invite({ email: 'person@example.com', language: 'fr' });
    await client.inviteHuman({ humanEmail: 'person@example.com', language: 'hi' });
    await client.inviteDevice({ email: 'person@example.com', language: 'ko' });
    expect(bodies.map(b => b.language)).toEqual(['fr','hi','ko']);
    expect(paths.map(p => p.split('/').at(-1))).toEqual(['invite','invite-human','device-invite']);
    const args = parseArgs(['--email','person@example.com','--language','vi']);
    await runInviteDevice({ email: args.email!, language: args.language, walletId: 'wallet_aw_123', relayUrl: 'https://relay.test', creds: { apiKey: 'key', apiSecret: 'secret' }, fetch: fetchImpl });
    expect(bodies.at(-1)?.language).toBe('vi');
    // Omitting language must keep existing API calls compatible.
    await client.inviteDevice({ email: 'person@example.com' });
    expect(bodies.at(-1)).not.toHaveProperty('language');
  });
});
