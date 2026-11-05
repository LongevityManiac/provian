/**
 * EarningSurfaceRegistry - the catalog of every PE creation / PVT eligibility
 * surface a user can connect.
 *
 * Each entry describes one "earning surface": a witness class through which
 * the user's participation in the intelligence economy becomes Provenance
 * Envelopes. Producing PEs is not the same as minting PVT: work mints, and the
 * bookkeeping around it does not — every act of work mints once at its best-supported value. The Earn tab renders this
 * registry; adding a new surface
 * (a new witness, a new connected service) is one entry here plus its
 * i18n copy - no screen changes.
 *
 * Grouping follows the witness model (docs/PE_GENERATION_MODEL.md):
 *   - phone:    surfaces built into the app itself - zero setup
 *   - computer: a registered machine observing local work (Witness 1)
 *   - services: "your other accounts" - a wallet the person already holds,
 *     proven theirs (the chain is the witness), and relay-witnessed external
 *     services (Witness 3) that capture work wherever it happens - on your
 *     machine, in CI, or by agents running in the cloud where no device
 *     daemon can observe them.
 *   - agents:   governed agents connected through the relay (Witness 2)
 *
 * Status resolution is a pure function of observable inputs so it can be
 * unit-tested without mocking services. The screen gathers the inputs
 * (consent flags, relay device/agent lists, recent PE history) and passes
 * them in.
 */

export type EarnGroup = 'phone' | 'computer' | 'services' | 'agents';

export type EarningSurfaceId =
    | 'chat_capture'
    | 'promises'
    | 'commons'
    | 'wallet_activity'
    | 'desktop_daemon'
    | 'own_external_wallet'
    | 'github'
    | 'gitlab'
    | 'bitbucket'
    | 'connected_agents'
    | 'agent_external_wallet';

/**
 * setup     - not connected/enabled yet; the card's job is acquisition.
 * connected - enabled, but no PEs observed in the recent history window.
 * earning   - enabled and producing PEs recently.
 */
export type SurfaceStatus = 'setup' | 'connected' | 'earning';

/** Forge webhook connectors (Witness 3) with an in-app connect flow. */
export type ForgeProvider = 'github' | 'gitlab' | 'bitbucket';

/**
 * Where the surface's call-to-action leads. Kept as plain literals so this
 * core module does not depend on navigation types; EarnHubScreen and
 * EarnSurfaceDetailScreen own the mapping to navigation calls.
 */
export type SurfaceTarget =
    | { kind: 'tab'; tab: 'ChatTab' | 'PromisesTab' | 'WalletTab' }
    | { kind: 'screen'; screen: 'CommonsDashboard' | 'CommonsOnboarding' | 'ProveOwnWallet' }
    | { kind: 'connect'; mode: 'device' | 'agent' }
    | { kind: 'forge'; provider: ForgeProvider }
    // Opens an external URL via Linking (e.g. the public "learn more" page). The
    // action itself is agent-side (the human cannot call the link endpoint), so
    // this surface's CTA educates rather than launching an in-app flow.
    | { kind: 'url'; url: string };

/** A PE action type this surface records (label comes from the canonical actionTypeDisplay map). */
export interface SurfacePEType {
    actionType: string;
}

export interface EarningSurface {
    id: EarningSurfaceId;
    group: EarnGroup;
    /** Ionicons glyph name used on cards and the detail screen. */
    icon: string;
    /** Representative PE types shown on the detail screen ("what it records"). */
    peTypes: SurfacePEType[];
    /** Exact action types counted toward this surface's recent activity. */
    matchExact: string[];
    /** Action-type prefixes counted toward this surface's recent activity. */
    matchPrefixes: string[];
    /** Number of how-to steps in the detail screen (earn.surfaces.<id>.step1..N). */
    stepCount: number;
    /** Whether the detail screen shows an extra note (earn.surfaces.<id>.note). */
    hasNote?: boolean;
    /**
     * Connector is on the roadmap but has no in-app connect flow yet. The card
     * shows a "Coming soon" badge and the detail CTA is non-actionable. No
     * current surface sets this (the forge connectors gained their in-app
     * connect flow in B3,); the mechanism stays for future connectors
     * that land in the registry before their connect flow ships.
     */
    comingSoon?: boolean;
    /** Where the primary CTA navigates. Omitted for coming-soon surfaces. */
    target?: SurfaceTarget;
}

