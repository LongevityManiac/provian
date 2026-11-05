/**
 * ConnectAgentScreen - the Connect hub : three connections, each with one
 * simple instruction. On every screen the one thing the person must do is visible in the fewest
 * words, and everything explanatory sits behind a "Details" tap, closed by default.
 *
 * 1. An AI agent - the one-line install command first (send it to the agent, or run it where the
 * agent lives; when it asks to link, tap Accept), the connection code always shown with copy
 * (for an agent that connects over MCP or the SDK), one line about hosted agents, and the
 * waiting / request / already-connected card. Under Details: what connecting sets up, what
 * earns, MCP and the SDK, bring your other agents, recovery. The MCP server URL and the npx
 * onboard line are the two lines the relay's launch switch (`core/relay/launchState.ts`)
 * governs: "Opens at launch", not copyable, until the flip.
 * 2. Your computer - the capture disclosure, the one command, and one line saying it is done.
 * Under Details: what gets witnessed, the coding-tool exception, the agent-machine pointer,
 * one command per computer.
 * 3. A code host - GitHub, GitLab or Bitbucket, through signed webhooks (ForgeConnectScreen).
 *
 * All copy reads as if everything has launched. An agent-initiated beneficiary invite starts on
 * the agent's side (invite_human), not here.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    ActivityIndicator,
    BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import type { AppParamList } from '../../navigation/types';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { useTheme } from '../../theme';
import RelayAPIService, { type AgentLinkRequest, type ConnectionTokenResponse } from '../../services/RelayAPIService';
import { resolveRelayBaseUrl } from '../../core/relay/DevHostDiscovery';
import { mintAndPersistRecoveryAnchor } from '../../core/agents/agentRecovery';
import { formatAgentOnboardingError } from '../../core/agents/agentOnboardingErrors';
import BackButton from '../../components/BackButton';
import { connectLaunchGates, useLaunchState, type ConnectLaunchGates, type LaunchGate, type LaunchState } from '../../core/relay/launchState';
import {
    AGENT_FLEET_CODE_CMD,
    AGENT_HELP_CMD,
    AGENT_START_OBSERVER_CMD,
    MCP_FLEET_CODE_TOOL,
    NPX_SDK_ONBOARD_CMD,
} from '../../core/agents/agentShellCommands';

// Setup commands are code, not translatable copy. The primary command on each path is the hosted
// curl flow against the live relay - the exact endpoint each token is consumed by (mirrors
// provian-backend/src/core/setup-command.ts - keep the shapes in step). The MCP server URL and the
// npx onboard line need the open `/mcp` and the published SDK; they read the launch switch
// (launchState.ts).
const RELAY_URL = resolveRelayBaseUrl();
/** How often the open agent path checks for the agent's link request. */
const LINK_REQUEST_POLL_MS = 5000;

// TWO-TOUCH ONBOARDING: the ONE command the human copies. The relay's hosted
// bootstrap script provisions the agent end-to-end from a single connection
// token, so this is the PRIMARY copy artifact for the agent path. The token
// rides the x-provian-token HEADER, not a `-d '{"token":"…"}'` JSON body: agent
// shells (e.g. OpenClaw) re-quote the nested body quotes down to an empty token,
// and a header has no inner quotes to mangle. It is a GET (item 9): a
// body-less POST with no Content-Length is refused 411 by Google Front End before
// it reaches the relay, and fetching the script to inspect it never spends the
// code. Mirrors buildAgentInstallLines in
// provian-backend/src/core/agent-bootstrap-script.ts — keep the shapes in step.
// relay_url is taken from the token response (no trailing slash); token is PROV-XXXX-XXXX.
const BOOTSTRAP_AGENT_CMD = (relayUrl: string, token: string): string =>
    `curl -sSL -H 'x-provian-token: ${token}' "${relayUrl}/v1/bootstrap/agent" | sh`;
// Windows (PowerShell) equivalent (token + platform via headers).
const BOOTSTRAP_AGENT_CMD_WINDOWS = (relayUrl: string, token: string): string =>
    `irm -Headers @{'x-provian-token'='${token}';'x-provian-platform'='windows'} "${relayUrl}/v1/bootstrap/agent" | iex`;

// / the agent runs every Commons / on-chain act from its shell through the
// installed agent script (`help` lists the verbs), and keeps the observer running where nothing on
// its box restarts it. Shared with the Agent Hub hint (core/agents/agentShellCommands.ts).
const HOSTED_BOT_HELP_CMD = AGENT_HELP_CMD;
const HOSTED_BOT_KEEP_RUNNING_CMD = AGENT_START_OBSERVER_CMD;

// "Connect a computer": the ONE command the human runs on their desktop. Mirrors
// the agent bootstrap — GET /v1/bootstrap/device with the one-time 64-hex
// device_registration token in the header, which returns an sh script that ensures Node.js and runs
// register-device full setup (register + credentials + git hook + observer). No
// client Idempotency-Key: register-device carries its own per-machine replay
// marker. Takes effect at the npm-publish flip (mirrors buildDeviceBootstrapCommand
// in provian-backend/src/core/device-bootstrap-script.ts — keep the shapes in step).
const BOOTSTRAP_DEVICE_CMD = (relayUrl: string, token: string): string =>
    `curl -sSL -H 'x-provian-token: ${token}' "${relayUrl}/v1/bootstrap/device" | sh`;
// Windows (PowerShell) equivalent: x-provian-platform:windows header makes the
// relay return a PowerShell script; irm | iex runs it. Day-one Windows support.
const BOOTSTRAP_DEVICE_CMD_WINDOWS = (relayUrl: string, token: string): string =>
    `irm -Headers @{'x-provian-token'='${token}';'x-provian-platform'='windows'} "${relayUrl}/v1/bootstrap/device" | iex`;

// Git-host connect (GitHub / GitLab / Bitbucket) is its own live flow (ForgeConnectScreen); the
// code-host picker here deep-links straight into it.
type Mode = 'choose' | 'device' | 'agent' | 'codeHost';
type LoadState = 'idle' | 'loading' | 'ready' | 'error';

interface TokenState {
    token: string;
    expiresAt: number;
    /**
     * Stable idempotency anchor for the register curl, generated alongside the
     * token so re-renders and re-copies keep ONE key per token (a re-run of
     * the same pasted line then replays instead of burning a second device).
     */
    idempotencyKey: string;
    /**
     * relay_url from the token response (agent path). Used to build the
     * one-line hosted bootstrap command. Falls back to the RELAY_URL constant.
     */
    relayUrl?: string;
    /**
     * Two-touch onboarding (agent path): whether a durable, cloud-backed
     * recovery anchor was minted for this invite. false when cloud backup is
     * unavailable — the agent still connects and works, it just has no escrow.
     */
    recoveryEnabled?: boolean;
}

// Re-lock hardening (the silent-invite incident): a connect/device code lives in
// component state only, so an app re-lock — background > 30s resets the stack to
// WalletLock — UNMOUNTS this screen and destroys the code. A human who already
// pasted that code to their agent then returns to a freshly-minted DIFFERENT
// code, and the sent one looks "dead" even though it is valid for its full hour.
// Cache the live code and REUSE it on remount while comfortably unexpired, so the
// on-screen code stays the one the human distributed. SecureStore (not
// AsyncStorage): a connection code is a bearer invite — Security Invariant #5.
const TOKEN_CACHE_KEY: Record<'agent' | 'device', string> = {
    agent: 'provian.connect.agentToken',
    device: 'provian.connect.deviceToken',
};
// Don't hand back a code about to expire mid-paste; mint fresh under this margin.
const TOKEN_REUSE_MARGIN_MS = 60_000;

