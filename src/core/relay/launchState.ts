/**
 * The launch switch, as the app reads it.
 *
 * Everything live at launch is built now and switches on at the flip with no post-launch edit. The
 * Connect screen's MCP and SDK options, the npx / CLI / MCP fleet commands and the Devices note need
 * the published @provian packages and the open `/mcp` surface. They read ONE answer from the relay,
 * `GET /v1/wallet/launch-state` → `{ launched, mcp_url }`, which is the relay's `PUBLIC_LAUNCH` the
 * same value that opens `/mcp` and turns the wallet-create welcome's MCP pointer from
 * `opens_at_launch` into a plain URL. Nothing here hard-codes either state.
 *
 * Unknown is closed: only a strict boolean `true` reads as launched. A failed read keeps the last
 * answer this app saw (AsyncStorage, non-sensitive), and with none it stays unknown (null), so the
 * screen shows a neutral placeholder rather than flashing one state and then the other.
 */

import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RelayAPIService from '../../services/RelayAPIService';

export interface LaunchState {
    launched: boolean;
    mcpUrl: string;
}

const CACHE_KEY = '@provian_launch_state_v1';
const DEFAULT_MCP_URL = 'https://api.provian.ai/mcp';

/** Strict parse of the relay's answer: `launched` must be a real boolean; anything else is no answer. */
export function parseLaunchState(body: unknown): LaunchState | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as { launched?: unknown; mcp_url?: unknown };
    if (typeof b.launched !== 'boolean') return null;
    const mcpUrl = typeof b.mcp_url === 'string' && /^https:\/\/[^\s]+$/.test(b.mcp_url) ? b.mcp_url : DEFAULT_MCP_URL;
    return { launched: b.launched, mcpUrl };
}

/** What each launch-dependent surface shows: usable now, or described with "Opens at launch". */
export type LaunchGate = 'live' | 'opens_at_launch';

export interface ConnectLaunchGates {
    /** The agent adds Provian's MCP server (`/mcp`,). */
    mcp: LaunchGate;
    /** `npx @provian/agent-sdk onboard` (the published SDK). */
    sdk: LaunchGate;
    /** `"$HOME/.provian/bin/provian" fleet-code` — the installed agent script, live today. */
    fleetInstalled: LaunchGate;
    /** `npx @provian/agent-sdk fleet-code`. */
    fleetNpx: LaunchGate;
    /** `npx @provian/cli fleet-code`. */
    fleetCli: LaunchGate;
    /** MCP tool `issue_fleet_code`. */
    fleetMcp: LaunchGate;
}

/** The ONE mapping from the launch switch to the Connect screen's options. */
export function connectLaunchGates(launched: boolean): ConnectLaunchGates {
    const atLaunch: LaunchGate = launched ? 'live' : 'opens_at_launch';
    return {
        mcp: atLaunch,
        sdk: atLaunch,
        fleetInstalled: 'live',
        fleetNpx: atLaunch,
        fleetCli: atLaunch,
        fleetMcp: atLaunch,
    };
}

/** The Devices screen's note about the npm packages, by the same switch. */
export function devicesRegisterNoteKey(launched: boolean): 'devices.registerNoteLaunched' | 'devices.registerNotePreLaunch' {
    return launched ? 'devices.registerNoteLaunched' : 'devices.registerNotePreLaunch';
}

let memo: LaunchState | null = null;

async function readCache(): Promise<LaunchState | null> {
    try {
        const raw = await AsyncStorage.getItem(CACHE_KEY);
        return raw ? parseLaunchState(JSON.parse(raw) as unknown) : null;
    } catch {
        return null;
    }
}

/** Read the switch from the relay; on failure, the last answer this app saw (or null). */
export async function loadLaunchState(
    fetchState: () => Promise<unknown | null> = () => RelayAPIService.getLaunchState(),
): Promise<LaunchState | null> {
    const fresh = parseLaunchState(await fetchState().catch(() => null));
    if (fresh) {
        memo = fresh;
        AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ launched: fresh.launched, mcp_url: fresh.mcpUrl })).catch(() => {});
        return fresh;
    }
    return memo ?? (await readCache());
}

/** The launch switch for a screen: null until known, then the relay's answer. */
export function useLaunchState(): LaunchState | null {
    const [state, setState] = useState<LaunchState | null>(memo);
    useEffect(() => {
        let cancelled = false;
        void loadLaunchState().then((s) => {
            if (!cancelled && s) setState(s);
        });
        return () => {
            cancelled = true;
        };
    }, []);
    return state;
}
