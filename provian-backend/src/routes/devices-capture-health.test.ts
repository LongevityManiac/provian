/**
 * capture-health write boundary.
 *
 * The privacy promise for this endpoint is kept HERE, not in the daemon: the
 * stored document is reconstructed field by field from a bounded read, so a
 * future SDK — or a compromised one — cannot start writing paths into Firestore
 * without this file changing. The sentinel test is the control for that claim.
 *
 * The `broken` flag is computed server-side on purpose. Whether a device is
 * blind is not a question the blind device gets to answer.
 */

import { buildDeviceCaptureHealth, linkedAgentCaptureFields, buildDeviceCaptureStatus } from './devices';

const NOW = 1_788_900_000_000;

const GOOD = {
  schema: 'capture_health/v1',
  daemon_version: '1.5.0',
  catalog_version: '2026.09.07',
  runtime: 'node26',
  sqlite_readable: true,
  harnesses: [{ harness: 'openclaw', version: '2026.8.2', sources: 3, containers: ['sqlite'] }],
  total_sources: 3,
  cursor_total: 1567,
  last_verdict: 'capturing',
  last_verdict_at_ms: NOW - 1000,
  last_capture_at_ms: NOW - 2000,
};

describe('buildDeviceCaptureHealth', () => {
  it('stores a well-formed report and stamps the SERVER clock', () => {
    const out = buildDeviceCaptureHealth(GOOD, NOW);
    expect(out.total_sources).toBe(3);
    expect(out.harnesses[0].harness).toBe('openclaw');
    expect(out.harnesses[0].containers).toEqual(['sqlite']);
    expect(out.updated_at).toBe(NOW);
    expect(out.broken).toBe(false);
  });

  it('THE ALARM — an installed harness with zero sources is marked broken', () => {
    const out = buildDeviceCaptureHealth(
      { ...GOOD, harnesses: [{ harness: 'openclaw', version: '2026.8.2', sources: 0, containers: [] }] },
      NOW,
    );
    expect(out.broken).toBe(true);
    expect(out.total_sources).toBe(0);
  });

  it('NEGATIVE CONTROL — no harness at all is NOT broken (an unused device is not an alarm)', () => {
    const out = buildDeviceCaptureHealth({ ...GOOD, harnesses: [] }, NOW);
    expect(out.broken).toBe(false);
  });

  it('`broken` is computed server-side — a device claiming otherwise is overruled', () => {
    const lying = {
      ...GOOD,
      harnesses: [{ harness: 'openclaw', version: 'x', sources: 0, containers: [] }],
      broken: false,
    };
    expect(buildDeviceCaptureHealth(lying, NOW).broken).toBe(true);

    const alsoLying = { ...GOOD, broken: true };
    expect(buildDeviceCaptureHealth(alsoLying, NOW).broken).toBe(false);
  });

  it('recomputes total_sources rather than trusting the reported figure', () => {
    const out = buildDeviceCaptureHealth({ ...GOOD, total_sources: 9999 }, NOW);
    expect(out.total_sources).toBe(3);
  });

  it('THE MASKING CASE — one blind harness marks the device broken beside a readable one', () => {
    // Device total is 3, which a sum-based rule reads as healthy; the per-harness
    // rule sees the blind OpenClaw. This is the Atlas shape on a two-harness box.
    const out = buildDeviceCaptureHealth({
      ...GOOD,
      harnesses: [
        { harness: 'openclaw', version: '2026.8.2', sources: 0, containers: [] },
        { harness: 'claude-code', version: '1.0.0', sources: 3, containers: ['file'] },
      ],
    }, NOW);
    expect(out.total_sources).toBe(3);
    expect(out.broken).toBe(true);
  });

  it('NEGATIVE CONTROL — two harnesses BOTH with sources are not broken', () => {
    const out = buildDeviceCaptureHealth({
      ...GOOD,
      harnesses: [
        { harness: 'openclaw', version: '2026.8.2', sources: 3, containers: ['sqlite'] },
        { harness: 'claude-code', version: '1.0.0', sources: 3, containers: ['file'] },
      ],
    }, NOW);
    expect(out.broken).toBe(false);
  });

  it('PRIVACY — a path-shaped harness/version/runtime is REJECTED to a fallback, not stored mangled', () => {
    // A length clip alone let `harness: "/Users/frank/clients/acme"` through
    // (truncated, still a path, rendered on the ops console). A field is now
    // stored only if it matches a safe token shape.
    const out = buildDeviceCaptureHealth({
      ...GOOD,
      runtime: '/Users/frank/node',
      harnesses: [{ harness: '/Users/frank/clients/acme-merger', version: '/etc/passwd', sources: 1, containers: ['sqlite'] }],
    }, NOW);
    expect(out.harnesses[0].harness).toBe('unknown');
    expect(out.harnesses[0].version).toBeNull();
    expect(out.runtime).toBe('');
    // None of the injected path content survives anywhere (the only legitimate
    // slash is the schema string, capture_health/v1).
    const serialized = JSON.stringify(out);
    for (const forbidden of ['Users', 'frank', 'clients', 'acme', 'passwd', 'etc']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('NEGATIVE CONTROL — a legitimate harness/version/runtime IS kept', () => {
    // Proves the rejection above is shape-based, not "reject everything".
    const out = buildDeviceCaptureHealth({
      ...GOOD,
      runtime: 'node26',
      harnesses: [{ harness: 'openclaw', version: '2026.8.2', sources: 1, containers: ['sqlite'] }],
    }, NOW);
    expect(out.harnesses[0].harness).toBe('openclaw');
    expect(out.harnesses[0].version).toBe('2026.8.2');
    expect(out.runtime).toBe('node26');
  });

  it('PRIVACY SENTINEL — paths, tables and session ids are dropped, not stored', () => {
    const hostile = {
      ...GOOD,
      // Every plausible smuggling route, all at once.
      db_path: '/Users/AtlasProvian/.openclaw/agents/main/agent/openclaw-agent.sqlite',
      cwd: '/Users/AtlasProvian/Projects/secret',
      harnesses: [{
        harness: 'openclaw',
        version: '2026.8.2',
        sources: 1,
        containers: ['sqlite', '/Users/AtlasProvian/secret-path', 'transcript_events'],
        session_id: 'abc-123',
        path: '/Users/AtlasProvian/.openclaw',
      }],
    };
    const out = buildDeviceCaptureHealth(hostile, NOW);
    const serialized = JSON.stringify(out);
    for (const forbidden of ['/Users/', 'AtlasProvian', 'transcript_events', 'abc-123', 'secret']) {
      expect(serialized).not.toContain(forbidden);
    }
    // Non-vacuous: the legitimate content survived.
    expect(out.harnesses[0].containers).toEqual(['sqlite']);
    expect(out.harnesses[0].sources).toBe(1);
  });

  it('bounds every string and count, so a hostile body cannot bloat the document', () => {
    const out = buildDeviceCaptureHealth(
      {
        ...GOOD,
        daemon_version: 'v'.repeat(500),
        harnesses: Array.from({ length: 100 }, () => ({ harness: 'h'.repeat(500), sources: -5, containers: [] })),
        cursor_total: -1,
      },
      NOW,
    );
    expect(out.daemon_version.length).toBeLessThanOrEqual(32);
    expect(out.harnesses.length).toBeLessThanOrEqual(16);
    expect(out.harnesses[0].harness.length).toBeLessThanOrEqual(64);
    expect(out.harnesses[0].sources).toBe(0); // negatives clamped, never stored
    expect(out.cursor_total).toBe(0);
  });

  it('a garbage body yields a valid, empty, non-alarming document rather than throwing', () => {
    const out = buildDeviceCaptureHealth('not an object', NOW);
    expect(out.harnesses).toEqual([]);
    expect(out.broken).toBe(false);
    expect(out.updated_at).toBe(NOW);
  });
});

describe('buildDeviceCaptureHealth — sole-witness silence ', () => {
  it('THE SILENCE ALARM — readable, records read, zero tool calls recognized → broken', () => {
    const out = buildDeviceCaptureHealth(
      { ...GOOD, last_verdict:'unknown', records_consumed_in_window: 42, tool_calls_recognized_in_window: 0 },
      NOW,
    );
    expect(out.broken).toBe(true);
    expect(out.broken_reason).toBe('sole_witness_silence');
    expect(out.records_consumed_in_window).toBe(42);
    expect(out.tool_calls_recognized_in_window).toBe(0);
  });

  it('NEGATIVE CONTROL — records read AND tool calls recognized is not broken', () => {
    const out = buildDeviceCaptureHealth(
      { ...GOOD, records_consumed_in_window: 42, tool_calls_recognized_in_window: 7 },
      NOW,
    );
    expect(out.broken).toBe(false);
    expect(out.broken_reason).toBeNull();
  });

  it('NEGATIVE CONTROL — genuine idle (no records read this window) is not broken', () => {
    const out = buildDeviceCaptureHealth(
      { ...GOOD, records_consumed_in_window: 0, tool_calls_recognized_in_window: 0 },
      NOW,
    );
    expect(out.broken).toBe(false);
    expect(out.broken_reason).toBeNull();
  });

  it('a blind harness beats silence — broken_reason is no_readable_sources', () => {
    const out = buildDeviceCaptureHealth(
      {
        ...GOOD,
        harnesses: [{ harness: 'openclaw', version: '2026.8.2', sources: 0, containers: [] }],
        records_consumed_in_window: 5,
        tool_calls_recognized_in_window: 0,
      },
      NOW,
    );
    expect(out.broken).toBe(true);
    expect(out.broken_reason).toBe('no_readable_sources');
  });

  it('silence is computed server-side — a device claiming toolCalls it never reported cannot mask it', () => {
    // A hostile daemon reports records but forges a positive tool-call count to
    // hide a real silence. The count is trusted for the FACT it reports, but the
    // server recomputes `broken` from the two reported fields — so a forged
    // positive toolCalls count reads as "not silent" only if it is actually >0.
    // The control that matters: an ABSENT toolCalls field defaults to 0 → silent.
    const out = buildDeviceCaptureHealth(
      { ...GOOD, last_verdict:'unknown', records_consumed_in_window: 9 }, // tool_calls_recognized_in_window omitted → 0
      NOW,
    );
    expect(out.tool_calls_recognized_in_window).toBe(0);
    expect(out.broken).toBe(true);
    expect(out.broken_reason).toBe('sole_witness_silence');
  });
});

describe('buildDeviceCaptureHealth — witness lanes (item 5)', () => {
  const OTEL_WITNESSING = { otel_active: true, otel_receiver_listening: true, otel_spans_ever_seen: true, otel_last_span_at_ms: NOW - 500 };
  const OTEL_LISTENING_SILENT = { otel_active: true, otel_receiver_listening: true, otel_spans_ever_seen: false, otel_last_span_at_ms: null };

  it('coerces the OTel-lane fields and clamps the last-span timestamp', () => {
    const out = buildDeviceCaptureHealth({ ...GOOD, ...OTEL_WITNESSING }, NOW);
    expect(out.otel_active).toBe(true);
    expect(out.otel_receiver_listening).toBe(true);
    expect(out.otel_spans_ever_seen).toBe(true);
    expect(out.otel_last_span_at_ms).toBe(NOW - 500);
    expect(out.lanes).toBe('both'); // transcript sources=3 AND otel witnessing
  });

  it('THE OPENCLAW CASE — transcript sources + OTel listening-but-silent → lanes:transcript', () => {
    const out = buildDeviceCaptureHealth({ ...GOOD, ...OTEL_LISTENING_SILENT }, NOW);
    expect(out.lanes).toBe('transcript');
  });

  it('otel-only when there are no transcript sources but spans arrive', () => {
    const out = buildDeviceCaptureHealth({ ...GOOD, harnesses: [], ...OTEL_WITNESSING }, NOW);
    expect(out.lanes).toBe('otel');
  });

  it('none when neither lane witnesses', () => {
    const out = buildDeviceCaptureHealth({ ...GOOD, harnesses: [], ...OTEL_LISTENING_SILENT }, NOW);
    expect(out.lanes).toBe('none');
  });

  it('`lanes` is server-derived — a device claiming both while OTel is silent is overruled', () => {
    // Same philosophy as `broken`: the device does not get to assert its own
    // coverage. A listening-but-silent receiver is not a witness.
    const lying = { ...GOOD, ...OTEL_LISTENING_SILENT, lanes: 'both' };
    expect(buildDeviceCaptureHealth(lying, NOW).lanes).toBe('transcript');
  });

  it('RED CONTROL — spans-seen but plugin inactive does NOT create the otel lane', () => {
    const out = buildDeviceCaptureHealth({
      ...GOOD, harnesses: [],
      otel_active: false, otel_receiver_listening: true, otel_spans_ever_seen: true, otel_last_span_at_ms: NOW,
    }, NOW);
    expect(out.lanes).toBe('none');
  });

  it('a garbage otel_last_span_at_ms is dropped to null, never stored mangled', () => {
    const out = buildDeviceCaptureHealth({ ...GOOD, otel_last_span_at_ms: 'not-a-number' }, NOW);
    expect(out.otel_last_span_at_ms).toBeNull();
  });

  it('an old daemon (no otel fields) defaults to a non-witnessing OTel lane', () => {
    const out = buildDeviceCaptureHealth(GOOD, NOW);
    expect(out.otel_active).toBe(false);
    expect(out.otel_spans_ever_seen).toBe(false);
    expect(out.otel_last_span_at_ms).toBeNull();
    expect(out.lanes).toBe('transcript'); // transcript sources still witness
  });
});


describe('buildDeviceCaptureHealth — model-endpoint proxy lane (Lane 5,)', () => {
  const PROXY_LIVE = { proxy_active: true, proxy_listening: true, proxy_turns_ever_seen: true, proxy_last_turn_at_ms: NOW - 500 };

  it('stores the proxy lane and adds model_proxy to lane_names when it is witnessing', () => {
    const out = buildDeviceCaptureHealth({ ...GOOD, ...PROXY_LIVE }, NOW);
    expect(out.proxy_active).toBe(true);
    expect(out.proxy_listening).toBe(true);
    expect(out.proxy_turns_ever_seen).toBe(true);
    expect(out.proxy_last_turn_at_ms).toBe(NOW - 500);
    expect(out.lane_names).toEqual(['transcript', 'model_proxy']); // GOOD has 3 sources → transcript
  });

  it('RED CONTROL — listening but no turn ever seen is NOT a proxy witness lane', () => {
    const out = buildDeviceCaptureHealth({ ...GOOD, proxy_active: true, proxy_listening: true, proxy_turns_ever_seen: false }, NOW);
    expect(out.proxy_turns_ever_seen).toBe(false);
    expect(out.lane_names).not.toContain('model_proxy');
  });

  it('an old daemon (no proxy fields) reports a non-witnessing proxy lane, never undefined', () => {
    const out = buildDeviceCaptureHealth(GOOD, NOW);
    expect(out.proxy_active).toBe(false);
    expect(out.lane_names).toEqual(['transcript']);
    expect(out.proxy_unrecognized).toEqual([]);
  });

  it('THE PRIVACY GATE — an unrecognized fingerprint that is not clean hex is DROPPED, provider must be a known set', () => {
    const out = buildDeviceCaptureHealth({
      ...GOOD, ...PROXY_LIVE,
      proxy_unrecognized: [
        { fingerprint: 'deadbeefdeadbeef', provider: 'anthropic', method: 'POST', count: 2 },
        { fingerprint: '/Users/frank/leak', provider: 'anthropic', method: 'POST', count: 1 }, // path → dropped
        { fingerprint: 'aaaa1111bbbb2222', provider: 'evilcorp', method: 'GET /secret?path=x', count: 1 }, // bad provider→null, path-shaped method→POST
      ],
    }, NOW);
    const fps = out.proxy_unrecognized ?? [];
    expect(fps).toHaveLength(2); // the path-shaped fingerprint is dropped
    expect(JSON.stringify(fps)).not.toContain('/Users/frank/leak');
    expect(JSON.stringify(fps)).not.toContain('/secret'); // path-shaped method not stored
    const evil = fps.find((f) => f.fingerprint === 'aaaa1111bbbb2222')!;
    expect(evil.provider).toBeNull();  // unknown provider not stored
    expect(evil.method).toBe('POST');  // non-token (has space/slash) → fallback
  });
});

describe('buildDeviceCaptureHealth — retired intakes, Grok repoint + witness mode, harness homes, supervision', () => {
  /** What a pre- daemon still reports for its retired intakes (the Grok hooks lane and the local self-report endpoint). */
  const HOOKS_LIVE = { hooks_active: true, hooks_listening: true, hooks_events_ever_seen: true, hooks_last_event_at_ms: NOW - 100 };
  const SELF_LIVE = { self_report_active: true, self_report_listening: true, self_report_events_ever_seen: true, self_report_last_event_at_ms: NOW - 50 };

  it('a pre-update daemon\'s live hooks / self-report intakes name no lane and are not stored', () => {
    const out = buildDeviceCaptureHealth({ ...GOOD, ...HOOKS_LIVE, ...SELF_LIVE }, NOW);
    expect(out.lane_names).toEqual(['transcript']);
    const stored = Object.keys(out).filter((k) => k.startsWith('hooks_') || k.startsWith('self_report_'));
    expect(stored).toEqual([]);
    // RED control: the same body with a live proxy DOES gain a lane — the derivation ran.
    const proxied = buildDeviceCaptureHealth({ ...GOOD, ...HOOKS_LIVE, proxy_active: true, proxy_listening: true, proxy_turns_ever_seen: true }, NOW);
    expect(proxied.lane_names).toEqual(['transcript', 'model_proxy']);
  });







  it('harness homes and supervision are closed sets — a path or invented value is dropped / defaulted', () => {
    const out = buildDeviceCaptureHealth({
      ...GOOD, detected_harness_homes: ['grok', '/home/u/.grok', 'codex', 'grok', 'evil'],
      supervision_method: 'cron', cron_alive: false, last_work_pe_at_ms: NOW - 9,
    }, NOW);
    expect(out.detected_harness_homes).toEqual(['codex', 'evil', 'grok']);
    expect(out.supervision_method).toBe('cron');
    expect(out.cron_alive).toBe(false);
    expect(out.last_work_pe_at_ms).toBe(NOW - 9);
    const bad = buildDeviceCaptureHealth({ ...GOOD, supervision_method: 'rm -rf', cron_alive: true }, NOW);
    expect(bad.supervision_method).toBe('unknown');
    expect(bad.cron_alive).toBeNull(); // only meaningful under cron
  });

  it(' restart_hook is a closed set: shell_rc passes; a path, an invented value or an absent field reads null', () => {
    expect(buildDeviceCaptureHealth({ ...GOOD, supervision_method: 'detached', restart_hook: 'shell_rc' }, NOW).restart_hook).toBe('shell_rc');
    // RED control: every value outside the closed set — including the rc file path the daemon
    // edits and a supervisor name — is dropped, so a device can never smuggle a path or claim.
    for (const bad of ['/home/box/.bashrc', 'SHELL_RC', 'systemd', 'shell_hook', 1, true, null, { kind: 'shell_rc' }]) {
      expect(buildDeviceCaptureHealth({ ...GOOD, restart_hook: bad }, NOW).restart_hook).toBeNull();
    }
    expect(buildDeviceCaptureHealth(GOOD, NOW).restart_hook).toBeNull();
  });

  it(' restart_mechanism is a closed set: the six mechanisms pass; anything else reads null', () => {
    for (const m of ['systemd', 'launchd', 'scheduled_task', 'cron', 'shell_rc', 'agent']) {
      expect(buildDeviceCaptureHealth({ ...GOOD, restart_mechanism: m }, NOW).restart_mechanism).toBe(m);
    }
    // RED control: a path, a case variant, a supervisor the set does not name, a non-string → null.
    for (const bad of ['/home/box/.bashrc', 'AGENT', 'detached', 'unknown', 'none', 1, true, null, { m: 'agent' }]) {
      expect(buildDeviceCaptureHealth({ ...GOOD, restart_mechanism: bad }, NOW).restart_mechanism).toBeNull();
    }
    expect(buildDeviceCaptureHealth(GOOD, NOW).restart_mechanism).toBeNull();
  });

  it('an old daemon (no new fields) reads as no homes, supervision unknown', () => {
    const out = buildDeviceCaptureHealth(GOOD, NOW);
    expect(out).toMatchObject({ detected_harness_homes: [], supervision_method: 'unknown', cron_alive: null, restart_hook: null, last_work_pe_at_ms: null });
  });


});

describe('buildDeviceCaptureHealth — a legacy platform label reads through the generic path', () => {
  // Devices registered under the retired hosted-platform label exist in
  // production, and their already-installed daemons still send the retired
  // host fields. Both must read exactly like any unrecognised platform: no
  // throw, no special case, and nothing of the retired label in what is stored.
  const LEGACY = 'muse';

  it('a legacy daemon body carrying the retired host fields is stored like any other report', () => {
    const legacyBody = {
      ...GOOD,
      host_platform: LEGACY,
      host_lane_truth: [{ lane: 'passive_tool_events', witness: 'self_attested', statement: '/Users/frank/secret' }],
    };
    const out = buildDeviceCaptureHealth(legacyBody, NOW);
    expect(out).toEqual(buildDeviceCaptureHealth(GOOD, NOW));
    expect(out).not.toHaveProperty('host_platform');
    expect(out).not.toHaveProperty('host_lane_truth');
    expect(JSON.stringify(out).toLowerCase()).not.toContain(LEGACY);
    expect(JSON.stringify(out)).not.toContain('/Users/frank/secret');
  });

  it('a device REGISTERED with the legacy label keeps its capture status on the generic fallback', () => {
    const out = buildDeviceCaptureStatus({ llm_session_enabled: true }, LEGACY, NOW);
    expect(out.platform).toBe(LEGACY);
    expect(out.llm_session_enabled).toBe(true);
    expect(out.updated_at).toBe(NOW);
    expect(buildDeviceCaptureStatus({}, LEGACY, NOW)).toEqual(
      { ...buildDeviceCaptureStatus({}, 'some-unknown-host', NOW), platform: LEGACY },
    );
  });
});

describe(' retired catalog and arbitration fields',()=>{
 it('does not store catalog maintenance or per-harness lane decisions from an old daemon',()=>{
  const report=buildDeviceCaptureHealth({...GOOD,unparsed_stores:[{fingerprint:'deadbeef'}],grok_proxy_repoint:'repointed',grok_witness_mode:'proxy',proxy_bypassed_harnesses:['demo']},NOW);
  for(const field of ['catalog_version','unparsed_stores','grok_proxy_repoint','grok_witness_mode','proxy_bypassed_harnesses'])expect(report).not.toHaveProperty(field);
 });
 it('flags re-description while preserving a quiet program RED control',()=>{
  expect(buildDeviceCaptureHealth({...GOOD,format_broken_programs:['demo']},NOW)).toMatchObject({broken:true,broken_reason:'session_format_broken'});
  expect(buildDeviceCaptureHealth({...GOOD,format_broken_programs:[]},NOW)).toMatchObject({broken:false});
 });
});

// live RED: the relay must preserve the daemon's recognized zero-tool verdict.
it.each(['idle','capturing'])('known zero-tool tails stay healthy (%s)', last_verdict => {
 const b={...GOOD,last_verdict,records_consumed_in_window:24,tool_calls_recognized_in_window:0,format_broken_programs:[]};
 expect(buildDeviceCaptureHealth(b,NOW)).toMatchObject({broken:false,broken_reason:null});
 expect(buildDeviceCaptureHealth({...b,last_verdict:'unknown',format_broken_programs:['openclaw']},NOW)).toMatchObject({broken:true,broken_reason:'session_format_broken'});
});

it.each([undefined,'/private/not-a-verdict'])('normalizes unknown verdict before judging silence (%s)', last_verdict => {
 const out=buildDeviceCaptureHealth({...GOOD,last_verdict,records_consumed_in_window:24,tool_calls_recognized_in_window:0,format_broken_programs:[]},NOW);
 expect(out).toMatchObject({last_verdict:'unknown',broken:true,broken_reason:'sole_witness_silence'});
});

// addition 1: a harness change in the process lane is flagged like a session format break.
// (the correction): only a CONFIRMED change (the daemon says so) and a
// launcher no running program matches break capture; a suspicion the agent's own commands may still
// clear never reaches the card.
describe('process lane state ', () => {
  const PL = { ...GOOD, harnesses: [], total_sources: 0, process_active: true, process_watching: true };
  it('flags a confirmed launcher_changed as process_launcher_changed, with the moment it was raised on the relay clock', () => {
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: 'launcher_changed', process_launcher_change_confirmed: true, process_lane_state_age_ms: 3_600_000 }, NOW))
      .toMatchObject({ process_lane_state: 'launcher_changed', broken: true, broken_reason: 'process_launcher_changed', broken_since_ms: NOW - 3_600_000 });
  });
  it(' correction: no running program matching the launcher is broken as process_launcher_not_seen, with its moment', () => {
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: 'launcher_not_seen', process_lane_state_age_ms: 600_000 }, NOW))
      .toMatchObject({ process_lane_state: 'launcher_not_seen', broken: true, broken_reason: 'process_launcher_not_seen', broken_since_ms: NOW - 600_000 });
  });
  it(' correction: a suspicion, or an old daemon\'s unconfirmed launcher_changed, is not broken and carries nothing for the card (RED: confirmed is broken, above)', () => {
    const quiet = { broken: false, broken_reason: null, broken_since_ms: null };
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: 'launcher_unconfirmed', process_launcher_change_confirmed: false }, NOW))
      .toMatchObject({ process_lane_state: 'launcher_unconfirmed', ...quiet });
    // A daemon from before the ruling sends no confirmation field: its launcher_changed may be a suspicion.
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: 'launcher_changed' }, NOW)).toMatchObject(quiet);
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: 'launcher_changed', process_launcher_change_confirmed: 'true' }, NOW)).toMatchObject(quiet);
    // The amber split is gone: no attention reason is stored for any state.
    for (const state of ['launcher_unconfirmed', 'launcher_changed', 'launcher_not_seen', 'active']) {
      expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: state }, NOW)).not.toHaveProperty('attention_reason');
    }
  });
  it('the state age is placed on the relay clock and never yields a moment in the future or before the epoch', () => {
    const at = (age: unknown) => buildDeviceCaptureHealth({ ...PL, process_lane_state: 'launcher_changed', process_launcher_change_confirmed: true, process_lane_state_age_ms: age }, NOW);
    expect(at(0)).toMatchObject({ broken_since_ms: NOW, process_lane_state_since_ms: NOW });
    expect(at(-5)).toMatchObject({ broken_since_ms: null, process_lane_state_since_ms: null });
    expect(at(NOW + 1)).toMatchObject({ broken_since_ms: null });
    expect(at('60000')).toMatchObject({ broken_since_ms: null });
    expect(at(Number.NaN)).toMatchObject({ broken_since_ms: null });
    // Only the lane's own state carries a moment: an active lane's age never becomes a broken moment.
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: 'active', process_lane_state_age_ms: 10 }, NOW)).toMatchObject({ broken: false, broken_since_ms: null });
  });
  it('RED: an active or inert lane is healthy, and an unknown state string is never stored', () => {
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: 'active' }, NOW)).toMatchObject({ process_lane_state: 'active', broken: false });
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: 'inert_other_lane' }, NOW)).toMatchObject({ broken: false });
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: '/home/u/secret' }, NOW)).toMatchObject({ process_lane_state: null, broken: false });
    // a lane that is not running never flags, whatever it last said
    expect(buildDeviceCaptureHealth({ ...PL, process_active: false, process_lane_state: 'launcher_changed' }, NOW)).toMatchObject({ broken: false });
  });
});

