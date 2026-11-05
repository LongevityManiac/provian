/** One bounded identifier grammar shared by PE ingress and monetary policy. */

export const MAX_POLICY_ACTION_TYPE_LENGTH = 200;
export const POLICY_ACTION_TYPE_PATTERN =
  /^(?:[A-Za-z][A-Za-z0-9_]*|[a-z][a-z0-9]*:[a-z][a-z0-9_]*)$/;

export function isValidPolicyActionType(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_POLICY_ACTION_TYPE_LENGTH
    && POLICY_ACTION_TYPE_PATTERN.test(value);
}

export function policyActionTypeValidationError(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'action_type is required';
  if (value.length > MAX_POLICY_ACTION_TYPE_LENGTH) {
    return `action_type must be at most ${MAX_POLICY_ACTION_TYPE_LENGTH} characters`;
  }
  if (!POLICY_ACTION_TYPE_PATTERN.test(value)) {
    return 'action_type must be a flat identifier or lowercase namespace:action_name';
  }
  return null;
}
