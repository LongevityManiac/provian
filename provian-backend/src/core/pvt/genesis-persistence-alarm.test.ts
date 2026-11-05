/**
 * The Genesis persistence alarm.
 *
 * The failure this guards against is silence, so the risk in testing it is the
 * mirror image: an alarm that fires unconditionally would satisfy every
 * "it alarms" assertion while proving nothing. Each alarming case below is
 * paired with the single input change that returns it to quiet, and the last
 * test asserts BOTH populations are non-empty.
 */

import {
  evaluateGenesisPersistenceAlarm,
  isGenesisPersistenceAlarm,
  buildGenesisPersistenceStatus,
  formatGenesisPersistenceBanner,
  genesisPersistenceRemedy,
  reportGenesisPersistenceAtStartup,
  GENESIS_PERSISTENCE_STATUS_COLLECTION,
  GENESIS_PERSISTENCE_STATUS_DOCUMENT,
  type GenesisPersistenceAlarmInput,
  type GenesisPersistenceVerdict,
} from './genesis-persistence-alarm';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import type { Firestore } from 'firebase-admin/firestore';

const GOOD_KEY = `ssh-ed25519 ${'A'.repeat(68)} frank@provian`;
/**
 * The EXACT shapes production carries, read off the running relay
 * (`provian-api`, 2026-07-26). Both are public values. Pinning the real shapes
 * is what stops this alarm from firing on the healthy case — the first draft
 * required a BARE 64-hex digest and would have reported the live, correct
 * `sha256:`-prefixed value as malformed.
 */
const GOOD_SHA = 'sha256:200b11f0842bdf578eeb2ebb4859c9fcd3ba870159e53d6747ffaff893462974';
const PROD_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAf9JCgexoRd6ZMoF1oJOIS25hmoqPriUTxlz3rVZ6e';

function input(over: Partial<GenesisPersistenceAlarmInput> = {}): GenesisPersistenceAlarmInput {
  return {
    enqueueArmed: true,
    approvalPublicKeyRaw: GOOD_KEY,
    approvalKeySha256Raw: GOOD_SHA,
    persistLive: true,
    ...over,
  };
}

describe('evaluateGenesisPersistenceAlarm', () => {
  it('QUIET on the EXACT shapes production carries today', () => {
    // Read off the live relay. If this ever alarms, the alarm is wrong, not
    // production — which is the failure the first draft of this module had.
    expect(evaluateGenesisPersistenceAlarm(input({
      approvalPublicKeyRaw: PROD_PUBLIC_KEY,
      approvalKeySha256Raw: GOOD_SHA,
    }))).toBe('quiet_persistence_live');
  });

  it('QUIET when the healthy production shape holds', () => {
    expect(evaluateGenesisPersistenceAlarm(input())).toBe('quiet_persistence_live');
  });

  it('QUIET when the window is not armed — nothing is at risk', () => {
    expect(evaluateGenesisPersistenceAlarm(input({ enqueueArmed: false, persistLive: false })))
      .toBe('quiet_window_unarmed');
  });

  // ---- each alarm, paired with the one input that silences it --------------

  it.each<[string, Partial<GenesisPersistenceAlarmInput>, GenesisPersistenceVerdict]>([
    ['public key ABSENT', { approvalPublicKeyRaw: undefined }, 'alarm_approval_env_absent'],
    ['public key EMPTY', { approvalPublicKeyRaw: '' }, 'alarm_approval_env_absent'],
    ['public key WHITESPACE', { approvalPublicKeyRaw: '   ' }, 'alarm_approval_env_absent'],
    ['sha ABSENT', { approvalKeySha256Raw: undefined }, 'alarm_approval_env_absent'],
    ['sha EMPTY', { approvalKeySha256Raw: '' }, 'alarm_approval_env_absent'],
    ['public key TRUNCATED', { approvalPublicKeyRaw: 'ssh-ed25519 AAAA' }, 'alarm_approval_env_malformed'],
    ['public key wrong ALGO', { approvalPublicKeyRaw: `ssh-rsa ${'A'.repeat(68)}` }, 'alarm_approval_env_malformed'],
    ['public key QUOTED', { approvalPublicKeyRaw: `"${GOOD_KEY}"` }, 'alarm_approval_env_malformed'],
    ['sha too short', { approvalKeySha256Raw: 'abc123' }, 'alarm_approval_env_malformed'],
    ['sha not hex', { approvalKeySha256Raw: 'z'.repeat(64) }, 'alarm_approval_env_malformed'],
    ['sha with 0x prefix', { approvalKeySha256Raw: `0x${'a'.repeat(64)}` }, 'alarm_approval_env_malformed'],
    ['sha BARE hex, missing the sha256: prefix', { approvalKeySha256Raw: 'a'.repeat(64) }, 'alarm_approval_env_malformed'],
    ['sha UPPERCASE hex (the verifier is case-sensitive)', { approvalKeySha256Raw: `sha256:${'A'.repeat(64)}` }, 'alarm_approval_env_malformed'],
    ['sha with an uppercase SHA256: prefix', { approvalKeySha256Raw: `SHA256:${'a'.repeat(64)}` }, 'alarm_approval_env_malformed'],
    ['persistence NOT live', { persistLive: false }, 'alarm_persistence_not_live'],
    ['persistence UNKNOWN', { persistLive: undefined }, 'alarm_persistence_unknown'],
  ])('ALARMS on %s', (_label, over, expected) => {
    const verdict = evaluateGenesisPersistenceAlarm(input(over));
    expect(verdict).toBe(expected);
    expect(isGenesisPersistenceAlarm(verdict)).toBe(true);
    // PAIRED CONTROL: restoring that one field returns it to quiet, so the
    // alarm is attributable to exactly the field under test.
    expect(evaluateGenesisPersistenceAlarm(input())).toBe('quiet_persistence_live');
  });

  it('UNKNOWN is not collapsed into false — it has its own verdict', () => {
    expect(evaluateGenesisPersistenceAlarm(input({ persistLive: undefined })))
      .not.toBe(evaluateGenesisPersistenceAlarm(input({ persistLive: false })));
  });

  it('the env check runs BEFORE the persistence probe, so a missing key is named as such', () => {
    // Both are broken; the report must name the cause an operator can fix.
    expect(evaluateGenesisPersistenceAlarm(input({
      approvalPublicKeyRaw: undefined, persistLive: false,
    }))).toBe('alarm_approval_env_absent');
  });

  it('BOTH populations are non-empty — the evaluator is not a constant', () => {
    const verdicts = [
      evaluateGenesisPersistenceAlarm(input()),
      evaluateGenesisPersistenceAlarm(input({ enqueueArmed: false })),
      evaluateGenesisPersistenceAlarm(input({ approvalPublicKeyRaw: undefined })),
      evaluateGenesisPersistenceAlarm(input({ persistLive: false })),
    ].map(isGenesisPersistenceAlarm);
    expect(verdicts.filter(Boolean).length).toBe(2);
    expect(verdicts.filter((v) => !v).length).toBe(2);
  });
});

