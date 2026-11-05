/**
 * Unit tests for the setup-command builders (production-effect audit
 * 2026-08-16, item 5).
 *
 * The builders are the SINGLE source for every emitted "paste this line"
 * onboarding command. Pre-flip the @provian/* packages are unpublished
 * (npm E404), so a working command must be a zero-install call to the exact
 * live relay endpoint that consumes the embedded token — never an
 * `npx @provian/...` line.
 *
 * negative controls are IN-SUITE: the working-command predicate is shown
 * failing against the old npx template, and the idempotency-key canon binding
 * is shown failing against an out-of-bound key, so neither guard can pass
 * vacuously.
 */

import {
  buildDeviceRegisterCommand,
  mintCommandIdempotencyKey,
  resolveRelayUrl,
  DEFAULT_DEVICE_NAME,
  DEFAULT_RELAY_URL,
} from './setup-command';
// Single-source binding (self-referential-control rule): the minted key
// is validated by the SAME canon the register endpoint consumes, not by a
// re-typed copy of its regex.
import { hashDeviceRegistrationId } from '../routes/middleware/device-registration-id';

const TOKEN_64_HEX = 'a'.repeat(64);
const KEY_32_HEX = 'f'.repeat(32);

/**
 * What a pre-flip-workable emitted command must be. Encoded as a predicate so
 * the suite can demonstrate it FAILING on the old defective shape (negative
 * control) as well as passing on the builders' output.
 */
function commandViolations(command: string, expectedPath: string): string[] {
  const violations: string[] = [];
  if (/npx @provian\//.test(command)) {
    violations.push('references an unpublished npm package (E404 pre-flip)');
  }
  if (!command.startsWith('curl ')) {
    violations.push('not a zero-install curl line');
  }
  if (!command.includes(expectedPath)) {
    violations.push(`does not target the live consumer endpoint ${expectedPath}`);
  }
  if (command.includes('\n')) {
    violations.push('not a single paste-able line');
  }
  return violations;
}

/** Extract and parse the single-quoted JSON payload; THROWS if absent/broken. */
function parseJsonPayload(command: string): Record<string, unknown> {
  const match = command.match(/-d '(.*)'$/);
  if (!match) throw new Error('command has no -d JSON payload');
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe('buildDeviceRegisterCommand', () => {
  it('emits one workable curl line against POST /v1/devices/register', () => {
    const cmd = buildDeviceRegisterCommand({ token: TOKEN_64_HEX, idempotencyKey: KEY_32_HEX });
    expect(commandViolations(cmd, '/v1/devices/register')).toEqual([]);
    expect(cmd).toContain(`${DEFAULT_RELAY_URL}/v1/devices/register`);
    expect(cmd).toContain(`-H "Authorization: Bearer ${TOKEN_64_HEX}"`);
    expect(cmd).toContain(`-H "Idempotency-Key: ${KEY_32_HEX}"`);
    expect(cmd).toContain('-H "Content-Type: application/json"');
    expect(cmd).toContain('-X POST');
  });

  it('carries a JSON payload the register endpoint accepts (parseable, valid fields)', () => {
    const cmd = buildDeviceRegisterCommand({ token: TOKEN_64_HEX, idempotencyKey: KEY_32_HEX });
    const payload = parseJsonPayload(cmd);
    // coding_workstation is in the endpoint's VALID_DEVICE_TYPES; macos within
    // the 50-char platform bound; default name within the 100-char bound.
    expect(payload).toEqual({
      device_name: DEFAULT_DEVICE_NAME,
      device_type: 'coding_workstation',
      platform: 'macos',
    });
  });

  it('embeds a supplied device name verbatim when it is shell/JSON-inert', () => {
    const cmd = buildDeviceRegisterCommand({
      token: TOKEN_64_HEX,
      idempotencyKey: KEY_32_HEX,
      deviceName: 'Build box',
    });
    expect(parseJsonPayload(cmd).device_name).toBe('Build box');
  });

  it('strips shell/JSON-breaking characters from the device name so the line still parses', () => {
    const hostile = `Bob's "box" \\ $(rm -rf ~) \`whoami\``;
    const cmd = buildDeviceRegisterCommand({
      token: TOKEN_64_HEX,
      idempotencyKey: KEY_32_HEX,
      deviceName: hostile,
    });
    // The payload still parses — the emitted line was not broken open.
    const payload = parseJsonPayload(cmd);
    const name = payload.device_name as string;
    expect(name).not.toMatch(/['"\\$`]/);
    expect(name).toContain('Bobs');
    // No hostile character survives anywhere outside the fixed quoting.
    expect(cmd).not.toContain('$(');
    expect(cmd).not.toContain('`');
  });

  it('falls back to the default name when sanitization empties the input', () => {
    const cmd = buildDeviceRegisterCommand({
      token: TOKEN_64_HEX,
      idempotencyKey: KEY_32_HEX,
      deviceName: `'"\\$\``,
    });
    expect(parseJsonPayload(cmd).device_name).toBe(DEFAULT_DEVICE_NAME);
  });

  it('honours an explicit relayUrl and defaults to resolveRelayUrl()', () => {
    const cmd = buildDeviceRegisterCommand({
      token: TOKEN_64_HEX,
      idempotencyKey: KEY_32_HEX,
      relayUrl: 'https://staging.example.com',
    });
    expect(cmd).toContain('https://staging.example.com/v1/devices/register');
    const defaulted = buildDeviceRegisterCommand({ token: TOKEN_64_HEX, idempotencyKey: KEY_32_HEX });
    expect(defaulted).toContain(`${resolveRelayUrl()}/v1/devices/register`);
  });
});

describe('mintCommandIdempotencyKey', () => {
  it('mints a 32-hex key the register endpoint canon accepts (single-source binding)', () => {
    const key = mintCommandIdempotencyKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    // The REAL consumer-side canon (device-registration-id.ts) accepts it:
    // hashDeviceRegistrationId throws on any out-of-bound registration id.
    expect(() => hashDeviceRegistrationId(key)).not.toThrow();
  });

  it('mints unique keys', () => {
    const keys = new Set(Array.from({ length: 32 }, () => mintCommandIdempotencyKey()));
    expect(keys.size).toBe(32);
  });
});

describe('negative controls (every guard shown failing)', () => {
  it('the old npx template FAILS the workable-command predicate', () => {
    const oldShape = `npx @provian/agent-sdk register-device --token ${TOKEN_64_HEX}`;
    const violations = commandViolations(oldShape, '/v1/devices/register');
    expect(violations).toContain('references an unpublished npm package (E404 pre-flip)');
    expect(violations).toContain('not a zero-install curl line');
    expect(violations).toContain('does not target the live consumer endpoint /v1/devices/register');
  });


  it('the idempotency-key canon REJECTS an out-of-bound key (the accept test is not vacuous)', () => {
    expect(() => hashDeviceRegistrationId('short')).toThrow('invalid_device_registration_id');
    expect(() => hashDeviceRegistrationId('has spaces which are outside the canon')).toThrow(
      'invalid_device_registration_id',
    );
  });

  it('the payload parser THROWS on a command without a JSON body (no silent pass)', () => {
    expect(() => parseJsonPayload('npx @provian/agent-sdk register-device --token x')).toThrow(
      'command has no -d JSON payload',
    );
  });
});
