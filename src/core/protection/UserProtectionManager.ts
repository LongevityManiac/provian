import { translate } from '../../i18n/translate';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import AddressHistoryService from './AddressHistoryService';
import { KNOWN_SCAM_CONTRACTS, KNOWN_SCAM_DEPLOYERS } from '../../data/scam-contracts';
import { resolveRelayBaseUrl } from '../relay/DevHostDiscovery';
import { verifyTokenAddress, isVerifiableToken } from './TokenVerifier';

export interface TransactionWarning {
    id: string; // Unique identifier for tracking acknowledgment
    severity: 'critical' | 'high' | 'medium' | 'low';
    title: string;
    message: string;
    plainEnglish: string;
    consequences: string;
    recommendation: string;
    canProceed: boolean;
    requiresConfirmation: boolean;
}

export interface WarningCheckParams {
    action: 'send' | 'approve' | 'swap' | 'sign';
    amount?: number;
    amountUsd?: number;
    recipient?: string;
    contract?: string;
    assetSymbol?: string;
    networkId?: number;
    userBalance?: number; // Total balance in this asset
    userBalanceUsd?: number; // Total balance in USD
    approvalAmount?: string; // 'unlimited' or specific amount
}

// Thresholds for warnings
const LARGE_AMOUNT_USD = 500; // Warn for sends over $500
const LARGE_PERCENT_OF_BALANCE = 0.5; // Warn if sending >50% of balance

// AsyncStorage key for backend-synced scam list
const DYNAMIC_SCAM_LIST_KEY = '@provian_dynamic_scam_list';

interface DynamicScamListData {
    version: string;
    contracts: string[];
    deployers: string[];
    updated_at: string;
}

class UserProtectionManager {
    private static instance: UserProtectionManager;
    private dynamicScamContracts: Set<string> | null = null;

    private constructor() { }

    static getInstance(): UserProtectionManager {
        if (!UserProtectionManager.instance) {
            UserProtectionManager.instance = new UserProtectionManager();
        }
        return UserProtectionManager.instance;
    }

