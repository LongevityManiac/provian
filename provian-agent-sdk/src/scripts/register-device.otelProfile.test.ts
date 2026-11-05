/**
 * writeOTelToProfile — the shell-profile OTel block must point agent
 * frameworks at the LOCAL observer OTLP receiver (OTelPlugin, 127.0.0.1:4318),
 * never at the relay.
 *
 * Regression (found 2026-07-07): the block wrote
 * OTEL_EXPORTER_OTLP_ENDPOINT=${relayUrl}/v1/otel — an endpoint that has
 * never existed on the relay (live 404) — so every OTel-instrumented
 * framework launched from a profile-sourced shell exported spans to a dead
 * URL, bypassing the observer that actually turns spans into PEs. It also
 * exported the DeviceKey credentials as OTLP headers toward whatever the
 * endpoint env resolved to.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeOTelToProfile } from './register-device';
import { OTLP_DEFAULT_PORT } from '../observer/plugins/OTelPlugin';

const START = '# --- Provian OTel Environment Start ---';
const END = '# --- Provian OTel Environment End ---';

describe('writeOTelToProfile', () => {
  let dir: string;
  let profile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-otel-profile-'));
    profile = path.join(dir, '.zshrc');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the local observer OTLP receiver endpoint, no relay URL, no credential headers', () => {
    writeOTelToProfile(profile);
    const content = fs.readFileSync(profile, 'utf-8');

    expect(content).toContain(START);
    expect(content).toContain(END);
    expect(content).toContain(`export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${OTLP_DEFAULT_PORT}`);
    expect(content).toContain('export OTEL_SERVICE_NAME=provian-agent');
    // The dead relay endpoint and the credential-leaking header line must
    // never come back.
    expect(content).not.toContain('/v1/otel');
    expect(content).not.toContain('OTEL_EXPORTER_OTLP_HEADERS');
    expect(content).not.toContain('DeviceKey');
  });

  it('replaces a stale legacy block (relay endpoint + auth headers) in place', () => {
    const legacy = [
      '# my shell config',
      'alias ll="ls -la"',
      '',
      START,
      'export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.provian.ai/v1/otel',
      'export OTEL_EXPORTER_OTLP_HEADERS="Authorization=DeviceKey $PROVIAN_DEVICE_KEY:$PROVIAN_DEVICE_SECRET"',
      'export OTEL_SERVICE_NAME=provian-agent',
      END,
      '',
      '# trailing user content',
    ].join('\n');
    fs.writeFileSync(profile, legacy);

    writeOTelToProfile(profile);
    const content = fs.readFileSync(profile, 'utf-8');

    // Exactly one block, rewritten to the local receiver.
    expect(content.split(START)).toHaveLength(2);
    expect(content).toContain(`http://localhost:${OTLP_DEFAULT_PORT}`);
    expect(content).not.toContain('/v1/otel');
    expect(content).not.toContain('OTEL_EXPORTER_OTLP_HEADERS');
    // Surrounding user content survives.
    expect(content).toContain('alias ll="ls -la"');
    expect(content).toContain('# trailing user content');
  });
});
