/**
 * one program, one lane: an `agent_tool_orchestration` act is admitted only from the
 * observer daemon lane that sealed it (transcript, OTel or model proxy), named by the lane's own
 * `metadata.source` + `metadata.tool` pair. A tool-call PE from a retired per-harness or
 * per-framework integration (the Hermes plugin's per-call hook, the Python LangChain / CrewAI
 * callbacks) still installed on a machine that holds the device credential is refused at intake,
 * so it never mints beside the program's lane.
 *
 * The admitted pairs are bound to the daemon's emitters by reading their source, so renaming a
 * lane's tag in the SDK without the relay table turns this suite red.
 */
import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { deviceActToAccrualParams, type DeviceBatchLane } from './device-act';
import type { ActRecord } from './meter-wire';
import type { DeviceDocument } from '../../routes/middleware/device-auth';
import {
  DAEMON_TOOL_ORCHESTRATION_LANES,
  isDaemonToolOrchestrationLane,
} from '../provenance/device-observation-types';

const REFUSED = { ok: false, reason: 'tool_orchestration_not_daemon_lane' };

const lane = (): DeviceBatchLane => ({
  device: { owner_type: 'agent', device_id: 'fixture' } as DeviceDocument,
  bodyBound: true, signatureAuthenticated: true, attestationTier: 'software', ownerId: 'fixture',
  receivedAtMs: Date.now(), lineage: null, lineageTouched: false,
} as DeviceBatchLane);

const act = (metadata: Record<string, unknown>): ActRecord => ({
  action_type: 'agent_tool_orchestration', pe_id: 'fixture', timestamp: Date.now(), device_id: 'fixture',
  prev_hash: 'genesis', pricing: { metadata }, pe_hash: 'sha256:' + 'a'.repeat(64),
} as unknown as ActRecord);

async function intake(metadata: Record<string, unknown>): Promise<unknown> {
  try {
    return await deviceActToAccrualParams(lane(), act(metadata), 'fixture');
  } catch (err) {
    // Past the lane guard the mapper reads Firestore, which this unit suite does not provide:
    // reaching that read means the act cleared intake.
    return { cleared_intake: true, error: (err as Error).message };
  }
}

const SDK = path.resolve(__dirname, '../../../../provian-agent-sdk/src/observer/plugins');
const read = (rel: string): string => fs.readFileSync(path.join(SDK, rel), 'utf8');

/** The `source` / `tool` pair each daemon lane stamps, read from the emitter itself. */
function emittedPairs(): Record<string, string> {
  const transcript = read('transcript/TranscriptPlugin.ts');
  const otel = read('OTelPlugin.ts');
  const proxy = read('model-proxy/turn-pe.ts');
  const process = read('process-lane/ProcessLanePlugin.ts');
  const transcriptTool = /actionType:'agent_tool_orchestration'[^\n]*?metadata:\{tool:'([^']+)',source:'([^']+)'/.exec(transcript);
  const otelSource = /pe\.metadata = \{ \.\.\.pe\.metadata, program: arrival\.sender, source: '([^']+)' \}/.exec(otel);
  const otelTool = /actionType: 'agent_tool_orchestration',[\s\S]*?tool: '([^']+)'/.exec(otel);
  const proxyToolConst = /export const MODEL_PROXY_TOOL = '([^']+)'/.exec(proxy);
  const proxySource = /tool: MODEL_PROXY_TOOL,\s*source: '([^']+)'/.exec(proxy);
  // the process lane stamps the two exported constants on its PE metadata.
  const processSource = /PROCESS_LANE_SOURCE = '([^']+)'/.exec(process);
  const processTool = /PROCESS_LANE_TOOL = '([^']+)'/.exec(process);
  const found: Record<string, string> = {};
  if (transcriptTool) found[transcriptTool[2]] = transcriptTool[1];
  if (otelSource && otelTool) found[otelSource[1]] = otelTool[1];
  if (proxySource && proxyToolConst) found[proxySource[1]] = proxyToolConst[1];
  if (processSource && processTool && /source: PROCESS_LANE_SOURCE/.test(process) && /tool: PROCESS_LANE_TOOL/.test(process)) {
    found[processSource[1]] = processTool[1];
  }
  return found;
}

describe('agent_tool_orchestration is admitted only from a daemon lane', () => {
  it('the relay table is exactly the pairs the daemon lanes stamp (four lanes incl. process, read from the SDK source)', () => {
    const pairs = emittedPairs();
    expect(Object.keys(pairs).sort()).toEqual(['model_proxy', 'otel', 'process', 'transcript']);
    expect(pairs).toEqual({ ...DAEMON_TOOL_ORCHESTRATION_LANES });
  });

  it('every daemon lane clears intake', async () => {
    const lanes = Object.entries(DAEMON_TOOL_ORCHESTRATION_LANES);
    expect(lanes.length).toBe(4);
    for (const [source, tool] of lanes) {
      const result = await intake({ source, tool, tool_count: 2, turn_id: 'tc:' + 'b'.repeat(64) });
      expect([source, result]).not.toEqual([source, REFUSED]);
    }
  });

  it('the retired Hermes plugin\'s per-call PE is refused', async () => {
    expect(await intake({
      tool: 'hermes', turn_id: 'hermes:' + 'c'.repeat(32), tool_count: 1,
      tool_names: ['terminal'], errored_tool_calls: 0, success: true,
    })).toEqual(REFUSED);
  });

  it('the retired Python LangChain and CrewAI callbacks\' PEs are refused', async () => {
    for (const tool of ['provian-python-langchain', 'provian-python-crewai']) {
      expect([tool, await intake({
        tool, trace_id: 'd'.repeat(32), turn_id: 'tc:' + 'e'.repeat(64), tool_count: 2,
        tool_names: ['search'], errored_tool_calls: 0, service: null, success: true,
      })]).toEqual([tool, REFUSED]);
    }
  });

  it('a lane is named by its pair: a borrowed source, a borrowed tool or a missing half is refused', async () => {
    const cases: Record<string, unknown>[] = [
      { source: 'transcript', tool: 'provian-observer-otel' },
      { source: 'otel', tool: 'provian:model_proxy' },
      { source: 'model_proxy', tool: 'hermes' },
      { source: 'transcript' },
      { tool: 'provian:transcript' },
      { source: 'hermes', tool: 'hermes' },
    ];
    for (const md of cases) {
      expect([md, await intake({ ...md, tool_count: 1, turn_id: 'tc:' + 'f'.repeat(64) })]).toEqual([md, REFUSED]);
    }
  });

  it('a prototype key never names a lane', () => {
    for (const source of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(isDaemonToolOrchestrationLane({ source, tool: (Object.prototype as unknown as Record<string, unknown>)[source] })).toBe(false);
      expect(isDaemonToolOrchestrationLane({ source, tool: undefined })).toBe(false);
    }
    expect(isDaemonToolOrchestrationLane(null)).toBe(false);
    expect(isDaemonToolOrchestrationLane([])).toBe(false);
    expect(isDaemonToolOrchestrationLane('transcript')).toBe(false);
  });

  it('the guard covers only agent_tool_orchestration: another observed type is not judged by it', async () => {
    const result = await deviceActToAccrualParams(lane(), {
      ...act({ tool: 'hermes', api_count: 1 }), action_type: 'agent_api_orchestration',
    } as ActRecord, 'fixture').catch((err: Error) => ({ cleared_intake: true, error: err.message }));
    expect(result).not.toEqual(REFUSED);
  });
});