async function loadCachedToken(kind: 'agent' | 'device'): Promise<TokenState | null> {
    try {
        const raw = await SecureStore.getItemAsync(TOKEN_CACHE_KEY[kind]);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<TokenState>;
        if (typeof parsed?.token !== 'string' || typeof parsed?.expiresAt !== 'number') return null;
        if (typeof parsed.idempotencyKey !== 'string') return null;
        // Expired or too close to expiry to be worth reusing.
        if (parsed.expiresAt - Date.now() <= TOKEN_REUSE_MARGIN_MS) return null;
        return parsed as TokenState;
    } catch {
        return null;
    }
}

async function saveCachedToken(kind: 'agent' | 'device', token: TokenState): Promise<void> {
    try {
        await SecureStore.setItemAsync(TOKEN_CACHE_KEY[kind], JSON.stringify(token));
    } catch {
        // Non-fatal: a persistence miss just means the next remount re-mints.
    }
}

/**
 * Mint a FRESH agent link code. TOUCH 1 (two-touch onboarding): mint + durably
 * persist the recovery anchor FIRST so its PUBLIC half rides the connection-token
 * request. The SECRET half lands in the same cloud-backed keychain as the human's
 * own wallet (survives phone loss). If cloud backup is unavailable this returns
 * recoveryEnabled:false — we still issue a working token, just without an
 * escrow, and say so honestly. Never stored device-only.
 */
async function mintAgentConnectionToken(): Promise<TokenState> {
    const anchor = await mintAndPersistRecoveryAnchor();
    const data: ConnectionTokenResponse = await RelayAPIService.generateConnectionToken(
        'Mobile-issued',
        anchor.recoveryEnabled ? anchor.recoveryAnchorPubkeyB64u : undefined,
    );
    return {
        token: data.connection_token,
        expiresAt: data.expires_at,
        idempotencyKey: Crypto.randomUUID(),
        relayUrl: data.relay_url,
        recoveryEnabled: anchor.recoveryEnabled,
    };
}