export const EARNING_SURFACES: readonly EarningSurface[] = [
    // ── On your phone ────────────────────────────────────────────────
    {
        id: 'chat_capture',
        group: 'phone',
        icon: 'chatbubbles-outline',
        peTypes: [{ actionType: 'ai_conversation' }],
        matchExact: ['ai_conversation'],
        matchPrefixes: [],
        stepCount: 2,
        target: { kind: 'tab', tab: 'ChatTab' },
    },
    {
        id: 'promises',
        group: 'phone',
        icon: 'heart-outline',
        peTypes: [
            { actionType: 'promise_created' },
            { actionType: 'promise_accepted' },
            { actionType: 'promise_fulfilled' },
        ],
        matchExact: [],
        matchPrefixes: ['promise_'],
        stepCount: 3,
        target: { kind: 'tab', tab: 'PromisesTab' },
    },
    {
        id: 'commons',
        group: 'phone',
        icon: 'globe-outline',
        peTypes: [
            { actionType: 'commons_post_created' },
            { actionType: 'commons_vouch_given' },
            { actionType: 'human_job_delivered' },
        ],
        matchExact: [],
        matchPrefixes: ['commons_', 'human_job_'],
        stepCount: 3,
        target: { kind: 'screen', screen: 'CommonsDashboard' },
    },
    {
        id: 'wallet_activity',
        group: 'phone',
        icon: 'wallet-outline',
        peTypes: [
            { actionType: 'send' },
            { actionType: 'swap' },
            { actionType: 'onramp' },
        ],
        matchExact: ['send', 'swap', 'receive', 'onramp', 'approve', 'stake'],
        matchPrefixes: [],
        stepCount: 2,
        target: { kind: 'tab', tab: 'WalletTab' },
    },

    // ── Your computer ────────────────────────────────────────────────
    {
        id: 'desktop_daemon',
        group: 'computer',
        icon: 'laptop-outline',
        peTypes: [
            { actionType: 'coding_session' },
            { actionType: 'inference_session' },
            { actionType: 'compute_session' },
        ],
        matchExact: ['coding_session', 'inference_session', 'compute_session'],
        matchPrefixes: [],
        // Two lines that point at Connect, not a restatement of its screen.
        stepCount: 2,
        target: { kind: 'connect', mode: 'device' },
    },

    // ── Your other accounts ──────────────────────────────────────────
    // A PERSON proves a wallet they already hold (MetaMask, Coinbase Wallet …)
    // is theirs, in-app, with no agent and no code: one message signed in that
    // wallet (ProveOwnWalletScreen → POST /v1/wallet/external-address/*). From
    // the proof on, its sends, swaps, and receives from people they've dealt
    // with on Base are chain-witnessed like their Provian wallet's. Proving
    // itself pays nothing. Status is the proven-wallet count
    // (GET /v1/wallet/external-addresses), not the PE history: that activity is
    // already counted by wallet_activity, so it is not double-matched here.
    {
        id: 'own_external_wallet',
        group: 'services',
        icon: 'key-outline',
        peTypes: [
            { actionType: 'send' },
            { actionType: 'swap' },
            { actionType: 'receive' },
        ],
        matchExact: [],
        matchPrefixes: [],
        stepCount: 3,
        hasNote: true,
        target: { kind: 'screen', screen: 'ProveOwnWallet' },
    },

    // ── Forge webhooks (Witness 3) ───────────────────────────────────
    // The relay has GitHub, GitLab, and Bitbucket webhook receivers
    // (config-gated), and each surface connects in-app via ForgeConnectScreen
    // (B3,): GitHub through the App-install handoff, GitLab/Bitbucket
    // through project/repo registration with a one-time webhook secret. The
    // desktop daemon separately creates PEs on local commits (Witness 1).
    {
        id: 'github',
        group: 'services',
        icon: 'logo-github',
        peTypes: [
            { actionType: 'service:github_commit' },
            { actionType: 'service:github_pr_merged' },
        ],
        matchExact: [],
        matchPrefixes: ['service:github'],
        stepCount: 3,
        target: { kind: 'forge', provider: 'github' },
    },
    {
        id: 'gitlab',
        group: 'services',
        icon: 'logo-gitlab',
        peTypes: [
            { actionType: 'service:gitlab_push' },
            { actionType: 'service:gitlab_mr_merged' },
        ],
        matchExact: [],
        matchPrefixes: ['service:gitlab'],
        stepCount: 3,
        target: { kind: 'forge', provider: 'gitlab' },
    },
    {
        id: 'bitbucket',
        group: 'services',
        icon: 'logo-bitbucket',
        peTypes: [
            { actionType: 'service:bitbucket_push' },
            { actionType: 'service:bitbucket_pr_merged' },
        ],
        matchExact: [],
        matchPrefixes: ['service:bitbucket'],
        stepCount: 3,
        target: { kind: 'forge', provider: 'bitbucket' },
    },

    // ── Your agents ──────────────────────────────────────────────────
    {
        id: 'connected_agents',
        group: 'agents',
        icon: 'hardware-chip-outline',
        peTypes: [
            // Representative MINTING agent work (all `eligible` in the action-policy
            // matrix). The link itself (agent_linked_to_human) and delegation
            // (agent_work_delegated) are record-only, and an SDK-reported
            // x402_payment mints 0, so none of them is shown as "what it records".
            { actionType: 'agent_task_completed' },
            { actionType: 'agent_work_product' },
            { actionType: 'agent_tool_orchestration' },
            { actionType: 'link_spend' },
        ],
        matchExact: ['x402_payment'],
        matchPrefixes: ['agent_'],
        // Two lines that point at Connect, not a restatement of its screen.
        stepCount: 2,
        target: { kind: 'connect', mode: 'agent' },
    },
    {
        // An agent can PROVE control of a Base wallet it already runs; its
        // go-forward on-chain financial activity then maps to PEs on the standard
        // record path (agent-authenticated — the human educates and nudges, the
        // agent links). Earning here is not read from the human's PE history (the
        // activity happens under the agent's own wallet), so status is driven by
        // how many of the operator's linked agents have actually proven an
        // external address (see SurfaceStatusInputs).
        id: 'agent_external_wallet',
        group: 'agents',
        icon: 'link-outline',
        peTypes: [
            { actionType: 'send' },
            { actionType: 'receive' },
            { actionType: 'swap' },
            { actionType: 'x402_payment' },
        ],
        matchExact: [],
        matchPrefixes: [],
        stepCount: 3,
        hasNote: true,
        target: { kind: 'url', url: 'https://provian.ai/earn' },
    },
];