    /**
     * Check for common scam patterns and generate warnings
     */
    async checkForWarnings(params: WarningCheckParams): Promise<TransactionWarning[]> {
        const warnings: TransactionWarning[] = [];

        // 1. UNLIMITED TOKEN APPROVAL WARNING
        if (params.action === 'approve' && params.approvalAmount === 'unlimited') {
            warnings.push({
                id: 'unlimited_approval',
                severity: 'critical',
                title: translate('userProtection.unlimited_approval.title', 'Unlimited Access Request'),
                message: translate('userProtection.unlimited_approval.message', 'This app wants unlimited access to your tokens'),
                plainEnglish: translate('userProtection.unlimited_approval.plainEnglish', `You're about to give this app permission to spend ALL of your ${params.assetSymbol} - not just what you need right now. This permission lasts forever until you manually revoke it.`, { assetSymbol: params.assetSymbol }),
                consequences: translate('userProtection.unlimited_approval.consequences', `What this means:
• The app can take ANY amount of your ${params.assetSymbol}
• At ANY time, even after you close the app
• Without asking you again
• Until you manually revoke the permission`, { assetSymbol: params.assetSymbol }),
                recommendation: translate('userProtection.unlimited_approval.recommendation', `Safer option: Only approve the exact amount you need (${params.amount} ${params.assetSymbol}).

Never approve unlimited access unless you completely trust the app and understand why it needs this level of access.`, { amount: params.amount, assetSymbol: params.assetSymbol }),
                canProceed: true,
                requiresConfirmation: true
            });
        }

        // 2. FIRST-TIME SEND WARNING
        if (params.action === 'send' && params.recipient) {
            const isFirstTime = await AddressHistoryService.isFirstTimeSend(params.recipient);
            const isLargeAmount = (params.amountUsd || 0) >= LARGE_AMOUNT_USD;

            if (isFirstTime && isLargeAmount) {
                // First time + large amount = HIGH severity
                warnings.push({
                    id: 'first_time_large_send',
                    severity: 'high',
                    title: translate('userProtection.first_time_large_send.title', 'Large Amount to New Address'),
                    message: translate('userProtection.first_time_large_send.message', `You're sending $${params.amountUsd?.toFixed(2)} to an address you've never used before`, { amountUsd: params.amountUsd?.toFixed(2) }),
                    plainEnglish: translate('userProtection.first_time_large_send.plainEnglish', `This is your first time sending to this address, and you're sending a significant amount ($${params.amountUsd?.toFixed(2)} in ${params.assetSymbol}).`, { amountUsd: params.amountUsd?.toFixed(2), assetSymbol: params.assetSymbol }),
                    consequences: translate('userProtection.first_time_large_send.consequences', `If the address is wrong:
• Your funds will be permanently lost
• There is no way to reverse this transaction
• No one - not even Provian - can recover them
• Blockchain transactions are irreversible`),
                    recommendation: translate('userProtection.first_time_large_send.recommendation', `Send a test amount first (like $1) to make sure the address is correct. Once confirmed, send the rest.

This is how experienced crypto users protect themselves from costly typos.`),
                    canProceed: true,
                    requiresConfirmation: true
                });
            } else if (isFirstTime) {
                // First time but small amount = MEDIUM severity (informational)
                warnings.push({
                    id: 'first_time_send',
                    severity: 'medium',
                    title: translate('userProtection.first_time_send.title', 'New Address'),
                    message: translate('userProtection.first_time_send.message', `You've never sent to this address before`),
                    plainEnglish: translate('userProtection.first_time_send.plainEnglish', `This is your first time sending to this address. Double-check that it's correct - blockchain transactions can't be reversed.`),
                    consequences: translate('userProtection.first_time_send.consequences', `If the address is wrong, your ${params.assetSymbol} will be lost permanently.`, { assetSymbol: params.assetSymbol }),
                    recommendation: translate('userProtection.first_time_send.recommendation', `Verify the address is correct before sending. If possible, confirm with the recipient that you have the right address.`),
                    canProceed: true,
                    requiresConfirmation: false
                });
            }
        }

        // 3. LARGE PERCENTAGE OF BALANCE WARNING
        if (params.action === 'send' && params.userBalance && params.amount) {
            const percentOfBalance = params.amount / params.userBalance;

            if (percentOfBalance >= LARGE_PERCENT_OF_BALANCE) {
                const percentDisplay = Math.round(percentOfBalance * 100);
                warnings.push({
                    id: 'large_balance_percent',
                    severity: percentOfBalance >= 0.9 ? 'high' : 'medium',
                    title: translate('userProtection.large_balance_percent.title', `Sending ${percentDisplay}% of Your ${params.assetSymbol}`, { percent: percentDisplay, assetSymbol: params.assetSymbol }),
                    message: translate('userProtection.large_balance_percent.message', `This transaction will send most of your ${params.assetSymbol} balance`, { assetSymbol: params.assetSymbol }),
                    plainEnglish: translate('userProtection.large_balance_percent.plainEnglish', `You're about to send ${percentDisplay}% of your ${params.assetSymbol}. After this transaction, you'll have very little ${params.assetSymbol} left.`, { percent: percentDisplay, assetSymbol: params.assetSymbol }),
                    consequences: translate('userProtection.large_balance_percent.consequences', `After this transaction:
• You'll have only ${(params.userBalance - params.amount).toFixed(4)} ${params.assetSymbol} remaining
• You may not have enough for future transactions
• If ${params.assetSymbol} is needed for gas fees, you might get stuck`, { remaining: (params.userBalance - params.amount).toFixed(4), assetSymbol: params.assetSymbol }),
                    recommendation: translate('userProtection.large_balance_percent.recommendation', `Make sure you intended to send this much. Consider keeping some ${params.assetSymbol} for future transactions or gas fees.`, { assetSymbol: params.assetSymbol }),
                    canProceed: true,
                    requiresConfirmation: percentOfBalance >= 0.9
                });
            }
        }

        // 4. WRONG NETWORK WARNING
        if (params.action === 'send' && params.recipient && params.networkId !== undefined) {
            const networkMismatch = this.detectNetworkMismatch(params.recipient, params.networkId);
            if (networkMismatch) {
                warnings.push({
                    id: 'wrong_network',
                    severity: 'critical',
                    title: translate('userProtection.wrong_network.title', 'Possible Wrong Network'),
                    message: translate('userProtection.wrong_network.message', 'This address format may not match your current network'),
                    plainEnglish: translate('userProtection.wrong_network.plainEnglish', `You're on ${this.getNetworkName(params.networkId)} but this address looks like it might be for ${networkMismatch}.`, { network: this.getNetworkName(params.networkId), targetNetwork: networkMismatch }),
                    consequences: translate('userProtection.wrong_network.consequences', `If you send to the wrong network:
• Your funds will be permanently lost
• They won't arrive at the destination
• This is one of the most common ways people lose crypto`),
                    recommendation: translate('userProtection.wrong_network.recommendation', `Double-check:
1. Are you on the right network?
2. Did you copy the correct address?
3. Ask the recipient to confirm the network`),
                    canProceed: false,
                    requiresConfirmation: false
                });
            }
        }

        // 5. SUSPICIOUS CONTRACT WARNING (basic check)
        if (params.action === 'approve' && params.contract) {
            const isSuspicious = await this.isSuspiciousContract(params.contract);
            if (isSuspicious) {
                warnings.push({
                    id: 'suspicious_contract',
                    severity: 'critical',
                    title: translate('userProtection.suspicious_contract.title', 'Suspicious Contract Detected'),
                    message: translate('userProtection.suspicious_contract.message', 'This contract shows warning signs'),
                    plainEnglish: translate('userProtection.suspicious_contract.plainEnglish', `This contract has characteristics commonly associated with scam "drainer" contracts that steal tokens.`),
                    consequences: translate('userProtection.suspicious_contract.consequences', `Red flags detected:
• Contract matches known scam patterns
• Unusual permission requests
• If you approve this, your tokens could be stolen`),
                    recommendation: translate('userProtection.suspicious_contract.recommendation', `Do not proceed. Close this site and report it if you believe it's a scam.

If you're certain this is legitimate, verify through official channels (not links in messages).`),
                    canProceed: false,
                    requiresConfirmation: false
                });
            }
        }

        // 6. BLIND SIGNING WARNING
        if (params.action === 'sign') {
            warnings.push({
                id: 'blind_sign',
                severity: 'high',
                title: translate('userProtection.blind_sign.title', 'Signature Request'),
                message: translate('userProtection.blind_sign.message', 'A website is asking you to sign a message'),
                plainEnglish: translate('userProtection.blind_sign.plainEnglish', `You're being asked to sign something. Signatures can authorize actions like transferring NFTs or approving token spending.`),
                consequences: translate('userProtection.blind_sign.consequences', `Blind signatures can be used to:
• Transfer your NFTs without another prompt
• Approve token spending
• Grant permissions you didn't intend`),
                recommendation: translate('userProtection.blind_sign.recommendation', `Only sign if:
• You initiated this action
• You trust this website
• You understand what you're signing

If unsure, don't sign.`),
                canProceed: true,
                requiresConfirmation: true
            });
        }

        // 7. TOKEN IMPERSONATION WARNING
        if (params.assetSymbol && params.contract && params.networkId && isVerifiableToken(params.assetSymbol)) {
            const verification = verifyTokenAddress(params.assetSymbol, params.contract, params.networkId);
            if (!verification.isCanonical && verification.expectedAddress) {
                warnings.push({
                    id: 'fake_token',
                    severity: 'critical',
                    title: translate('userProtection.fake_token.title', 'Fake Token Detected'),
                    message: translate('userProtection.fake_token.message', `This token claims to be ${params.assetSymbol} but is not from the official contract address`, { assetSymbol: params.assetSymbol }),
                    plainEnglish: translate('userProtection.fake_token.plainEnglish', `This token says it's ${params.assetSymbol}, but it's coming from a different contract address than the real ${params.assetSymbol}. This is a common scam where attackers airdrop fake tokens to trick you into interacting with a malicious contract.`, { assetSymbol: params.assetSymbol }),
                    consequences: translate('userProtection.fake_token.consequences', `If you interact with this token:
• It has no real value - it is not genuine ${params.assetSymbol}
• Approving or transferring it could expose your wallet to a drainer contract
• The real ${params.assetSymbol} contract on this chain is ${verification.expectedAddress}`, { assetSymbol: params.assetSymbol, expectedAddress: verification.expectedAddress }),
                    recommendation: translate('userProtection.fake_token.recommendation', `Do not interact with this token. Ignore it in your balance. Real ${params.assetSymbol} will always come from the canonical contract address.`, { assetSymbol: params.assetSymbol }),
                    canProceed: false,
                    requiresConfirmation: false,
                });
            }
        }

        return warnings;
    }

