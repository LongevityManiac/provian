/**
 * Agents module — what remains after the wallet simplification.
 *
 * The Agent Authorization Gate, execution gate, policy/friction/telemetry
 * engines, local agent API server, sessions and the emergency stop were removed:
 * the wallet witnesses agent work and mints PVT; it does not govern agents.
 * The human WalletConnect signing pipeline now lives in core/crypto-governance/.
 */

// Environment Attestation (device integrity / recovery — kept, )
export {
    default as EnvironmentAttestationTracker,
    type DriftResult,
    type AgentEnvironmentBaseline,
    type AttestationConfig,
} from './EnvironmentAttestation';

// Agent lifecycle helpers
export { deriveAgentStatus, type AgentStatusTone } from './agentStatus';
export { resolveAgentDetailSource } from './agentDetailResolve';
export { mintAndPersistRecoveryAnchor } from './agentRecovery';
export { formatAgentOnboardingError } from './agentOnboardingErrors';
