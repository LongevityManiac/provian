import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBootstrapRegistration, withTransientRetry } from './bootstrap-registration';
import { loadOrCreatePendingAgentWalletRegistration, peekPendingAgentWalletRegistration } from './pending-wallet-registration';

const RELAY = 'https://relay.example';
const PASS = 'local-keystore-secret-for-tests';
const OLD = 'PROV-AAAA-2222';
const NEW = 'PROV-BBBB-3333';
let dir: string, file: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-reg-')); file = path.join(dir, 'pending.json'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A relay stub answering the challenge with `registration_exists`, recording what it was asked. */
function relay(exists: boolean | 'unreachable' | 'no-flag') {
  const asked: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    asked.push(String(input));
    if (exists === 'unreachable') throw new Error('fetch failed');
    const body = exists === 'no-flag' ? { challenge_id: 'c', challenge: 'x' } : { challenge_id: 'c', challenge: 'x', registration_exists: exists };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return { asked, fetchImpl };
}

async function leaveFailedAttempt(agentName = 'grokbox-a', token = OLD, agentId = 'agent-0123456789abcdef') {
  await loadOrCreatePendingAgentWalletRegistration({ relayUrl: RELAY, agentId, agentName, platform: 'sdk', constitutionAccepted: false, connectionToken: token }, PASS, file, { N: 1024, r: 8, p: 1 } as never);
  return peekPendingAgentWalletRegistration(file)!;
}

const input = (over: Partial<Parameters<typeof loadBootstrapRegistration>[0]> = {}) => ({
  relayUrl: RELAY, agentId: 'agent-0123456789abcdef', agentName: 'grokbox-a', connectionToken: NEW, ...over,
});

describe('install re-run after a failed attempt', () => {
  it('a fresh box prepares a registration with this run\'s code', async () => {
    const { fetchImpl, asked } = relay(false);
    await loadBootstrapRegistration(input(), { passphrase: PASS, filePath: file, fetchImpl });
    expect(peekPendingAgentWalletRegistration(file)?.connectionToken).toBe(NEW);
    expect(asked).toEqual([]);
  });

  it('a new code, and the relay never received the old attempt: set aside, re-prepared with the new code', async () => {
    const before = await leaveFailedAttempt();
    const { fetchImpl } = relay(false);
    await loadBootstrapRegistration(input(), { passphrase: PASS, filePath: file, fetchImpl });
    const after = peekPendingAgentWalletRegistration(file)!;
    expect(after.connectionToken).toBe(NEW);
    expect(after.registrationId).not.toBe(before.registrationId);
    expect(fs.readdirSync(dir).some(f => f.startsWith('pending.json.unsent-'))).toBe(true); // kept, not deleted
  });

  it('a new code, but the relay holds the old attempt: resumed exactly as first sent', async () => {
    const before = await leaveFailedAttempt();
    const { fetchImpl } = relay(true);
    await loadBootstrapRegistration(input(), { passphrase: PASS, filePath: file, fetchImpl });
    const after = peekPendingAgentWalletRegistration(file)!;
    expect(after.registrationId).toBe(before.registrationId);
    expect(after.connectionToken).toBe(OLD);
  });

  it('the relay cannot say (unreachable / no flag): resumed as sealed', async () => {
    for (const state of ['unreachable', 'no-flag'] as const) {
      fs.rmSync(file, { force: true });
      const before = await leaveFailedAttempt();
      await loadBootstrapRegistration(input(), { passphrase: PASS, filePath: file, fetchImpl: relay(state).fetchImpl });
      expect(peekPendingAgentWalletRegistration(file)!.registrationId).toBe(before.registrationId);
    }
  });

  it('the hostname changed and the relay holds it: resumes under the sealed name instead of refusing', async () => {
    const before = await leaveFailedAttempt('grokbox-a', NEW);
    const { fetchImpl } = relay(true);
    await expect(loadBootstrapRegistration(input({ agentName: 'grokbox-b' }), { passphrase: PASS, filePath: file, fetchImpl })).resolves.toBeDefined();
    expect(peekPendingAgentWalletRegistration(file)!.registrationId).toBe(before.registrationId);
  });

  it('RED control: the plain loader refuses a renamed host — the failure the re-run used to hit', async () => {
    await leaveFailedAttempt('grokbox-a', NEW);
    await expect(loadOrCreatePendingAgentWalletRegistration({ relayUrl: RELAY, agentId: 'agent-0123456789abcdef', agentName: 'grokbox-b', platform: 'sdk', constitutionAccepted: false, connectionToken: NEW }, PASS, file))
      .rejects.toThrow(/does not match this agent\/config/);
  });

  it('the local secret is gone: an unsent attempt is set aside; one the relay holds is refused plainly', async () => {
    await leaveFailedAttempt('grokbox-a', OLD, 'agent-ffffffffffffffff');
    await loadBootstrapRegistration(input(), { passphrase: PASS, filePath: file, fetchImpl: relay(false).fetchImpl });
    expect(peekPendingAgentWalletRegistration(file)!.agentId).toBe('agent-0123456789abcdef');

    fs.rmSync(file);
    await leaveFailedAttempt('grokbox-a', OLD, 'agent-ffffffffffffffff');
    await expect(loadBootstrapRegistration(input(), { passphrase: PASS, filePath: file, fetchImpl: relay(true).fetchImpl }))
      .rejects.toMatchObject({ code: 'PENDING_REGISTRATION_SECRET_LOST' });
  });

  it('an unreadable leftover is set aside, never deleted', async () => {
    fs.writeFileSync(file, '{"truncated":');
    await loadBootstrapRegistration(input(), { passphrase: PASS, filePath: file, fetchImpl: relay(false).fetchImpl });
    expect(peekPendingAgentWalletRegistration(file)!.connectionToken).toBe(NEW);
    expect(fs.readdirSync(dir).filter(f => f.includes('.unsent-')).length).toBe(1);
  });
});

describe('withTransientRetry', () => {
  const sleep = async () => undefined;
  it('retries a transit failure or a 5xx, then succeeds', async () => {
    let n = 0;
    const out = await withTransientRetry(async () => {
      n++;
      if (n === 1) throw Object.assign(new Error('x'), { code: 'CONNECTION_ERROR' });
      if (n === 2) throw Object.assign(new Error('x'), { code: 'HTTP_503' });
      return 'ok';
    }, { sleep });
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });
  it('never retries a 4xx or a local error', async () => {
    for (const code of ['HTTP_409', 'PENDING_REGISTRATION_SECRET_LOST', undefined]) {
      let n = 0;
      await expect(withTransientRetry(async () => { n++; throw Object.assign(new Error('x'), { code }); }, { sleep })).rejects.toThrow();
      expect(n).toBe(1);
    }
  });
});