describe('the status record', () => {
  it('reports presence, never a key VALUE', () => {
    const status = buildGenesisPersistenceStatus(input(), 1_700_000_000_000);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(GOOD_KEY);
    expect(serialized).not.toContain(GOOD_SHA);
    expect(status.approval_public_key_present).toBe(true);
    expect(status.approval_key_sha256_present).toBe(true);
  });

  it('records UNKNOWN persistence as null, distinct from false', () => {
    expect(buildGenesisPersistenceStatus(input({ persistLive: undefined }), 1).persist_live).toBeNull();
    expect(buildGenesisPersistenceStatus(input({ persistLive: false }), 1).persist_live).toBe(false);
  });

  it('the malformed remedy tells the operator the shape the VERIFIER actually accepts', () => {
    // The first draft told the operator to set a BARE 64-hex digest — which this
    // module classifies as malformed and the verifier rejects. An operator who
    // followed it would get a permanently alarming relay AND an approval
    // verifier that refuses every signature. The remedy is the only instruction
    // they get (it is written verbatim into the status doc and the banner), so
    // it is asserted against the verifier's own pattern.
    const remedy = genesisPersistenceRemedy('alarm_approval_env_malformed');
    expect(remedy).toMatch(/sha256:/);
    expect(remedy).toMatch(/LOWERCASE/);
    expect(remedy).not.toMatch(/bare 64-char/);
    // And following it produces a value this module calls QUIET.
    expect(evaluateGenesisPersistenceAlarm(input({
      approvalKeySha256Raw: `sha256:${'0123456789abcdef'.repeat(4)}`,
    }))).toBe('quiet_persistence_live');
  });

  it('carries the remedy, so the document alone is actionable', () => {
    const status = buildGenesisPersistenceStatus(input({ approvalPublicKeyRaw: undefined }), 1);
    expect(status.remedy).toMatch(/FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY/);
  });

  it('every verdict has a distinct remedy — none falls through to a generic string', () => {
    const verdicts: GenesisPersistenceVerdict[] = [
      'quiet_window_unarmed', 'quiet_persistence_live', 'alarm_approval_env_absent',
      'alarm_approval_env_malformed', 'alarm_persistence_not_live', 'alarm_persistence_unknown',
    ];
    const remedies = verdicts.map(genesisPersistenceRemedy);
    expect(new Set(remedies).size).toBe(verdicts.length);
  });

  it('the banner is multi-line and names the verdict and the readable surface', () => {
    const banner = formatGenesisPersistenceBanner('alarm_approval_env_absent');
    expect(banner.split('\n').length).toBeGreaterThanOrEqual(7);
    expect(banner).toContain('ALARM');
    expect(banner).toContain('alarm_approval_env_absent');
    expect(banner).toContain(`${GENESIS_PERSISTENCE_STATUS_COLLECTION}/${GENESIS_PERSISTENCE_STATUS_DOCUMENT}`);
  });

  it('PAIRED CONTROL: the quiet banner does NOT say ALARM', () => {
    expect(formatGenesisPersistenceBanner('quiet_persistence_live')).not.toContain('ALARM');
  });
});