// follow-up : an agent device whose lane is its witness and has no launcher
// record witnesses none of its commands. It reports `process_no_launcher`; the agent's fix is to run
// "$HOME/.provian/bin/provian" process-lane record once from its own session.
describe('process lane with no launcher record (follow-up)', () => {
  const PL = { ...GOOD, harnesses: [], total_sources: 0, process_active: true, process_watching: false };
  it('a device with no launcher record reports process_no_launcher', () => {
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: 'no_launcher' }, NOW))
      .toMatchObject({ process_lane_state: 'no_launcher', broken: true, broken_reason: 'process_no_launcher' });
  });
  it('RED: a device with a launcher record does not (active, or flagged for its own reason)', () => {
    expect(buildDeviceCaptureHealth({ ...PL, process_watching: true, process_lane_state: 'active' }, NOW))
      .toMatchObject({ broken: false, broken_reason: null });
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: 'launcher_changed', process_launcher_change_confirmed: true }, NOW))
      .toMatchObject({ broken_reason: 'process_launcher_changed' });
  });
  it('RED: a session-file agent does not (its lane is inert, and producing transcript sources never flag)', () => {
    // Atlas's shape: OpenClaw session files read, process lane inert.
    expect(buildDeviceCaptureHealth({ ...GOOD, process_active: true, process_lane_state: 'inert_other_lane' }, NOW))
      .toMatchObject({ broken: false, broken_reason: null });
    // Even a lane that says no_launcher is overruled while session files, OTel or the proxy produce.
    expect(buildDeviceCaptureHealth({ ...GOOD, process_active: true, process_lane_state: 'no_launcher' }, NOW))
      .toMatchObject({ broken: false, broken_reason: null });
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: 'no_launcher', otel_active: true, otel_receiver_listening: true, otel_spans_ever_seen: true }, NOW))
      .toMatchObject({ broken: false });
    expect(buildDeviceCaptureHealth({ ...PL, process_lane_state: 'no_launcher', proxy_active: true, proxy_listening: true, proxy_turns_ever_seen: true }, NOW))
      .toMatchObject({ broken: false });
  });
  it('RED: a lane that is not running never flags (a human device, or the lane off)', () => {
    expect(buildDeviceCaptureHealth({ ...PL, process_active: false, process_lane_state: 'no_launcher' }, NOW)).toMatchObject({ broken: false });
  });
});

