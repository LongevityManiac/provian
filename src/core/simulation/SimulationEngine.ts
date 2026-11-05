export interface SimulationInput {
    from: string;
    to: string;
    data: string;
    value: string;
    chainId: number;
}

export interface SimulationResult {
    success: boolean;
    stateChanges: {
        asset: string;
        delta: string;
        address: string;
        tokenAddress?: string;
    }[];
    approvalChanges: {
        token: string;
        spender: string;
        amount: string;
        isUnlimited: boolean;
    }[];
    gasEstimate: string;
    error?: string;
    riskFactors: string[];
    simulationId: string;
}

class SimulationEngine {
    private static instance: SimulationEngine;

    private constructor() { }

    static getInstance(): SimulationEngine {
        if (!SimulationEngine.instance) {
            SimulationEngine.instance = new SimulationEngine();
        }
        return SimulationEngine.instance;
    }

    /**
     * Simulate a transaction (Internal Stub)
     */
    async simulateTransaction(tx: SimulationInput): Promise<SimulationResult> {
        // MOCK LOGIC: Parse data to guess intent

        const isTransfer = tx.data.startsWith('0xa9059cbb'); // transfer(address,uint256)
        const isApprove = tx.data.startsWith('0x095ea7b3'); // approve(address,uint256)
        const isPermit = tx.data.startsWith('0xd505accf'); // permit(...)

        const simulationId = `sim_${Date.now()}`;

        if (isTransfer) {
            return {
                success: true,
                stateChanges: [{
                    asset: 'Unknown Token', // Would resolve from 'to' address
                    delta: '-100.0', // Would parse from data
                    address: tx.from,
                    tokenAddress: tx.to
                }],
                approvalChanges: [],
                gasEstimate: '45000',
                riskFactors: [],
                simulationId
            };
        }

        if (isApprove) {
            return {
                success: true,
                stateChanges: [],
                approvalChanges: [{
                    token: tx.to,
                    spender: '0x...', // Would parse from data
                    amount: 'Unlimited', // Would parse from data
                    isUnlimited: true
                }],
                gasEstimate: '45000',
                riskFactors: ['Unlimited Approval'],
                simulationId
            };
        }

        if (isPermit) {
            return {
                success: true,
                stateChanges: [],
                approvalChanges: [{
                    token: tx.to,
                    spender: '0x...',
                    amount: 'Unlimited',
                    isUnlimited: true
                }],
                gasEstimate: '50000',
                riskFactors: ['Off-chain Permit Signature', 'Unlimited Approval'],
                simulationId
            };
        }

        // Default: Native Transfer
        return {
            success: true,
            stateChanges: [{
                asset: 'ETH',
                delta: `-${tx.value}`,
                address: tx.from
            }],
            approvalChanges: [],
            gasEstimate: '21000',
            riskFactors: [],
            simulationId
        };
    }
}

export default SimulationEngine.getInstance();