/** m:ss for a code's remaining lifetime. */
function formatCountdown(remainingMs: number): string {
    const total = Math.floor(Math.max(0, remainingMs) / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

const ConnectAgentScreen = (): React.JSX.Element => {
    const navigation = useNavigation<any>();
    const route = useRoute<RouteProp<AppParamList, 'ConnectAgent'>>();
    const { t } = useTranslation();
    const { colors: themeColors } = useTheme();
    // The launch switch (null until known): the MCP / SDK / fleet forms that open at the flip.
    const launch = useLaunchState();

    // Deep links (e.g. from the Earn tab) can land directly on a path.
    const initialMode: Mode = route.params?.mode ?? 'choose';
    const [mode, setMode] = useState<Mode>(initialMode);

    // Back-button routing: the header arrow (and Android hardware back) return to
    // the in-screen chooser ONLY when the user actually reached this mode by
    // tapping a chooser card. When the screen is DEEP-LINKED straight into a mode
    // (Earn CTA passes mode:'agent'), there was no chooser behind us — back must
    // pop the stack to where we came from, not surface a chooser never seen.
    const cameFromChooser = useRef(initialMode === 'choose');

    // Device path state (Witness 1 - one-time device registration token)
    const [deviceState, setDeviceState] = useState<LoadState>('idle');
    const [deviceToken, setDeviceToken] = useState<TokenState | null>(null);

    // Agent path state (Witness 2 - relay connection token)
    const [agentState, setAgentState] = useState<LoadState>('idle');
    const [agentToken, setAgentToken] = useState<TokenState | null>(null);

    // Requirement D: a mapped, plain-English failure for the agent path (never a
    // raw code). Rendered by the ErrorBlock in place of the generic copy.
    const [agentErrorMsg, setAgentErrorMsg] = useState<string | null>(null);

    const [remainingMs, setRemainingMs] = useState<number>(0);
    const [copiedKey, setCopiedKey] = useState<string | null>(null);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // How many agents this operator already has (linked beneficiaries + live
    // relay sessions). Gates the "Waiting for your agent to connect" spinner: a
    // returning operator who already has agents should not be shown perpetual
    // first-time onboarding — they see an "already connected → Manage" banner
    // instead, with the connect-another blocks still below it. Only the agent
    // path fetches this (the device path never showed the spinner).
    const [existingAgentCount, setExistingAgentCount] = useState<number>(0);
    useEffect(() => {
        let cancelled = false;
        void RelayAPIService.getLinkedAgents()
            .catch(() => ({ linked_agents: [] }))
            .then((data) => {
                if (cancelled) return;
                setExistingAgentCount(data.linked_agents.length);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // The waiting card promises "a request appears here": while the agent path
    // is open and focused, poll the operator's pending link requests so the
    // request surfaces on this screen (with a one-tap Review) the moment the
    // agent asks — not only in the bell or a push the simulator/phone may miss.
    const [pendingRequest, setPendingRequest] = useState<AgentLinkRequest | null>(null);
    useFocusEffect(
        useCallback(() => {
            if (mode !== 'agent') return undefined;
            let cancelled = false;
            const poll = () => {
                void RelayAPIService.getLinkRequests().then((data) => {
                    if (cancelled || !data) return;
                    setPendingRequest(data.link_requests[0] ?? null);
                });
            };
            poll();
            const id = setInterval(poll, LINK_REQUEST_POLL_MS);
            return () => {
                cancelled = true;
                clearInterval(id);
            };
        }, [mode]),
    );

    const generateDeviceToken = useCallback(async () => {
        setDeviceState('loading');
        try {
            const data = await RelayAPIService.generateDeviceToken();
            const next: TokenState = {
                token: data.token,
                expiresAt: data.expires_at,
                idempotencyKey: Crypto.randomUUID(),
            };
            setDeviceToken(next);
            void saveCachedToken('device', next);
            setDeviceState('ready');
        } catch {
            setDeviceState('error');
        }
    }, []);

    const generateAgentToken = useCallback(async () => {
        setAgentState('loading');
        setAgentErrorMsg(null);
        try {
            const next = await mintAgentConnectionToken();
            setAgentToken(next);
            void saveCachedToken('agent', next);
            setAgentState('ready');
        } catch (e) {
            setAgentErrorMsg(formatAgentOnboardingError(e));
            setAgentState('error');
        }
    }, []);

    // Automatic entry (chooser tap or deep-link) REUSES a still-valid cached code
    // so an app re-lock between minting and pasting doesn't swap the code the
    // human already sent their agent. It never MINTS on entry : minting
    // seals the recovery anchor, which is a biometric prompt, and a prompt must
    // answer the human's tap — not fire because a screen opened. With no cached
    // code the path shows "Get my setup command", which calls generateAgentToken.
    const restoreOrGenerateAgentToken = useCallback(async () => {
        setAgentState('loading');
        setAgentErrorMsg(null);
        const cached = await loadCachedToken('agent');
        if (cached) {
            setAgentToken(cached);
            setAgentState('ready');
            return;
        }
        setAgentState('idle');
    }, []);

    const restoreOrGenerateDeviceToken = useCallback(async () => {
        setDeviceState('loading');
        const cached = await loadCachedToken('device');
        if (cached) {
            setDeviceToken(cached);
            setDeviceState('ready');
            return;
        }
        await generateDeviceToken();
    }, [generateDeviceToken]);

    const openMode = useCallback(
        (next: Mode) => {
            // openMode is only ever called from a chooser card, so a mode entered
            // this way has the chooser behind it — back should return there.
            cameFromChooser.current = true;
            setMode(next);
            if (next === 'device' && deviceState === 'idle') restoreOrGenerateDeviceToken();
            if (next === 'agent' && agentState === 'idle') restoreOrGenerateAgentToken();
        },
        [deviceState, agentState, restoreOrGenerateDeviceToken, restoreOrGenerateAgentToken],
    );

    // When deep-linked straight into a token path, kick off generation on
    // mount (the normal entry point is openMode, which this bypasses).
    useEffect(() => {
        if (initialMode === 'device') restoreOrGenerateDeviceToken();
        if (initialMode === 'agent') restoreOrGenerateAgentToken();
        // Run once for the mount-time deep link only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Countdown for whichever token the current mode shows.
    const activeToken = mode === 'device' ? deviceToken : mode === 'agent' ? agentToken : null;
    useEffect(() => {
        if (!activeToken) return;
        const tick = () => setRemainingMs(Math.max(0, activeToken.expiresAt - Date.now()));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [activeToken]);

    useEffect(() => {
        return () => {
            if (copyTimer.current) clearTimeout(copyTimer.current);
        };
    }, []);

    const copy = useCallback(async (value: string, key: string) => {
        await Clipboard.setStringAsync(value);
        setCopiedKey(key);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopiedKey(null), 1800);
    }, []);

    const isExpired = activeToken != null && remainingMs <= 0;
    const countdown = formatCountdown(remainingMs);

    const goBack = useCallback(() => {
        // Return to the chooser only if we came through it; otherwise pop.
        if (mode !== 'choose' && cameFromChooser.current) {
            cameFromChooser.current = false;
            setMode('choose');
        } else {
            navigation.goBack();
        }
    }, [mode, navigation]);

    // Keep Android's hardware/gesture back in lockstep with the header arrow:
    // without this it pops straight out of a deep-linked mode, diverging from
    // the on-screen back button. Returning true means "handled, don't pop".
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (mode !== 'choose' && cameFromChooser.current) {
                cameFromChooser.current = false;
                setMode('choose');
                return true;
            }
            return false;
        });
        return () => sub.remove();
    }, [mode]);

    const headerTitle =
        mode === 'device'
            ? t('connectAgent.deviceTitle')
            : mode === 'agent'
              ? t('connectAgent.agentTitle')
              : mode === 'codeHost'
                ? t('connectAgent.codeHostTitle')
                : t('connectAgent.title');

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            <View style={styles.header}>
                <BackButton onPress={goBack} color={themeColors.textPrimary} />
                <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]} numberOfLines={1}>
                    {headerTitle}
                </Text>
                <View style={{ width: 44 }} />
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                {mode === 'choose' && (
                    <>
                        {/* Three cards, one short line each : no intro, no
                            caveats. An AI agent leads - this screen is reached from the
                            "Connect an Agent" entry points. */}
                        <PathCard
                            hero
                            icon="hardware-chip-outline"
                            title={t('connectAgent.agentPathTitle')}
                            body={t('connectAgent.agentPathBody')}
                            onPress={() => openMode('agent')}
                        />

                        {/* Your computer: the person's own work, as them. The coding-tool
                            tool-call exception sits under the
                            device path's Details. */}
                        <PathCard
                            icon="laptop-outline"
                            title={t('connectAgent.devicePathTitle')}
                            body={t('connectAgent.devicePathBody')}
                            onPress={() => openMode('device')}
                        />

                        {/* A code host: GitHub, GitLab or Bitbucket — chosen on the next step. */}
                        <PathCard
                            icon="git-branch-outline"
                            title={t('connectAgent.codeHostPathTitle')}
                            body={t('connectAgent.codeHostPathBody')}
                            onPress={() => openMode('codeHost')}
                        />
                    </>
                )}

                {mode === 'codeHost' && (
                    <>
                        <Text style={[styles.intro, { color: themeColors.textSecondary }]}>
                            {t('connectAgent.codeHostIntro')}
                        </Text>
                        <PathCard
                            icon="logo-github"
                            title="GitHub"
                            body={t('connectAgent.codeHostGithubBody')}
                            onPress={() => navigation.navigate('ForgeConnect', { provider: 'github' })}
                        />
                        <PathCard
                            icon="git-merge-outline"
                            title="GitLab"
                            body={t('connectAgent.codeHostGitlabBody')}
                            onPress={() => navigation.navigate('ForgeConnect', { provider: 'gitlab' })}
                        />
                        <PathCard
                            icon="git-pull-request-outline"
                            title="Bitbucket"
                            body={t('connectAgent.codeHostBitbucketBody')}
                            onPress={() => navigation.navigate('ForgeConnect', { provider: 'bitbucket' })}
                        />
                    </>
                )}

                {mode === 'device' && (
                    <DevicePath
                        state={deviceState}
                        token={deviceToken}
                        isExpired={isExpired}
                        countdown={countdown}
                        copiedKey={copiedKey}
                        copy={copy}
                        regenerate={generateDeviceToken}
                        t={t}
                        themeColors={themeColors}
                    />
                )}

                {mode === 'agent' && (
                    <AgentPath
                        state={agentState}
                        token={agentToken}
                        isExpired={isExpired}
                        countdown={countdown}
                        copiedKey={copiedKey}
                        copy={copy}
                        regenerate={generateAgentToken}
                        errorMessage={agentErrorMsg}
                        existingAgentCount={existingAgentCount}
                        pendingRequest={pendingRequest}
                        onReviewRequest={(req) => navigation.navigate('LinkAccept', {
                            inviteId: req.invite_id,
                            agentWalletId: req.agent_wallet_id,
                        })}
                        onViewRequests={() => navigation.navigate('AgentHub')}
                        launch={launch}
                        t={t}
                        themeColors={themeColors}
                    />
                )}
            </ScrollView>
        </SafeAreaView>
    );
};

// ─── Path detail components ─────────────────────────────────────────────

interface PathCommonProps {
    copiedKey: string | null;
    copy: (value: string, key: string) => void;
    t: (key: string, opts?: Record<string, unknown>) => string;
    themeColors: { textPrimary: string; textSecondary: string };
}

interface TokenPathProps extends PathCommonProps {
    state: LoadState;
    token: TokenState | null;
    isExpired: boolean;
    countdown: string;
    regenerate: () => void;
    /** Mapped plain-English failure (requirement D). Never a raw code. */
    errorMessage?: string | null;
    /** Agent path: jump to the pending link-request list (AgentHub). */
    onViewRequests?: () => void;
    /** Agent path: the newest pending link request, polled while the screen is open. */
    pendingRequest?: AgentLinkRequest | null;
    /** Agent path: open LinkAccept for a pending request. */
    onReviewRequest?: (request: AgentLinkRequest) => void;
    /** Agent path: the launch switch (null until known) for the MCP / SDK / fleet forms. */
    launch?: LaunchState | null;
    /**
     * Agent path: how many agents the operator already has (linked + live
     * sessions). When > 0 the "waiting for your agent" spinner is replaced by an
     * "already connected → Manage" banner, so a returning operator isn't shown
     * perpetual first-time onboarding. Defaults to 0 (first-time behaviour).
     */
    existingAgentCount?: number;
}

// Capture disclosure (informed consent). The Desktop daemon's one-paste command
// (your own computer) enables AI-app session capture automatically (the daemon
// fail-closes to OFF without it), so
// the honest "what it reads / never reads" disclosure lives HERE, on the phone,
// before the command is ever shown — mirroring ChatCaptureConsentScreen's model.
const CaptureBullet = ({
    text, muted,
}: { text: string; muted?: boolean }): React.JSX.Element => (
    <View style={styles.discloseBulletRow}>
        <Text style={[styles.discloseDot, muted && styles.discloseDotMuted]}>•</Text>
        <Text style={[styles.discloseBulletText, muted && styles.discloseBulletMuted]}>{text}</Text>
    </View>
);

// The opt-out setting inside the translated Control sentence is code, not copy:
// render it as its own monospace block so it reads as something to type into
// ~/.provian/config.json (read by the SDK's llm-session-consent gate).
const CAPTURE_OPT_OUT_SETTING = '"capture": { "llm_session_enabled": false }';
const ControlLine = ({ text }: { text: string }): React.JSX.Element => {
    const at = text.indexOf(CAPTURE_OPT_OUT_SETTING);
    if (at < 0) return <Text style={styles.discloseFine}>{text}</Text>;
    // Keep the sentence's own trailing punctuation (':' / '：') as translated.
    const lead = text.slice(0, at).trimEnd();
    const tail = text.slice(at + CAPTURE_OPT_OUT_SETTING.length).trim();
    return (
        <>
            {lead ? <Text style={styles.discloseFine}>{lead}</Text> : null}
            <View style={styles.discloseCmd}>
                <Text style={styles.discloseCmdText} selectable>{CAPTURE_OPT_OUT_SETTING}</Text>
            </View>
            {tail ? <Text style={styles.discloseFine}>{tail}</Text> : null}
        </>
    );
};

// Disclosure for the one witness that runs the foreground AI-app observer: the
// Desktop daemon on the human's OWN computer. The agent path never shows it —
// agent installs never start that observer : on an agent's
// machine it either does nothing (headless) or records a human's or a
// computer-use agent's foreground screen time as the agent's work, which is the
// wrong author on the PE.
const CaptureDisclosure = ({
    t, themeColors,
}: Pick<PathCommonProps, 't' | 'themeColors'>): React.JSX.Element => {
    const k = (suffix: string): string => `connectAgent.deviceCapture${suffix}`;
    return (
        <View style={styles.discloseCard}>
            <View style={styles.discloseHeaderRow}>
                <Ionicons name="eye-outline" size={16} color="#8FB8F5" />
                <Text style={[styles.noteTitle, styles.discloseTitle, { color: themeColors.textPrimary }]}>
                    {t(k('Title'))}
                </Text>
            </View>
            <Text style={styles.discloseLabel}>{t(k('ReadsLabel'))}</Text>
            <CaptureBullet text={t(k('Read1'))} />
            <CaptureBullet text={t(k('Read2'))} />
            <Text style={styles.discloseLabel}>{t(k('NeverLabel'))}</Text>
            <CaptureBullet text={t(k('Never1'))} muted />
            <CaptureBullet text={t(k('Never2'))} muted />
            <Text style={styles.discloseFine}>{t(k('Permission'))}</Text>
            <ControlLine text={t(k('Control'))} />
        </View>
    );
};

// ─── Details : everything explanatory sits behind a tap ──────

/**
 * The one "Details" disclosure on a path, closed by default. Each child row expands on its own,
 * so what stays visible on the screen is the one thing the person must do.
 */
const DetailsSection = ({
    t, themeColors, children,
}: Pick<PathCommonProps, 't' | 'themeColors'> & { children: React.ReactNode }): React.JSX.Element => {
    const [open, setOpen] = useState(false);
    return (
        <View style={styles.detailsCard}>
            <TouchableOpacity
                style={styles.detailsHeader}
                onPress={() => setOpen((v) => !v)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
            >
                <Text style={[styles.detailsTitle, { color: themeColors.textPrimary }]}>{t('connectAgent.detailsTitle')}</Text>
                <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.textMuted} />
            </TouchableOpacity>
            {open ? <View style={styles.detailsBody}>{children}</View> : null}
        </View>
    );
};

/** One expandable row inside Details: its title line shows; its body renders only once tapped. */
const DetailsRow = ({
    title, themeColors, children,
}: Pick<PathCommonProps, 'themeColors'> & { title: string; children: React.ReactNode }): React.JSX.Element => {
    const [open, setOpen] = useState(false);
    return (
        <View style={styles.detailsRow}>
            <TouchableOpacity
                style={styles.detailsRowHeader}
                onPress={() => setOpen((v) => !v)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
            >
                <Text style={[styles.detailsRowTitle, { color: themeColors.textPrimary }]}>{title}</Text>
                <Ionicons name={open ? 'remove' : 'add'} size={18} color={COLORS.primary} />
            </TouchableOpacity>
            {open ? <View style={styles.detailsRowBody}>{children}</View> : null}
        </View>
    );
};

// What connecting sets up - its own wallet, the link to you, you as principal, its work as proof -
// one short line each, inside the agent path's Details.
const AgentSetupRows = ({
    t, themeColors,
}: Pick<PathCommonProps, 't' | 'themeColors'>): React.JSX.Element => {
    const rows: { icon: React.ComponentProps<typeof Ionicons>['name']; title: string; body: string }[] = [
        { icon: 'wallet-outline', title: t('connectAgent.agentSetupWalletTitle'), body: t('connectAgent.agentSetupWalletBody') },
        { icon: 'people-outline', title: t('connectAgent.agentSetupLinkTitle'), body: t('connectAgent.agentSetupLinkBody') },
        { icon: 'options-outline', title: t('connectAgent.agentSetupControlTitle'), body: t('connectAgent.agentSetupControlBody') },
        { icon: 'ribbon-outline', title: t('connectAgent.agentSetupProofTitle'), body: t('connectAgent.agentSetupProofBody') },
    ];
    return (
        <>
            {rows.map((r) => (
                <View key={r.title} style={styles.setupRow}>
                    <View style={styles.setupIconWrap}>
                        <Ionicons name={r.icon} size={18} color={COLORS.primary} />
                    </View>
                    <View style={styles.setupRowTextWrap}>
                        <Text style={[styles.setupRowTitle, { color: themeColors.textPrimary }]}>{r.title}</Text>
                        <Text style={styles.setupRowBody}>{r.body}</Text>
                    </View>
                </View>
            ))}
        </>
    );
};

// Your computer : visible are the capture disclosure, the one command and one
// line saying it is done. Everything else sits under Details.
const DevicePath = ({
    state, token, isExpired, countdown, copiedKey, copy, regenerate, t, themeColors,
}: TokenPathProps): React.JSX.Element => (
    <>
        <CaptureDisclosure t={t} themeColors={themeColors} />

        {state === 'loading' && <LoadingBlock label={t('connectAgent.generating')} />}
        {state === 'error' && <ErrorBlock t={t} retry={regenerate} themeColors={themeColors} />}

        {state === 'ready' && token && (
            !isExpired ? (
                <View style={styles.primaryCmdCard}>
                    <Text style={styles.primaryCmdLabel}>{t('connectAgent.deviceCommandLabel')}</Text>
                    <OSCommandBlock
                        unixCmd={BOOTSTRAP_DEVICE_CMD(RELAY_URL, token.token)}
                        windowsCmd={BOOTSTRAP_DEVICE_CMD_WINDOWS(RELAY_URL, token.token)}
                        copyId="register"
                        copiedKey={copiedKey}
                        copy={copy}
                        t={t}
                    />
                    <View style={styles.expiryRow}>
                        <Ionicons name="time-outline" size={13} color={COLORS.textMuted} />
                        <Text style={styles.expiryText}>
                            {t('connectAgent.expiresIn', { time: countdown })}
                        </Text>
                    </View>
                    <Text style={styles.leadLine}>{t('connectAgent.deviceDoneLine')}</Text>
                </View>
            ) : (
                <ExpiredBlock t={t} regenerate={regenerate} />
            )
        )}

        {/* Details: what gets witnessed (deduplicated against the disclosure above), the
            coding-tool tool-call exception, the agent-on-a-Mac-mini pointer, and one command
            per computer. Closed by default. */}
        <DetailsSection t={t} themeColors={themeColors}>
            <DetailsRow title={t('connectAgent.deviceWhatTitle')} themeColors={themeColors}>
                <Text style={styles.noteBody}>{t('connectAgent.deviceWhatBody')}</Text>
            </DetailsRow>
            <DetailsRow title={t('connectAgent.deviceToolCallsTitle')} themeColors={themeColors}>
                <Text style={styles.noteBody}>{t('connectAgent.deviceToolCallsBody')}</Text>
            </DetailsRow>
            <DetailsRow title={t('connectAgent.deviceAgentMachineTitle')} themeColors={themeColors}>
                <Text style={styles.noteBody}>{t('connectAgent.deviceAgentMachineBody')}</Text>
            </DetailsRow>
            <DetailsRow title={t('connectAgent.deviceEachTitle')} themeColors={themeColors}>
                <Text style={styles.noteBody}>{t('connectAgent.deviceEachBody')}</Text>
            </DetailsRow>
        </DetailsSection>
    </>
);

// An AI agent. Visible, top to bottom: the one command (OS toggle, copy,
// countdown) with one line under it; the connection code, always shown with copy, with one
// sentence; one line about hosted agents; then the waiting / request / already-connected card.
// Everything else sits under Details, closed by default.
const AgentPath = ({
    state, token, isExpired, countdown, copiedKey, copy, regenerate, errorMessage, onViewRequests, existingAgentCount = 0, pendingRequest = null, onReviewRequest, launch = null, t, themeColors,
}: TokenPathProps): React.JSX.Element => (
    <>
        {state === 'idle' && (
            <View style={styles.centerBlock}>
                <TouchableOpacity
                    style={[styles.requestCta, styles.getCommandCta]}
                    onPress={regenerate}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                >
                    <Ionicons name="terminal-outline" size={16} color={COLORS.text} />
                    <Text style={styles.requestCtaText}>{t('connectAgent.getCommandCta')}</Text>
                </TouchableOpacity>
                <Text style={[styles.muted, { marginTop: SPACING.s, textAlign: 'center' }]}>
                    {t('connectAgent.getCommandHint')}
                </Text>
            </View>
        )}
        {state === 'loading' && <LoadingBlock label={t('connectAgent.generating')} />}
        {state === 'error' && (
            <ErrorBlock t={t} retry={regenerate} themeColors={themeColors} message={errorMessage} />
        )}

        {state === 'ready' && token && isExpired && (
            <View style={styles.codeCard}>
                <Text style={styles.codeLabel}>{t('connectAgent.yourCode')}</Text>
                <ExpiredBlock t={t} regenerate={regenerate} />
            </View>
        )}

        {state === 'ready' && token && !isExpired && (
            <>
                {/* The one command, first. One line under it: send it to the agent or run it where
                    the agent lives; when it asks to link, tap Accept. */}
                <View style={styles.primaryCmdCard}>
                    <Text style={styles.primaryCmdLabel}>{t('connectAgent.oneCommandLabel')}</Text>
                    <OSCommandBlock
                        unixCmd={BOOTSTRAP_AGENT_CMD(token.relayUrl ?? RELAY_URL, token.token)}
                        windowsCmd={BOOTSTRAP_AGENT_CMD_WINDOWS(token.relayUrl ?? RELAY_URL, token.token)}
                        copyId="bootstrap"
                        copiedKey={copiedKey}
                        copy={copy}
                        t={t}
                    />
                    <View style={styles.expiryRow}>
                        <Ionicons name="time-outline" size={13} color={COLORS.textMuted} />
                        <Text style={styles.expiryText}>
                            {t('connectAgent.expiresIn', { time: countdown })}
                        </Text>
                    </View>
                    <Text style={styles.leadLine}>{t('connectAgent.agentSendLine')}</Text>
                </View>

                {/* The connection code, always shown with copy (it is the same one-time code that
                    is inside the command): for an agent that cannot run commands and connects
                    over MCP or the SDK instead. Independent of the launch switch. */}
                <View style={styles.codeCard}>
                    <Text style={styles.codeLabel}>{t('connectAgent.yourCode')}</Text>
                    <TouchableOpacity
                        style={styles.tokenRow}
                        onPress={() => copy(token.token, 'token')}
                        activeOpacity={0.7}
                    >
                        {/* the code never wraps (a lone trailing "K" on a narrow Android
                            phone) — one line, shrinking to fit. */}
                        <Text
                            style={styles.tokenText}
                            selectable
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.6}
                        >
                            {token.token}
                        </Text>
                        <Ionicons
                            name={copiedKey === 'token' ? 'checkmark-circle' : 'copy-outline'}
                            size={18}
                            color={copiedKey === 'token' ? (COLORS.success || '#4CC38A') : COLORS.primary}
                        />
                    </TouchableOpacity>
                    <Text style={styles.codeHint}>{t('connectAgent.agentCodeHint')}</Text>
                </View>

                <Text style={styles.hostedLine}>{t('connectAgent.agentHostedLine')}</Text>

                {/* What-happens-next. Three shapes for the same closing card:
                    - A pending request: "{name} is asking to link" with a one-tap Review.
                    - Returning operator (already has agents): an "already connected → Manage"
                      banner, no perpetual spinner. The command above still connects another.
                    - First-timer (no agents yet): the "waiting for your agent" spinner that
                      closes the loop after the command is copied. */}
                {pendingRequest && onReviewRequest ? (
                    <View style={[styles.waitingCard, styles.requestCard]}>
                        <View style={styles.recoveryNoteRow}>
                            <Ionicons name="link" size={18} color={COLORS.primary} />
                            <Text style={[styles.noteTitle, styles.rowTitle, { color: themeColors.textPrimary }]}>
                                {t('connectAgent.requestArrivedTitle', { name: pendingRequest.agent_name })}
                            </Text>
                        </View>
                        <Text style={styles.noteBody}>{t('connectAgent.requestArrivedBody')}</Text>
                        <TouchableOpacity
                            style={styles.requestCta}
                            onPress={() => onReviewRequest(pendingRequest)}
                            activeOpacity={0.8}
                            accessibilityRole="button"
                        >
                            <Text style={styles.requestCtaText}>{t('connectAgent.requestArrivedCta')}</Text>
                            <Ionicons name="arrow-forward" size={16} color={COLORS.text} />
                        </TouchableOpacity>
                    </View>
                ) : existingAgentCount > 0 ? (
                    <View style={styles.waitingCard}>
                        <View style={styles.recoveryNoteRow}>
                            <Ionicons name="checkmark-circle" size={18} color={COLORS.success || '#4CC38A'} />
                            <Text style={[styles.noteTitle, styles.rowTitle, { color: themeColors.textPrimary }]}>
                                {t('connectAgent.alreadyConnectedTitle', { count: existingAgentCount })}
                            </Text>
                        </View>
                        <Text style={styles.noteBody}>{t('connectAgent.alreadyConnectedBody')}</Text>
                        {onViewRequests && (
                            <TouchableOpacity
                                style={styles.waitingCta}
                                onPress={onViewRequests}
                                activeOpacity={0.7}
                            >
                                <Text style={styles.waitingCtaText}>{t('connectAgent.alreadyConnectedCta')}</Text>
                                <Ionicons name="arrow-forward" size={16} color={COLORS.primary} />
                            </TouchableOpacity>
                        )}
                    </View>
                ) : (
                    <View style={styles.waitingCard}>
                        <View style={styles.recoveryNoteRow}>
                            <ActivityIndicator size="small" color={COLORS.primary} />
                            <Text style={[styles.noteTitle, styles.rowTitle, { color: themeColors.textPrimary }]}>
                                {t('connectAgent.waitingTitle')}
                            </Text>
                        </View>
                        <Text style={styles.noteBody}>{t('connectAgent.waitingBody')}</Text>
                        {onViewRequests && (
                            <TouchableOpacity
                                style={styles.waitingCta}
                                onPress={onViewRequests}
                                activeOpacity={0.7}
                            >
                                <Text style={styles.waitingCtaText}>{t('connectAgent.waitingCta')}</Text>
                                <Ionicons name="arrow-forward" size={16} color={COLORS.primary} />
                            </TouchableOpacity>
                        )}
                    </View>
                )}
            </>
        )}

        {/* Details, closed by default: what connecting sets up; what earns; MCP and the SDK (the
            two lines the launch switch governs); bring your other agents; recovery. Shown in
            every state so a person can read them before minting a code; the recovery line
            needs the code's own answer, so it waits for one. */}
        <DetailsSection t={t} themeColors={themeColors}>
            <DetailsRow title={t('connectAgent.agentSetupTitle')} themeColors={themeColors}>
                <AgentSetupRows t={t} themeColors={themeColors} />
            </DetailsRow>
            <DetailsRow title={t('connectAgent.whatEarnsTitle')} themeColors={themeColors}>
                <WhatEarnsBody t={t} />
            </DetailsRow>
            <DetailsRow title={t('connectAgent.otherWaysTitle')} themeColors={themeColors}>
                <OtherWaysBody launch={launch} copiedKey={copiedKey} copy={copy} t={t} themeColors={themeColors} />
            </DetailsRow>
            <DetailsRow title={t('connectAgent.fleetTitle')} themeColors={themeColors}>
                <FleetBody copiedKey={copiedKey} copy={copy} t={t} />
            </DetailsRow>
            {token ? (
                <DetailsRow title={t('connectAgent.recoveryTitle')} themeColors={themeColors}>
                    <View style={styles.recoveryRow}>
                        <Ionicons
                            name={token.recoveryEnabled === false ? 'cloud-offline-outline' : 'shield-checkmark-outline'}
                            size={14}
                            color={token.recoveryEnabled === false ? COLORS.textMuted : (COLORS.success || '#4CC38A')}
                        />
                        <Text style={styles.recoveryNoteText}>
                            {token.recoveryEnabled === false
                                ? t('connectAgent.recoveryUnavailable')
                                : t('connectAgent.recoveryEnabled')}
                        </Text>
                    </View>
                </DetailsRow>
            ) : null}
        </DetailsSection>
    </>
);

// ─── Shared building blocks ─────────────────────────────────────────────

const PathCard = ({
    icon,
    title,
    body,
    hero,
    onPress,
}: {
    icon: keyof typeof Ionicons.glyphMap;
    title: string;
    body: string;
    hero?: boolean;
    onPress: () => void;
}): React.JSX.Element => (
    <TouchableOpacity
        style={[styles.pathCard, hero && styles.pathCardHero]}
        onPress={onPress}
        activeOpacity={0.8}
    >
        <View style={[styles.pathIconBg, hero && styles.pathIconBgHero]}>
            <Ionicons name={icon} size={24} color={hero ? '#FFFFFF' : COLORS.primary} />
        </View>
        <View style={styles.pathBody}>
            <Text style={[styles.pathTitle, styles.pathTitleSpacing]}>{title}</Text>
            <Text style={styles.pathText}>{body}</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={COLORS.textMuted} />
    </TouchableOpacity>
);

const CommandRow = ({
    cmd,
    copied,
    onCopy,
}: {
    cmd: string;
    copied: boolean;
    onCopy: () => void;
}): React.JSX.Element => (
    <TouchableOpacity style={styles.cmdRow} onPress={onCopy} activeOpacity={0.7}>
        <Text style={styles.cmdText} numberOfLines={1} ellipsizeMode="middle">{cmd}</Text>
        <Ionicons
            name={copied ? 'checkmark-circle' : 'copy-outline'}
            size={16}
            color={copied ? (COLORS.success || '#4CC38A') : COLORS.primary}
        />
    </TouchableOpacity>
);

// OS-aware command block: a macOS/Linux ↔ Windows toggle above the command, so
// a Windows user gets the PowerShell (irm | iex) line and everyone else the
// curl | sh line. One self-contained component (own OS state) reused by the
// device and agent paths.
const OSCommandBlock = ({
    unixCmd,
    windowsCmd,
    copyId,
    copiedKey,
    copy,
    t,
}: {
    unixCmd: string;
    windowsCmd: string;
    copyId: string;
    copiedKey: string | null;
    copy: (text: string, key: string) => void;
    t: PathCommonProps['t'];
}): React.JSX.Element => {
    const [os, setOs] = useState<'unix' | 'windows'>('unix');
    const cmd = os === 'windows' ? windowsCmd : unixCmd;
    return (
        <>
            <View style={styles.osRow}>
                <TouchableOpacity
                    style={[styles.osPill, os === 'unix' && styles.osPillActive]}
                    onPress={() => setOs('unix')}
                    activeOpacity={0.8}
                >
                    <Text style={[styles.osPillText, os === 'unix' && styles.osPillTextActive]}>
                        {t('connectAgent.osUnix')}
                    </Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.osPill, os === 'windows' && styles.osPillActive]}
                    onPress={() => setOs('windows')}
                    activeOpacity={0.8}
                >
                    <Text style={[styles.osPillText, os === 'windows' && styles.osPillTextActive]}>
                        {t('connectAgent.osWindows')}
                    </Text>
                </TouchableOpacity>
            </View>
            <CommandRow cmd={cmd} copied={copiedKey === copyId} onCopy={() => copy(cmd, copyId)} />
            {os === 'windows' && (
                <Text style={styles.osHint}>{t('connectAgent.windowsHint')}</Text>
            )}
        </>
    );
};

