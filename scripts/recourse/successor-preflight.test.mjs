import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256, toUtf8Bytes } from 'ethers';
import { successorFixture } from './successor-plan.test.mjs';
import { buildSuccessorPlan } from './successor-plan.mjs';
import { assertFreshSuccessorPlan, readSuccessorArtifacts } from './successor-preflight.mjs';

test('fresh reconstruction compares every executable field and a nonempty monetary population', () => {
  const facts = successorFixture(), plan = buildSuccessorPlan(facts);
  assert.deepEqual(assertFreshSuccessorPlan(plan, facts), plan);
  const changes = [
    p => { p.snapshot.balances[0].amount = '701'; },
    p => { p.snapshot.balances[0].destination = '0x' + 'ff'.repeat(20); },
    p => { p.snapshot.history.pop(); },
    p => { p.creations[0].data += '00'; },
    p => { p.configuration[0].from = p.deployer; },
    p => { p.imports[0].data += '00'; },
    p => { p.activation.value = '1'; },
    p => { p.identityAttestor = p.admin; },
    p => { p.submitter = p.admin; },
    p => { p.pointerAuthority = p.admin; },
    p => { p.components[0] = p.pointerAuthority; },
    p => { p.retireAfterImport.push(p.pointerAuthority); },
    p => { p.addresses.ProvianRecourseKernel = p.pointerAuthority; },
    p => { p.ruleHash = '0x' + 'ff'.repeat(32); },
    p => { p.extra = 'unreviewed'; },
  ];
  for (const change of changes) {
    const edited = structuredClone(plan); change(edited);
    const body = { ...edited }; delete body.digest;
    edited.digest = sha256(toUtf8Bytes(JSON.stringify(body)));
    assert.throws(() => assertFreshSuccessorPlan(edited, facts), /plan_changed/);
  }
  const empty = successorFixture(); empty.snapshot.history = [];
  assert.throws(() => assertFreshSuccessorPlan(buildSuccessorPlan(empty), empty), /empty_population/);
});
test('current artifact loader binds a nonempty compilation to all its source files', () => {
  const root = new URL('../..', import.meta.url).pathname, artifacts = readSuccessorArtifacts(root);
  assert.ok(Object.keys(artifacts).length >= 18);
  for (const artifact of Object.values(artifacts)) {
    assert.ok(Object.keys(artifact.metadata.sources).length > 0);
    assert.ok(artifact.bytecode.object.length > 2);
  }
  // Missing build trees fail closed rather than returning an empty inventory.
  assert.throws(() => readSuccessorArtifacts('/tmp/provian-no-such-artifact-root'));
});
test('the actual signed-rule command accepts the held approval and refuses rehashed altered economics', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const signed = JSON.parse(readFileSync(resolve(root, 'config/policy/recourse-membership.signed.json')));
  // SSHSIG embeds its public verification key. No private signing key is used.
  const bytes = Buffer.from(signed.signature.armored_signature.split('\n').slice(1, -2).join(''), 'base64');
  const publicKey = 'ssh-ed25519 ' + bytes.subarray(14, 14 + bytes.readUInt32BE(10)).toString('base64');
  const directory = mkdtempSync(join(tmpdir(), 'successor-rule-control-'));
  try {
    const input = join(directory, 'input.json'), output = join(directory, 'verified.json');
    const verify = () => execFileSync(resolve(root, 'provian-backend/node_modules/.bin/tsx'),
      [resolve(root, 'provian-backend/scripts/recourse-membership-rule.ts'), 'verify-signed', input, output],
      { cwd: root, env: { ...process.env, FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY: publicKey }, stdio: 'pipe', timeout: 30000 });
    writeFileSync(input, JSON.stringify(signed)); verify();
    assert.deepEqual(JSON.parse(readFileSync(output)), signed); rmSync(output);
    signed.rule.earningsBps += 1;
    signed.ruleHash = sha256(toUtf8Bytes('Provian Recourse Pool membership rule\n' + JSON.stringify(signed.rule) + '\n'));
    writeFileSync(input, JSON.stringify(signed));
    assert.throws(verify); assert.equal(existsSync(output), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
