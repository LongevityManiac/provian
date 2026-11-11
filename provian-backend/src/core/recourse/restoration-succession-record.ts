import type { SuccessionTraceCheckpoint, SuccessionTraceEvent } from './restoration-succession-trace';
import type { RestorationBalanceBridge, RestorationBalanceRef } from './restoration-bridge-ledger';
type BridgeEvent = Extract<SuccessionTraceEvent, { kind: 'bridge' }>;
type RecordedBridge = Omit<RestorationBalanceBridge, 'sources'> & {
  readonly sources: readonly { readonly ref: RestorationBalanceRef; readonly amount: string }[];
};
export type RecordedSuccessionEvent = Exclude<SuccessionTraceEvent, BridgeEvent> | (Omit<BridgeEvent, 'bridge'> & { readonly bridge: RecordedBridge });
/** JSON-safe private determination evidence. Amounts retain exact base units;
 * no floating-point conversion or serialized BigInt extension is used. */
export interface RecordedSuccessionCheckpoint extends Omit<SuccessionTraceCheckpoint, 'events'> {
  readonly events: readonly RecordedSuccessionEvent[];
}
export function recordSuccessionCheckpoint(checkpoint: SuccessionTraceCheckpoint): RecordedSuccessionCheckpoint {
  return { ...checkpoint, events: checkpoint.events.map(event => event.kind === 'transfer' ? event : { ...event,
    bridge: { ...event.bridge, sources: event.bridge.sources.map(source => ({ ...source, amount: source.amount.toString() })) } }) };
}
export function readSuccessionCheckpoint(checkpoint: RecordedSuccessionCheckpoint): SuccessionTraceCheckpoint {
  return { ...checkpoint, events: checkpoint.events.map(event => event.kind === 'transfer' ? event : { ...event,
    bridge: { ...event.bridge, sources: event.bridge.sources.map(source => {
      if (!/^(0|[1-9][0-9]*)$/.test(source.amount) || BigInt(source.amount) >= (1n << 256n)) throw Error('recourse_collection_record_amount_invalid');
      return { ...source, amount: BigInt(source.amount) };
    }) } }) };
}