// What an agent's work mints from (2026-10-20; a Details row since 2026-10-22). Each program is
// witnessed by exactly one lane: its session files, else the model proxy, else OTel, else — for a
// program on its own machine with none of those — the process lane, which reads the commands it
// runs from the OS. Commits mint through a connected code host; Commons and on-chain acts
// are signed with the agent's own key. Capture health per device says which lanes are live. The
// two command blocks (help, keep the observer running) and the gas line stay in this row.
const WhatEarnsBody = ({ t }: Pick<PathCommonProps, 't'>): React.JSX.Element => (
    <>
        <Text style={styles.noteBody}>{t('connectAgent.whatEarnsIntro')}</Text>
        <CaptureBullet text={t('connectAgent.whatEarns1')} />
        <CaptureBullet text={t('connectAgent.whatEarns2')} />
        <CaptureBullet text={t('connectAgent.whatEarns3')} />
        <CaptureBullet text={t('connectAgent.whatEarns4')} />
        <CaptureBullet text={t('connectAgent.whatEarns5')} />
        <Text style={styles.discloseFine}>{t('connectAgent.whatEarnsHealth')}</Text>
        <Text style={styles.discloseFine}>{t('connectAgent.whatEarnsCommands')}</Text>
        <View style={styles.discloseCmd}>
            <Text style={styles.discloseCmdText} selectable>{HOSTED_BOT_HELP_CMD}</Text>
        </View>
        <Text style={styles.discloseFine}>{t('connectAgent.whatEarnsKeepRunning')}</Text>
        <View style={styles.discloseCmd}>
            <Text style={styles.discloseCmdText} selectable>{HOSTED_BOT_KEEP_RUNNING_CMD}</Text>
        </View>
        <Text style={styles.discloseFine}>{t('connectAgent.whatEarnsGas')}</Text>
    </>
);