/** Display order of groups on the Earn hub. */
export const EARN_GROUP_ORDER: readonly EarnGroup[] = ['phone', 'computer', 'services', 'agents'];

// ─── Status resolution ───────────────────────────────────────────────

export interface SurfaceStatusInputs {
    /** Mobile chat capture consent (null = never asked). */
    chatConsent: boolean | null;
    /** Count of active registered devices (Witness 1). */
    activeDeviceCount: number;
    /** Count of relay-linked agents (beneficiary links). */
    linkedAgentCount: number;
    /**
     * Of the linked agents, how many have PROVEN an external Base address
     * (GET /v1/relay/agent/sessions → linked_agents[].external_address_linked).
     * Drives the agent_external_wallet surface's "earning" state, because that
     * surface's activity is the agent's own on-chain movement, not the human's
     * PE history. Zero on older relays that don't send the flag.
     */
    linkedAgentsWithExternalWalletCount: number;
    /**
     * How many wallets the PERSON has proven they hold
     * (GET /v1/wallet/external-addresses). Drives the own_external_wallet surface.
     */
    ownExternalWalletCount: number;
    /**
     * Whether ANY relay-linked agent is actually live right now — i.e. its
     * per-agent liveness (from `agentLiveness()` over `last_pe_date` /
     * capture-health) reads 'live', the same signal Agent Hub shows. Used to
     * reconcile the `connected_agents` "earning" state with Agent Hub: the
     * human's recent PE history can show agent PEs while every linked agent has
     * actually gone stale, so "earning" additionally requires a live agent.
     */
    anyLinkedAgentLive: boolean;
    /** Whether the user has a Commons profile. */
    commonsJoined: boolean;
    /**
     * Forge providers with at least one ACTIVE (non-revoked) service install
     * for this wallet, from GET /v1/witnesses/installs (Witness 3).
     */
    activeForgeInstallProviders: readonly ForgeProvider[];
    /** Action types from the user's recent PE history window. */
    recentActionTypes: readonly string[];
}