// / a live launcher starting matching commands with nothing sealing alarms.
describe('process lane silence (, parity)', () => {
  const PL = { ...GOOD, harnesses: [], total_sources: 0, process_active: true, process_watching: true, process_lane_state: 'active' };
  it('flags process_lane_silence when the audit saw due commands from a live launcher and none sealed', () => {
    expect(buildDeviceCaptureHealth({ ...PL, process_launcher_live: true, process_commands_due_in_window: 3, process_commands_due_sealed_in_window: 0 }, NOW))
      .toMatchObject({ broken: true, broken_reason: 'process_lane_silence', process_commands_due_in_window: 3, process_commands_due_sealed_in_window: 0 });
  });
  it('RED: sealing commands, an idle agent, a launcher not running, or a lane not running never alarm', () => {
    expect(buildDeviceCaptureHealth({ ...PL, process_launcher_live: true, process_commands_due_in_window: 3, process_commands_due_sealed_in_window: 3 }, NOW)).toMatchObject({ broken: false });
    expect(buildDeviceCaptureHealth({ ...PL, process_launcher_live: true, process_commands_due_in_window: 0, process_commands_due_sealed_in_window: 0 }, NOW)).toMatchObject({ broken: false });
    expect(buildDeviceCaptureHealth({ ...PL, process_launcher_live: false, process_commands_due_in_window: 3, process_commands_due_sealed_in_window: 0 }, NOW)).toMatchObject({ broken: false });
    expect(buildDeviceCaptureHealth({ ...PL, process_active: false, process_launcher_live: true, process_commands_due_in_window: 3 }, NOW)).toMatchObject({ broken: false });
  });
  it('a sealed count above the due count is clamped, never read as sealing more than was due', () => {
    expect(buildDeviceCaptureHealth({ ...PL, process_launcher_live: true, process_commands_due_in_window: 2, process_commands_due_sealed_in_window: 'x' }, NOW))
      .toMatchObject({ broken: true, broken_reason: 'process_lane_silence', process_commands_due_sealed_in_window: 0 });
    expect(buildDeviceCaptureHealth({ ...PL, process_launcher_live: true, process_commands_due_in_window: 2, process_commands_due_sealed_in_window: 9 }, NOW))
      .toMatchObject({ broken: false, process_commands_due_sealed_in_window: 2 });
  });
});