describe('reportGenesisPersistenceAtStartup', () => {
  const db = (fake: ReturnType<typeof createFakeFirestore>) => fake as unknown as Firestore;

  it('writes the readable status document and prints the banner', async () => {
    const fake = createFakeFirestore();
    const lines: string[] = [];
    const status = await reportGenesisPersistenceAtStartup(
      db(fake),
      async () => true,
      { FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY: GOOD_KEY, FRANK_PVT_APPROVAL_SSH_KEY_SHA256: GOOD_SHA },
      () => 1_700_000_000_000,
      (m) => lines.push(m),
    );
    const stored = fake.store.get(
      `${GENESIS_PERSISTENCE_STATUS_COLLECTION}/${GENESIS_PERSISTENCE_STATUS_DOCUMENT}`,
    );
    expect(stored).toMatchObject({ schema_version: 'genesis-persistence-status/v1' });
    expect(status.observed_at_ms).toBe(1_700_000_000_000);
    expect(lines.join('\n')).toContain('[genesis-persistence]');
  });

  it('a THROWING probe alarms as UNKNOWN and does not throw out of the reporter', async () => {
    const fake = createFakeFirestore();
    const status = await reportGenesisPersistenceAtStartup(
      db(fake),
      async () => { throw new Error('firestore unavailable'); },
      { FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY: GOOD_KEY, FRANK_PVT_APPROVAL_SSH_KEY_SHA256: GOOD_SHA },
      () => 1,
      () => {},
    );
    expect(status.verdict).toBe('alarm_persistence_unknown');
    expect(status.alarm).toBe(true);
  });

  it('an ABSENT approval env alarms even though the probe answers cleanly', async () => {
    const fake = createFakeFirestore();
    const status = await reportGenesisPersistenceAtStartup(
      db(fake), async () => true, {}, () => 1, () => {},
    );
    expect(status.verdict).toBe('alarm_approval_env_absent');
  });

  it('a FAILING status write does not throw — the banner survives', async () => {
    const lines: string[] = [];
    const poisoned = {
      collection: () => ({ doc: () => ({ set: async () => { throw new Error('denied'); } }) }),
    } as unknown as Firestore;
    const status = await reportGenesisPersistenceAtStartup(
      poisoned,
      async () => true,
      { FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY: GOOD_KEY, FRANK_PVT_APPROVAL_SSH_KEY_SHA256: GOOD_SHA },
      () => 1,
      (m) => lines.push(m),
    );
    expect(status.verdict).toBe('quiet_persistence_live');
    expect(lines.join('\n')).toContain('status document write FAILED');
  });

  it('runs INDEPENDENTLY of PUBLIC_LAUNCH — same verdict either way', async () => {
    // The gap being closed is that the launch guard short-circuits on
    // PUBLIC_LAUNCH=false, which is exactly the state production is in. This
    // asserts the behaviour, not the signature: the SAME broken env produces
    // the SAME alarm with the launch flag on and off.
    const run = async (publicLaunch: string) => (await reportGenesisPersistenceAtStartup(
      db(createFakeFirestore()),
      async () => true,
      { PUBLIC_LAUNCH: publicLaunch }, // approval env deliberately absent
      () => 1,
      () => {},
    )).verdict;
    expect(await run('false')).toBe('alarm_approval_env_absent');
    expect(await run('true')).toBe('alarm_approval_env_absent');
  });

  it('and it reads no launch flag at all', () => {
    // Belt and braces on the above: the source takes (db, probe, env, now, log)
    // and never consults a launch variable.
    expect(reportGenesisPersistenceAtStartup.toString()).not.toMatch(/publicLaunch|PUBLIC_LAUNCH/);
  });
});