export interface SurfaceStatusResult {
    status: SurfaceStatus;
    /** How many recent-history PEs matched this surface. */
    recentPECount: number;
}

export function matchesSurface(surface: EarningSurface, actionType: string): boolean {
    if (surface.matchExact.includes(actionType)) return true;
    return surface.matchPrefixes.some((p) => actionType.startsWith(p));
}

function countRecent(surface: EarningSurface, recentActionTypes: readonly string[]): number {
    let n = 0;
    for (const at of recentActionTypes) {
        if (matchesSurface(surface, at)) n++;
    }
    return n;
}

function isConnected(surface: EarningSurface, inputs: SurfaceStatusInputs, recentPECount: number): boolean {
    switch (surface.id) {
        case 'chat_capture':
            return inputs.chatConsent === true;
        // Promises and wallet activity are built into the app - there is no
        // connect step, so they are always at least 'connected'.
        case 'promises':
        case 'wallet_activity':
            return true;
        // The Zustand commons store hydrates lazily; observed commons PEs are
        // equally good evidence of membership after a reinstall or cold start.
        case 'commons':
            return inputs.commonsJoined || recentPECount > 0;
        case 'desktop_daemon':
            return inputs.activeDeviceCount > 0;
        case 'own_external_wallet':
            return inputs.ownExternalWalletCount > 0;
        // Forge webhook connectors (Witness 3): connected when the wallet has
        // at least one active service install for that provider. Observed
        // service:<provider> PEs are equally good evidence (e.g. an install
        // registered from the CLI before the relay list loaded).
        case 'github':
        case 'gitlab':
        case 'bitbucket':
            return inputs.activeForgeInstallProviders.includes(surface.id) || recentPECount > 0;
        case 'connected_agents':
            return inputs.linkedAgentCount > 0;
        // Connected once the operator has an agent that COULD link a wallet.
        // Whether one actually has is the 'earning' promotion in
        // resolveSurfaceStatus (linkedAgentsWithExternalWalletCount).
        case 'agent_external_wallet':
            return inputs.linkedAgentCount > 0;
    }
}

