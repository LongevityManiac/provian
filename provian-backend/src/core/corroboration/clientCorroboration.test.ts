/**
 * parseClientCorroborationMetadata - wire-shape validation (Pass-2 #31).
 */

import { parseClientCorroborationMetadata } from './clientCorroboration';

describe('parseClientCorroborationMetadata', () => {
  const valid = {
    target_pe_id: 'pe_target',
    target_pe_hash: 'targethash',
    signal_type: 'counterparty_attestation',
    corroborating_party: '0xother',
    evidence_hash: 'evhash',
    evidence_ref: 'promise_1',
    automated: true,
  };

  it('accepts a well-formed client corroboration block', () => {
    expect(parseClientCorroborationMetadata(valid)).toEqual({
      target_pe_id: 'pe_target',
      target_pe_hash: 'targethash',
      signal_type: 'counterparty_attestation',
      corroborating_party: '0xother',
      evidence_ref: 'promise_1',
    });
  });

  it('returns null for absent / non-object input', () => {
    expect(parseClientCorroborationMetadata(undefined)).toBeNull();
    expect(parseClientCorroborationMetadata(null)).toBeNull();
    expect(parseClientCorroborationMetadata('x')).toBeNull();
  });

  it('rejects missing target_pe_id or target_pe_hash', () => {
    expect(parseClientCorroborationMetadata({ ...valid, target_pe_id: '' })).toBeNull();
    expect(parseClientCorroborationMetadata({ ...valid, target_pe_hash: undefined })).toBeNull();
  });

  it('rejects a relay-only forge signal type (clients cannot assert webhook attestations)', () => {
    expect(
      parseClientCorroborationMetadata({ ...valid, signal_type: 'github_webhook_attestation' }),
    ).toBeNull();
  });

  it('rejects an unknown signal type', () => {
    expect(parseClientCorroborationMetadata({ ...valid, signal_type: 'totally_made_up' })).toBeNull();
  });

  it('defaults corroborating_party to "" and leaves evidence_ref optional', () => {
    const parsed = parseClientCorroborationMetadata({
      target_pe_id: 'pe_target',
      target_pe_hash: 'h',
      signal_type: 'promise_fulfillment',
    });
    expect(parsed).toEqual({
      target_pe_id: 'pe_target',
      target_pe_hash: 'h',
      signal_type: 'promise_fulfillment',
      corroborating_party: '',
      evidence_ref: undefined,
    });
  });
});