// ─── MCP / SDK / fleet ─────────────────────────────

/** "Opens at launch": the form is built and described, and the launch switch opens it at the flip. */
const LaunchBadge = ({ t }: { t: PathCommonProps['t'] }): React.JSX.Element => (
    <View style={styles.launchBadge}>
        <Text style={styles.launchBadgeText}>{t('connectAgent.opensAtLaunch')}</Text>
    </View>
);

/** One labelled line: copyable when live; shown, muted and without copy, until the flip. */
const GatedLine = ({
    label, value, gate, copyId, copiedKey, copy, t,
}: {
    label: string;
    value: string;
    gate: LaunchGate;
    copyId: string;
    copiedKey: string | null;
    copy: (value: string, key: string) => void;
    t: PathCommonProps['t'];
}): React.JSX.Element => (
    <View style={styles.gatedLine}>
        <View style={styles.gatedLabelRow}>
            <Text style={styles.gatedLabel}>{label}</Text>
            {gate === 'opens_at_launch' ? <LaunchBadge t={t} /> : null}
        </View>
        {gate === 'live' ? (
            <CommandRow cmd={value} copied={copiedKey === copyId} onCopy={() => copy(value, copyId)} />
        ) : (
            <View style={[styles.cmdRow, styles.cmdRowMuted]}>
                <Text style={[styles.cmdText, styles.cmdTextMuted]} numberOfLines={1} ellipsizeMode="middle">{value}</Text>
            </View>
        )}
    </View>
);

