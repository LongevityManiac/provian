/**
 * What the Wallet home's "Your Agents" card shows.
 *
 * "Connect an agent" is a statement that the person has no agents. It is shown only for an answer
 * the relay gave (now or saved earlier) that held zero agents — never while the first answer is
 * still on its way, and never when every read failed with nothing saved (a person with agents
 * would be told to connect one).
 */
import type { WalletTopPhase } from '../../core/wallet/walletTopLoad';

export type YourAgentsCardMode = 'loading' | 'failed' | 'connect' | 'agents';

export function yourAgentsCardMode(phase: WalletTopPhase, agentCount: number): YourAgentsCardMode {
    if (phase === 'loading' || phase === 'failed') return phase;
    return agentCount === 0 ? 'connect' : 'agents';
}
