/** One completed tool-calling model response, witnessed by the proxy alone. */
import path from 'path';
import os from 'os';
import fs from 'fs';
import type { PluginPE } from '../../types';
import type { ModelTurnObservation, RequestToolSchemas } from './parse';
import type { OriginWitness } from '../../../input-origins';
import { hash, writeLocal } from '../../program-witness';
import { classifyModelTurn } from './turn-pe';
interface Journal { serial: number; pending: Record<string, PluginPE>; responses: Record<string, boolean> }
export class ProgramProxyTurns {
  private state: Journal;
  private queue: PluginPE[];
  constructor(private readonly file = path.join(os.homedir(), '.provian', 'program-proxy-responses.json')) {
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Journal : { serial: 0, pending: {}, responses: {} };
    this.queue = Object.values(this.state.pending);
  }
  private save(): void { writeLocal(this.file, this.state); }
  observe(program: string, obs: ModelTurnObservation, ctx: { start: number; end: number; witness: OriginWitness | null; schemas?: RequestToolSchemas; digest: string }): void {
    const response = obs.responseId ? hash(program + ':' + obs.provider + ':' + obs.responseId) : null;
    if (response && this.state.responses[response]) return;
    const cls = classifyModelTurn(obs, { witness: ctx.witness, toolSchemas: ctx.schemas, responseDigest: ctx.digest,
      windowStart: ctx.start, windowEnd: Math.max(ctx.end, ctx.start + 1), durationMs: Math.max(1, ctx.end - ctx.start) });
    if (cls.kind !== 'tool_pe') return;
    // ID-less network responses are distinct occurrences. Durable pending state owns retries of delivery.
    const key = 'pr_' + (response ?? hash(program + ':' + ++this.state.serial + ':' + ctx.start));
    const pe: PluginPE = { ...cls.pe, idempotencyKey: key, identityDecided: true,
      metadata: { ...cls.pe.metadata, program, turn_id: key, capture_unit: 'model_response' }, occurredAtMs: ctx.end };
    if (response) this.state.responses[response] = true;
    this.state.pending[key] = pe; this.save(); this.queue.push(pe);
  }
  drain(): PluginPE[] { const q = this.queue; this.queue = []; return q; }
  commit(pe: PluginPE, failed: boolean): void {
    if (failed) { this.queue.push(pe); return; }
    if (pe.idempotencyKey) delete this.state.pending[pe.idempotencyKey]; this.save();
  }
}