/** The launch switch, read: null while unknown (a neutral placeholder, never a guessed state). */
const gatesOf = (launch: LaunchState | null): ConnectLaunchGates | null =>
    launch ? connectLaunchGates(launch.launched) : null;

/**
 * MCP and the SDK (a Details row): the agent connects with the code through either, then you tap
 * Accept. The MCP server URL and the npx onboard line are the two lines the launch switch governs:
 * "Opens at launch", not copyable, until the flip; live after it. The code itself is shown above,
 * on the screen, in every state.
 */
const OtherWaysBody = ({
    launch, copiedKey, copy, t, themeColors,
}: Pick<PathCommonProps, 'copiedKey' | 'copy' | 't' | 'themeColors'> & { launch: LaunchState | null }): React.JSX.Element => {
    const gates = gatesOf(launch);
    return (
        <>
            <Text style={styles.noteBody}>{t('connectAgent.otherWaysBody')}</Text>
            {gates === null ? (
                <ActivityIndicator size="small" color={COLORS.primary} style={{ marginTop: SPACING.m }} />
            ) : (
                <>
                    <Text style={[styles.optionTitle, { color: themeColors.textPrimary }]}>{t('connectAgent.mcpOptionTitle')}</Text>
                    <GatedLine
                        label={t('connectAgent.mcpServerLabel')}
                        value={launch?.mcpUrl ?? ''}
                        gate={gates.mcp}
                        copyId="mcp"
                        copiedKey={copiedKey}
                        copy={copy}
                        t={t}
                    />
                    <Text style={[styles.optionTitle, { color: themeColors.textPrimary }]}>{t('connectAgent.sdkOptionTitle')}</Text>
                    <GatedLine
                        label={t('connectAgent.sdkCommandLabel')}
                        value={NPX_SDK_ONBOARD_CMD}
                        gate={gates.sdk}
                        copyId="sdk"
                        copiedKey={copiedKey}
                        copy={copy}
                        t={t}
                    />
                </>
            )}
        </>
    );
};

