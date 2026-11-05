import type { ProvianObserver } from '../ProvianObserver';
import type { PluginContribution, PluginPE, SessionState } from '../types';

export interface ObserverPlugin {
  /** Plugin name (for logging and dedup registry) */
  readonly name: string;

  /** Initialize the plugin. Called once at observer startup. */
  init(observer: ProvianObserver): Promise<void>;

  /** Start watching. Called after init. */
  start(): Promise<void>;

  /** Stop watching. Called on observer shutdown. */
  stop(): Promise<void>;

  /**
   * Called by observer on each session tick (~1s).
   * Return null if the plugin has nothing to contribute on this tick.
   */
  tick(session: SessionState | null): PluginContribution | null;

  /**
   * Drain any queued plugin-generated PEs that are ready to submit.
   * Called after each tick. The observer submits these PEs and claims
   * their time windows in the dedup registry.
   */
  drainPEs?(): PluginPE[];

  /**
   * review 4: the fate of one PE this plugin handed over in `drainPEs`,
   * once the observer knows it — `submitted` (the relay accepted it), `journaled`
   * (durably queued in the PE outbox, resent until accepted), `rejected` (the
   * relay judged its content), `suppressed` (not submitted by design: a
   * supplement, a same-turn duplicate, a claimed window) or `failed` (neither
   * submitted nor journaled). A lane that keeps a durable read position or
   * journal advances it past a PE only on a fate other than `failed`.
   */
  onCommitted?(pe: PluginPE, outcome: PECommitOutcome): void;

  /**
   * review 4: called once on shutdown AFTER the observer has submitted (or
   * journaled) everything the plugins decided while stopping — the moment to
   * persist read positions past those PEs.
   */
  finalize?(): Promise<void>;
}

/** What became of one drained PE (see `onCommitted`). */
export type PECommitOutcome = 'submitted' | 'journaled' | 'rejected' | 'suppressed' | 'failed';
