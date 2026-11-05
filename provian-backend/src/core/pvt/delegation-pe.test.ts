/**
 * Delegation is a running total on the human (PE meter, item 8). What remains here is the rule
 * of which linked-agent acts count toward it.
 */
import { describe, expect, it } from '@jest/globals';
import { isDelegationQualifying } from './delegation-pe';

describe('isDelegationQualifying', () => {
  it('a named work-product type qualifies', () => {
    expect(isDelegationQualifying('agent_work_product_code')).toBe(true);
    expect(isDelegationQualifying('agent_commit')).toBe(true);
  });
  it('RED: the delegation record itself and a low-tier setup act do not', () => {
    expect(isDelegationQualifying('agent_work_delegated')).toBe(false);
    expect(isDelegationQualifying('device_register')).toBe(false);
  });
});