/**
 * Bring your other agents (a Details row): one sentence, the installed agent script's fleet-code
 * command (live from the install on, so copyable), and the name of the MCP tool. The tool is a
 * name, not a line to paste, so it shows plain: no gate, no copy.
 */
const FleetBody = ({
    copiedKey, copy, t,
}: Pick<PathCommonProps, 'copiedKey' | 'copy' | 't'>): React.JSX.Element => (
    <>
        <Text style={styles.noteBody}>{t('connectAgent.fleetBody')}</Text>
        <View style={styles.gatedLine}>
            <Text style={styles.gatedLabel}>{t('connectAgent.fleetInstalledLabel')}</Text>
            <CommandRow
                cmd={AGENT_FLEET_CODE_CMD}
                copied={copiedKey === 'fleetInstalled'}
                onCopy={() => copy(AGENT_FLEET_CODE_CMD, 'fleetInstalled')}
            />
        </View>
        <View style={styles.gatedLine}>
            <Text style={styles.gatedLabel}>{t('connectAgent.fleetMcpLabel')}</Text>
            <View style={styles.cmdRow}>
                <Text style={styles.cmdText} selectable>{MCP_FLEET_CODE_TOOL}</Text>
            </View>
        </View>
    </>
);

const LoadingBlock = ({ label }: { label: string }): React.JSX.Element => (
    <View style={styles.centerBlock}>
        <ActivityIndicator size="small" color={COLORS.primary} />
        <Text style={[styles.muted, { marginTop: SPACING.m }]}>{label}</Text>
    </View>
);

const ErrorBlock = ({
    t,
    retry,
    themeColors,
    message,
}: {
    t: (key: string) => string;
    retry: () => void;
    themeColors: { textPrimary: string };
    /** Mapped plain-English sentence + next action (requirement D). Never a raw code. */
    message?: string | null;
}): React.JSX.Element => (
    <View style={styles.centerBlock}>
        <Ionicons name="cloud-offline-outline" size={40} color={COLORS.textMuted} />
        <Text style={[styles.errorTitle, { color: themeColors.textPrimary }]}>
            {t('connectAgent.errorTitle')}
        </Text>
        <Text style={[styles.muted, { textAlign: 'center' }]}>
            {message || t('connectAgent.errorBody')}
        </Text>
        <TouchableOpacity style={styles.secondaryBtn} onPress={retry}>
            <Ionicons name="refresh" size={16} color={COLORS.primary} />
            <Text style={styles.secondaryBtnText}>{t('connectAgent.retry')}</Text>
        </TouchableOpacity>
    </View>
);

const ExpiredBlock = ({
    t,
    regenerate,
}: {
    t: (key: string) => string;
    regenerate: () => void;
}): React.JSX.Element => (
    <View style={styles.centerBlock}>
        <Text style={[styles.muted, { textAlign: 'center', marginBottom: SPACING.m }]}>
            {t('connectAgent.expired')}
        </Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={regenerate}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnGradient}>
                <Ionicons name="refresh" size={16} color="#FFF" style={{ marginRight: 6 }} />
                <Text style={styles.primaryBtnText}>{t('connectAgent.regenerate')}</Text>
            </LinearGradient>
        </TouchableOpacity>
    </View>
);