export function resolveSurfaceStatus(
    surface: EarningSurface,
    inputs: SurfaceStatusInputs,
): SurfaceStatusResult {
    // Coming-soon connectors have no in-app connect flow, so they always read
    // as 'setup' regardless of history. The UI shows a "Coming soon" badge off
    // the surface.comingSoon flag rather than this status value.
    if (surface.comingSoon) {
        return { status: 'setup', recentPECount: 0 };
    }
    const recentPECount = countRecent(surface, inputs.recentActionTypes);
    if (!isConnected(surface, inputs, recentPECount)) {
        return { status: 'setup', recentPECount };
    }
    // The agent_external_wallet surface earns on the agent's OWN on-chain
    // activity (not in the human's recent PE history), so its "earning" signal is
    // whether any linked agent has actually proven an external address. We report
    // that count as recentPECount so the detail screen can say how many of the
    // operator's agents have a wallet linked.
    // A proven wallet is a connection; its activity is the wallet_activity
    // surface's to count. recentPECount carries the proven-wallet count.
    if (surface.id === 'own_external_wallet') {
        return { status: 'connected', recentPECount: inputs.ownExternalWalletCount };
    }
    if (surface.id === 'agent_external_wallet') {
        const linkedCount = inputs.linkedAgentsWithExternalWalletCount;
        return {
            status: linkedCount > 0 ? 'earning' : 'connected',
            recentPECount: linkedCount,
        };
    }
    // The connected_agents surface reconciles with Agent Hub: recent agent PEs
    // in the human's history are not enough to read "earning" if every linked
    // agent has actually gone stale (capture broken / no recent PE). Require a
    // live agent as well, so a connected-but-not-producing agent reads
    // 'connected' on both surfaces.
    if (surface.id === 'connected_agents') {
        const earning = recentPECount > 0 && inputs.anyLinkedAgentLive;
        return { status: earning ? 'earning' : 'connected', recentPECount };
    }
    return { status: recentPECount > 0 ? 'earning' : 'connected', recentPECount };
}

export function resolveAllSurfaceStatuses(
    inputs: SurfaceStatusInputs,
): Record<EarningSurfaceId, SurfaceStatusResult> {
    const out = {} as Record<EarningSurfaceId, SurfaceStatusResult>;
    for (const surface of EARNING_SURFACES) {
        out[surface.id] = resolveSurfaceStatus(surface, inputs);
    }
    return out;
}

export function getSurface(id: EarningSurfaceId): EarningSurface {
    const found = EARNING_SURFACES.find((s) => s.id === id);
    if (!found) {
        // Unreachable for valid ids; throwing keeps the return type non-optional.
        throw new Error(`Unknown earning surface: ${id}`);
    }
    return found;
}

/**
 * A linked agent is an existing relationship, not an acquisition funnel.
 * Both the Earn tile and the detail CTA use this one decision so a connected
 * or earning user always lands in Agent Hub; only a true setup state starts
 * the first-agent flow.
 */
export function shouldManageConnectedAgents(
    surfaceId: EarningSurfaceId,
    status: SurfaceStatus,
): boolean {
    return surfaceId === 'connected_agents' && status !== 'setup';
}

/**
 * Whether the connection source that can legitimately produce a surface's
 * setup state has answered. Recent-history enrichment is deliberately not part
 * of this gate: it may promote Connected → Earning later, but it must never
 * delay the truthful "you are connected" identity state.
 */
export interface SurfaceConnectionReadiness {
    chatConsent: boolean;
    devices: boolean;
    linkedAgents: boolean;
    commons: boolean;
    forgeInstalls: boolean;
    ownExternalWallets: boolean;
}

export function isSurfaceConnectionKnown(
    surface: EarningSurface,
    readiness: SurfaceConnectionReadiness,
): boolean {
    if (surface.comingSoon) return true;
    switch (surface.id) {
        case 'chat_capture':
            return readiness.chatConsent;
        case 'desktop_daemon':
            return readiness.devices;
        case 'own_external_wallet':
            return readiness.ownExternalWallets;
        case 'connected_agents':
        case 'agent_external_wallet':
            return readiness.linkedAgents;
        case 'commons':
            return readiness.commons;
        case 'github':
        case 'gitlab':
        case 'bitbucket':
            return readiness.forgeInstalls;
        case 'promises':
        case 'wallet_activity':
            return true;
    }
}

export function surfacesByGroup(group: EarnGroup): EarningSurface[] {
    return EARNING_SURFACES.filter((s) => s.group === group);
}