    /**
     * Get the most severe warning from a list
     */
    getMostSevereWarning(warnings: TransactionWarning[]): TransactionWarning | null {
        if (warnings.length === 0) return null;

        const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return warnings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])[0];
    }

    /**
     * Check if any warnings block the transaction entirely
     */
    hasBlockingWarnings(warnings: TransactionWarning[]): boolean {
        return warnings.some(w => !w.canProceed);
    }

    /**
     * Get warnings that require explicit confirmation
     */
    getConfirmationWarnings(warnings: TransactionWarning[]): TransactionWarning[] {
        return warnings.filter(w => w.canProceed && w.requiresConfirmation);
    }

    // Helper methods
    private detectNetworkMismatch(address: string, networkId: number): string | null {
        // Basic heuristics - in production, use proper address validation
        if (address.startsWith('0x') && address.length === 42) {
            // EVM address - check if we're on an EVM network
            const evmNetworks = [1, 137, 56, 8453, 42161, 10]; // ETH, Polygon, BSC, Base, Arbitrum, Optimism
            if (!evmNetworks.includes(networkId)) {
                return translate('userProtection.evmNetwork', 'an EVM network (Ethereum, Polygon, etc.)');
            }
        }

        return null;
    }

    private getNetworkName(networkId: number): string {
        const names: Record<number, string> = {
            1: 'Ethereum',
            137: 'Polygon',
            56: 'BNB Chain',
            8453: 'Base',
            42161: 'Arbitrum',
            10: 'Optimism'
        };
        return names[networkId] || translate('userProtection.network', `Network ${networkId}`, { id: networkId });
    }

    private async isSuspiciousContract(contractAddress: string): Promise<boolean> {
        const lower = contractAddress.toLowerCase();

        // 1. Check static blocklist (instant, no network dependency)
        if (KNOWN_SCAM_CONTRACTS.has(lower)) return true;

        // 2. Check known deployer addresses
        if (KNOWN_SCAM_DEPLOYERS.has(lower)) return true;

        // 3. Check dynamic list from backend (cached in memory + AsyncStorage)
        const dynamicList = await this.getDynamicScamList();
        if (dynamicList.has(lower)) return true;

        return false;
    }

    /**
     * Get the dynamically-fetched scam list, loading from AsyncStorage if needed.
     * Returns an empty Set if no dynamic list is cached yet.
     */
    private async getDynamicScamList(): Promise<ReadonlySet<string>> {
        if (this.dynamicScamContracts) return this.dynamicScamContracts;

        try {
            const cached = await AsyncStorage.getItem(DYNAMIC_SCAM_LIST_KEY);
            if (cached) {
                const parsed: DynamicScamListData = JSON.parse(cached);
                this.dynamicScamContracts = new Set([
                    ...(parsed.contracts || []),
                    ...(parsed.deployers || []),
                ]);
                return this.dynamicScamContracts;
            }
        } catch {
            // Corrupt cache - fall through to empty set
        }

        return new Set();
    }

    /**
     * Fetch the latest scam contract list from the backend and cache locally.
     * Call periodically (e.g., on app foreground or daily) to keep the
     * dynamic blocklist fresh. Silent failure - the static list always works.
     */
    async refreshScamList(): Promise<void> {
        try {
            const baseUrl = resolveRelayBaseUrl();
            const response = await fetch(`${baseUrl}/v1/security/scam-contracts`);
            if (response.ok) {
                const data: DynamicScamListData = await response.json();
                await AsyncStorage.setItem(DYNAMIC_SCAM_LIST_KEY, JSON.stringify(data));
                this.dynamicScamContracts = new Set([
                    ...(data.contracts || []),
                    ...(data.deployers || []),
                ]);
            }
        } catch {
            // Silent fail - static blocklist still provides protection
        }
    }
}

export default UserProtectionManager.getInstance();
