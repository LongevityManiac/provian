import { deriveCaptureLane, isCaptureLane, CAPTURE_LANES, deviceSubmitLaneHint } from './capture-lane';

describe('capture-lane classifier', () => {
  it('CAPTURE_LANES is the exact eleven-lane set (non-vacuous; added process)', () => {
    // Print the count so a pass over an empty list cannot masquerade as green.
    // eslint-disable-next-line no-console
    console.log('[capture-lane] CAPTURE_LANES length =', CAPTURE_LANES.length);
    expect(CAPTURE_LANES.length).toBe(11);
    expect(new Set(CAPTURE_LANES).size).toBe(11);
    expect([...CAPTURE_LANES].sort()).toEqual([
      'daemon_git', 'desktop_chat', 'endpoint', 'forge_webhook', 'mobile_chat',
      'otel', 'other', 'process', 'proxy', 'transcript', 'watcher',
    ]);
  });

  describe('isCaptureLane', () => {
    it('accepts every canonical lane and rejects everything else', () => {
      for (const lane of CAPTURE_LANES) expect(isCaptureLane(lane)).toBe(true);
      // RED controls: near-misses and wrong types must be rejected, not coerced.
      expect(isCaptureLane('Transcript')).toBe(false);
      expect(isCaptureLane('proxy ')).toBe(false);
      expect(isCaptureLane('settlement')).toBe(false);
      expect(isCaptureLane('')).toBe(false);
      expect(isCaptureLane(null)).toBe(false);
      expect(isCaptureLane(undefined)).toBe(false);
      expect(isCaptureLane(3)).toBe(false);
    });
  });

  describe('deriveCaptureLane', () => {
    it('an explicit valid laneHint always wins (the exact source)', () => {
      // proxy vs transcript vs otel can ONLY be distinguished by the hint, so the hint must win
      // even against an integrationSource that would derive a different lane.
      expect(deriveCaptureLane({ laneHint: 'proxy', integrationSource: 'device_pe_submit', actionType: 'agent_tool_orchestration' })).toBe('proxy');
      expect(deriveCaptureLane({ laneHint: 'otel', integrationSource: 'device_pe_submit', actionType: 'x' })).toBe('otel');
    });

    it('an invalid laneHint falls through to derivation (never trusted verbatim)', () => {
      // RED control: a garbage hint must NOT become the sealed lane.
      expect(deriveCaptureLane({ laneHint: 'garbage', integrationSource: 'relay_action', actionType: 'x' })).toBe('endpoint');
      expect(deriveCaptureLane({ laneHint: '', integrationSource: 'agent_bank_generate_pe', actionType: 'x' })).toBe('watcher');
    });

    it('watcher: institution action types and the agent-bank source', () => {
      expect(deriveCaptureLane({ integrationSource: 'agent_bank_generate_pe', actionType: 'x' })).toBe('watcher');
      for (const t of ['escrow_completed', 'escrow_resolved', 'escrow_disputed', 'promise_settled', 'pool_executed', 'escrow_funded', 'pool_contributed', 'promise_funded']) {
        expect(deriveCaptureLane({ integrationSource: 'device_pe_submit', actionType: t })).toBe('watcher');
      }
    });

    it('chat: mobile vs desktop split by submit path', () => {
      expect(deriveCaptureLane({ integrationSource: 'mobile_pe_submit', actionType: 'ai_conversation' })).toBe('mobile_chat');
      expect(deriveCaptureLane({ integrationSource: 'device_pe_submit', actionType: 'ai_conversation' })).toBe('desktop_chat');
      // RED control: an ai_conversation from an unknown source is `other`, never mis-bucketed as chat.
      expect(deriveCaptureLane({ integrationSource: 'relay_action', actionType: 'ai_conversation' })).toBe('other');
    });

    it('daemon_git: a commit witnessed through the device daemon', () => {
      expect(deriveCaptureLane({ integrationSource: 'device_pe_submit', actionType: 'coding_session' })).toBe('daemon_git');
      expect(deriveCaptureLane({ integrationSource: 'device_pe_submit', actionType: 'service:github_commit' })).toBe('daemon_git');
      // RED control: a commit type via a NON-device source is not daemon_git.
      expect(deriveCaptureLane({ integrationSource: 'relay_action', actionType: 'coding_session' })).toBe('endpoint');
    });

    it('endpoint: direct relay/API submissions', () => {
      for (const s of ['relay_action', 'relay_work_product', 'provisional_pe_submit', 'human_wallet_registration', 'device_registration']) {
        expect(deriveCaptureLane({ integrationSource: s, actionType: 'x' })).toBe('endpoint');
      }
    });

    it('otel: the device route passes the lane the daemon OTel plugin names ', () => {
      expect(deviceSubmitLaneHint('provian-observer-otel')).toBe('otel');
      expect(deriveCaptureLane({ laneHint: deviceSubmitLaneHint('provian-observer-otel'), integrationSource: 'device_pe_submit', actionType: 'agent_tool_orchestration' })).toBe('otel');
      // RED CONTROL: no other tool is relabelled.
      for (const t of ['provian-observer-transcript', 'provian-observer', 'bash', undefined, null, 42]) expect(deviceSubmitLaneHint(t)).toBeNull();
    });

    it('process: the device route passes the lane the daemon process lane names ', () => {
      expect(deviceSubmitLaneHint('provian:process')).toBe('process');
      expect(deriveCaptureLane({ laneHint: deviceSubmitLaneHint('provian:process'), integrationSource: 'device_pe_submit', actionType: 'agent_tool_orchestration' })).toBe('process');
    });

    it('transcript: a generic device submit with no per-plugin hint', () => {
      expect(deriveCaptureLane({ integrationSource: 'device_pe_submit', actionType: 'agent_tool_orchestration' })).toBe('transcript');
    });

    it('other: the honest fallback for an unrecognized source (never a silent mis-bucket)', () => {
      expect(deriveCaptureLane({ integrationSource: 'genesis_award_state_machine_v2', actionType: 'genesis_signup' })).toBe('other');
      expect(deriveCaptureLane({ integrationSource: null, actionType: 'x' })).toBe('other');
      expect(deriveCaptureLane({ integrationSource: 'delegation_pe', actionType: 'agent_work_delegated' })).toBe('other');
    });
  });
});