// (the correction): the linked-agent list re-judges a stored device doc,
// because a doc a relay from before the ruling wrote may say process_launcher_changed for a suspicion
// or a launcher no program matches, and a device that stopped reporting keeps that doc indefinitely.
describe('linkedAgentCaptureFields', () => {
  it('a doc an older relay wrote (no confirmation) for a suspicion is not broken (RED: a confirmed doc is broken)', () => {
    expect(linkedAgentCaptureFields({ broken: true, broken_reason: 'process_launcher_changed', process_lane_state: 'launcher_changed', updated_at: 5 }, 3))
      .toEqual({ last_capture_at_ms: 3, capture_reported_at_ms: 5, capture_broken: false, capture_broken_reason: null, capture_receiving: true, capture_broken_since_ms: null });
    expect(linkedAgentCaptureFields({ broken: true, broken_reason: 'process_launcher_changed', process_launcher_change_confirmed: true, broken_since_ms: 9, last_capture_at_ms: 7, updated_at: 10 }, 3))
      .toEqual({ last_capture_at_ms: 7, capture_reported_at_ms: 10, capture_broken: true, capture_broken_reason: 'process_launcher_changed', capture_receiving: false, capture_broken_since_ms: 9 });
  });
  it('a launcher no program matches is broken as process_launcher_not_seen, whichever older relay stored it (RED: a lane not running, or another reason, is left alone)', () => {
    // The first relay stored it as process_launcher_changed; stored it not broken (an attention reason).
    for (const doc of [
      { broken: true, broken_reason: 'process_launcher_changed', process_active: true, process_lane_state: 'launcher_not_seen', process_lane_state_since_ms: 11 },
      { broken: false, broken_reason: null, process_active: true, process_lane_state: 'launcher_not_seen', process_lane_state_since_ms: 11, attention_reason: 'process_launcher_not_seen' },
    ]) {
      expect(linkedAgentCaptureFields(doc, null))
        .toMatchObject({ capture_broken: true, capture_broken_reason: 'process_launcher_not_seen', capture_receiving: false, capture_broken_since_ms: 11 });
    }
    expect(linkedAgentCaptureFields({ broken: false, process_active: false, process_lane_state: 'launcher_not_seen' }, null)).toMatchObject({ capture_broken: false });
    expect(linkedAgentCaptureFields({ broken: true, broken_reason: 'session_format_broken', broken_since_ms: 4, process_active: true, process_lane_state: 'launcher_not_seen' }, null))
      .toMatchObject({ capture_broken_reason: 'session_format_broken', capture_broken_since_ms: 4 });
  });
  it('a doc this relay wrote round-trips: what buildDeviceCaptureHealth judged is what the card reads', () => {
    const PL = { ...GOOD, harnesses: [], total_sources: 0, process_active: true, process_watching: true };
    for (const body of [
      { ...PL, process_lane_state: 'launcher_changed', process_launcher_change_confirmed: true, process_lane_state_age_ms: 60_000 },
      { ...PL, process_lane_state: 'launcher_unconfirmed' },
      { ...PL, process_lane_state: 'launcher_not_seen', process_lane_state_age_ms: 600_000 },
      { ...PL, process_lane_state: 'no_launcher', process_lane_state_age_ms: 5 },
      { ...PL, process_lane_state: 'active' },
    ]) {
      const ch = buildDeviceCaptureHealth(body, NOW);
      const card = linkedAgentCaptureFields(ch as unknown as Record<string, unknown>, null);
      expect({ state: body.process_lane_state, broken: card.capture_broken, reason: card.capture_broken_reason, since: card.capture_broken_since_ms })
        .toEqual({ state: body.process_lane_state, broken: ch.broken, reason: ch.broken_reason, since: ch.broken_since_ms ?? null });
    }
  });
  it(' last activity is the last work the daemon witnessed — the later of a session turn and a sealed command — and the batch arrival only when it reported neither (RED: a batch arriving later never moves it)', () => {
    const at = (fields: Record<string, unknown>, lastPeAt: unknown) => linkedAgentCaptureFields({ updated_at: 1_000, ...fields }, lastPeAt).last_capture_at_ms;
    expect(at({ process_last_act_at_ms: 100 }, 900)).toBe(100);
    expect(at({ last_capture_at_ms: 300, process_last_act_at_ms: 100 }, 900)).toBe(300);
    expect(at({ last_capture_at_ms: 100, process_last_act_at_ms: 300 }, 900)).toBe(300);
    expect(at({ process_last_act_at_ms: null, last_capture_at_ms: null }, 900)).toBe(900);
    expect(at({ process_last_act_at_ms: '100' }, 900)).toBe(900);
    expect(linkedAgentCaptureFields({}, null)).toMatchObject({ last_capture_at_ms: null });
  });

  it('a moment on a daemon clock ahead of the relay (after the relay received the report) is never shown (RED: one at the receipt is)', () => {
    const at = (fields: Record<string, unknown>) => linkedAgentCaptureFields(fields, 900).last_capture_at_ms;
    expect(at({ updated_at: 1_000, process_last_act_at_ms: 1_001 })).toBe(900);
    expect(at({ updated_at: 1_000, process_last_act_at_ms: 1_000 })).toBe(1_000);
    expect(at({ updated_at: 1_000, last_capture_at_ms: 5_000, process_last_act_at_ms: 400 })).toBe(400);
    // No receipt time: unknown, so the daemon's moment is not shown.
    expect(at({ process_last_act_at_ms: 400 })).toBe(900);
  });

  it('other broken reasons pass through; an unknown stored reason reads as blind, never as healthy', () => {
    expect(linkedAgentCaptureFields({ broken: true, broken_reason: 'session_format_broken' }, null)).toMatchObject({ capture_broken: true, capture_broken_reason: 'session_format_broken' });
    expect(linkedAgentCaptureFields({ broken: true, broken_reason: '/x' }, null)).toMatchObject({ capture_broken: true, capture_broken_reason: 'no_readable_sources' });
    expect(linkedAgentCaptureFields({}, null)).toMatchObject({ capture_broken: false, capture_broken_reason: null, capture_broken_since_ms: null });
  });
});