const styles = StyleSheet.create({
    // MCP / SDK / fleet
    launchBadge: {
        backgroundColor: 'rgba(156,163,175,0.16)',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 8,
    },
    launchBadgeText: { fontSize: 10, fontWeight: '700', color: '#9CA3AF', letterSpacing: 0.5 },
    gatedLine: { marginTop: SPACING.s },
    gatedLabelRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACING.s, rowGap: 4 },
    gatedLabel: { flexShrink: 1, fontSize: 12, color: COLORS.textSecondary, lineHeight: 17 },
    cmdRowMuted: { opacity: 0.55 },
    cmdTextMuted: { color: '#8B929E' },
    optionTitle: { fontSize: 14, fontWeight: '700', marginTop: SPACING.m, marginBottom: 2 },
    container: { flex: 1, backgroundColor: COLORS.background },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.l,
        paddingTop: SPACING.s,
        paddingBottom: SPACING.s,
    },
    headerTitle: { fontSize: 18, fontWeight: '700', flex: 1, textAlign: 'center' },
    scrollContent: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.xxl },
    intro: { fontSize: 15, lineHeight: 22, marginBottom: SPACING.l },
    centerBlock: { alignItems: 'center', paddingVertical: SPACING.xl },
    muted: { color: COLORS.textMuted, fontSize: 13 },
    errorTitle: { fontSize: 16, fontWeight: '600', marginTop: SPACING.m, marginBottom: SPACING.xs },

    // Path chooser cards
    pathCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.m,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        marginBottom: SPACING.m,
    },
    pathCardHero: {
        borderColor: 'rgba(74,142,232,0.45)',
        backgroundColor: 'rgba(74,142,232,0.08)',
    },
    pathIconBg: {
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: 'rgba(74,142,232,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    pathIconBgHero: {
        backgroundColor: COLORS.primary,
    },
    // minWidth 0 lets the body shrink below its content width so a long title
    // wraps inside the card instead of pushing the chevron off it.
    pathBody: { flex: 1, minWidth: 0 },
    pathTitle: { flexShrink: 1, fontSize: 16, fontWeight: '700', color: COLORS.text },
    pathTitleSpacing: { marginBottom: 3 },
    pathText: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },

    // Token / code card
    codeCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        alignItems: 'center',
        marginBottom: SPACING.l,
    },
    codeLabel: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        letterSpacing: 2,
        textTransform: 'uppercase',
        marginBottom: SPACING.m,
    },
    tokenRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.m,
        backgroundColor: 'rgba(74,142,232,0.10)',
        borderRadius: 12,
    },
    tokenText: {
        flexShrink: 1,
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.primary,
        letterSpacing: 1,
        fontFamily: 'Courier',
    },
    expiryRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: SPACING.s },
    expiryText: { flexShrink: 1, fontSize: 12, color: COLORS.textMuted },

    // Primary "one command" card (the device and agent paths' hero)
    primaryCmdCard: {
        backgroundColor: 'rgba(74,142,232,0.08)',
        borderRadius: 20,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.45)',
        marginBottom: SPACING.l,
    },
    primaryCmdLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: '#6BA3F0',
        letterSpacing: 1.5,
        textTransform: 'uppercase',
        marginBottom: SPACING.m,
    },
    // The one line under the command (send it to your agent / that's it).
    leadLine: {
        fontSize: 14,
        color: COLORS.text,
        lineHeight: 21,
        marginTop: SPACING.m,
    },
    // The one line about hosted agents, between the code and the closing card.
    hostedLine: {
        fontSize: 13,
        color: COLORS.textSecondary,
        lineHeight: 19,
        marginBottom: SPACING.l,
        paddingHorizontal: SPACING.xs,
    },
    recoveryNoteRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: SPACING.m,
    },
    recoveryRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    recoveryNoteText: { flex: 1, fontSize: 12, color: COLORS.textSecondary, lineHeight: 17 },
    codeHint: {
        fontSize: 13,
        color: COLORS.textSecondary,
        lineHeight: 19,
        textAlign: 'center',
        marginTop: SPACING.m,
    },

    cmdRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: SPACING.s,
        backgroundColor: 'rgba(0,0,0,0.35)',
        borderRadius: 10,
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.06)',
    },
    cmdText: { flex: 1, fontSize: 13, color: '#C8D0DC', fontFamily: 'Courier' },
    osRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: SPACING.xs,
        marginBottom: SPACING.s,
    },
    osPill: {
        paddingVertical: 5,
        paddingHorizontal: SPACING.m,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.12)',
        backgroundColor: 'rgba(0,0,0,0.25)',
    },
    osPillActive: {
        borderColor: COLORS.primary,
        backgroundColor: 'rgba(107,163,240,0.14)',
    },
    osPillText: { fontSize: 12, color: COLORS.textMuted, fontWeight: '600' },
    osPillTextActive: { color: COLORS.primary },
    osHint: { fontSize: 12, color: COLORS.textMuted, marginTop: SPACING.xs },

    // Note text (closing cards and Details rows)
    noteTitle: { fontSize: 14, fontWeight: '600', marginBottom: SPACING.xs },
    // A noteTitle sitting beside an icon in a row: takes the remaining width and
    // wraps rather than running past the card edge.
    rowTitle: { flex: 1, marginLeft: SPACING.s },
    noteBody: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 20 },

    // "What connecting sets up" rows (inside Details).
    setupRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: SPACING.s },
    setupIconWrap: { width: 28, alignItems: 'center', marginRight: SPACING.s, marginTop: 2 },
    setupRowTextWrap: { flex: 1 },
    setupRowTitle: { fontSize: 14, fontWeight: '600', marginBottom: 2 },
    setupRowBody: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },

    // Details : one disclosure, closed by default, with expandable rows.
    detailsCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 16,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        marginBottom: SPACING.m,
        overflow: 'hidden',
    },
    detailsHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: SPACING.s,
        paddingVertical: SPACING.m,
        paddingHorizontal: SPACING.l,
    },
    detailsTitle: { flexShrink: 1, fontSize: 15, fontWeight: '600' },
    detailsBody: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.s },
    detailsRow: {
        borderTopWidth: 1,
        borderTopColor: 'rgba(200,205,214,0.08)',
    },
    detailsRowHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: SPACING.s,
        paddingVertical: SPACING.m,
    },
    detailsRowTitle: { flexShrink: 1, fontSize: 14, fontWeight: '600' },
    detailsRowBody: { paddingBottom: SPACING.m },

    // "Waiting for your agent" — closes the loop after the command is copied.
    waitingCard: {
        backgroundColor: 'rgba(107,163,240,0.06)',
        borderRadius: 16,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(107,163,240,0.18)',
        marginBottom: SPACING.m,
    },
    waitingCta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        marginTop: SPACING.m,
    },
    waitingCtaText: { flexShrink: 1, fontSize: 14, fontWeight: '600', color: COLORS.primary },
    requestCard: { borderColor: COLORS.primary },
    requestCta: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.xs,
        marginTop: SPACING.m,
        paddingVertical: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        backgroundColor: COLORS.primary,
    },
    requestCtaText: { fontSize: 15, fontWeight: '700', color: COLORS.text },
    getCommandCta: { alignSelf: 'stretch', paddingHorizontal: SPACING.l },

    // Capture disclosure (informed consent) — shown before the connect command.
    discloseCard: {
        backgroundColor: 'rgba(143,184,245,0.06)',
        borderRadius: 16,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(143,184,245,0.22)',
        marginBottom: SPACING.m,
    },
    discloseHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: SPACING.xs },
    discloseTitle: { marginBottom: 0, flex: 1 },
    discloseCmd: {
        marginTop: SPACING.xs,
        paddingVertical: SPACING.xs,
        paddingHorizontal: SPACING.s,
        borderRadius: 8,
        backgroundColor: 'rgba(0,0,0,0.35)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
    },
    discloseCmdText: { fontSize: 12, lineHeight: 18, color: '#C8D0DC', fontFamily: 'Courier' },
    discloseLabel: {
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: '#8FB8F5',
        marginTop: SPACING.s,
        marginBottom: SPACING.xs,
    },
    discloseBulletRow: { flexDirection: 'row', gap: 8, marginBottom: 4, paddingRight: SPACING.s },
    discloseDot: { fontSize: 13, lineHeight: 20, color: '#8FB8F5' },
    discloseDotMuted: { color: COLORS.textMuted },
    discloseBulletText: { flex: 1, fontSize: 13, lineHeight: 20, color: COLORS.textSecondary },
    discloseBulletMuted: { color: COLORS.textMuted },
    discloseFine: { fontSize: 12, lineHeight: 18, color: COLORS.textMuted, marginTop: SPACING.s },

    primaryBtn: { borderRadius: 24, overflow: 'hidden' },
    primaryBtnGradient: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        paddingHorizontal: SPACING.xl,
    },
    primaryBtnText: { flexShrink: 1, color: '#FFF', fontSize: 15, fontWeight: '600', textAlign: 'center' },
    secondaryBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: SPACING.l,
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.l,
    },
    secondaryBtnText: { flexShrink: 1, color: COLORS.primary, fontSize: 14, fontWeight: '600' },
});

export default ConnectAgentScreen;
