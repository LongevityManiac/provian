import fs from 'fs';
import path from 'path';
import {
  MAX_POLICY_ACTION_TYPE_LENGTH,
  isValidPolicyActionType,
  policyActionTypeValidationError,
} from './action-type-syntax';

describe('shared PE action-type syntax', () => {
  test.each([
    'wallet_created',
    'REVOKE_APPROVAL',
    'thirdparty:new_action',
  ])('accepts %s consistently', (value) => {
    expect(isValidPolicyActionType(value)).toBe(true);
    expect(policyActionTypeValidationError(value)).toBeNull();
  });

  test.each([
    '',
    'not valid',
    'namespace:Uppercase',
    'a/b',
    `a${'b'.repeat(MAX_POLICY_ACTION_TYPE_LENGTH)}`,
  ])('rejects malformed or oversized value %p before persistence', (value) => {
    expect(isValidPolicyActionType(value)).toBe(false);
    expect(policyActionTypeValidationError(value)).not.toBeNull();
  });

  test('the device batch act admission validates the action type before pricing it', () => {
    // The relay action ingress this used to pin (`POST /v1/relay/action`) is retired
    // (PE meter, 2026-10-03). The live ingress for a caller-named action type is the
    // device batch's act admission; an unvalidated action_type must never reach pricing.
    const deviceAct = fs.readFileSync(path.join(__dirname, '..', '..', 'meter', 'device-act.ts'), 'utf8');
    const validation = deviceAct.indexOf('const actionTypeError = policyActionTypeValidationError(actionType);');
    const refusal = deviceAct.indexOf("if (actionTypeError) return { ok: false, reason: 'invalid_action_type' };");
    const pricing = deviceAct.indexOf('const replicationPack = obj(pricing.replication_pack);');
    expect(validation).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeGreaterThan(validation);
    expect(pricing).toBeGreaterThan(refusal);
  });
});
